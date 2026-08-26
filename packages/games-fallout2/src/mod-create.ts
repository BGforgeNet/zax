/**
 * Installing a base mod that creates its install rather than transforming one. Fallout et tu is the case: a
 * whole second game inside a Fallout 2 folder, at `<Fallout 2>/Fallout1in2/`, reading the host's `master.dat`
 * from one directory up.
 *
 * There is no installer to delegate to and none is needed - the install is additive, so nothing is overlaid
 * or moved aside - which is why ZAX performs this one. What it owes in exchange is the confinement the
 * delegated route cannot offer: every entry of the payload is checked against the directory the manifest says
 * it creates, before a byte is written, and the host install is not touched at all.
 *
 * The archive the mod unpacks belongs to the user, not to the release: it is their own copy of Fallout 1,
 * and the folder it sits in is what ZAX asks for.
 */

import { backupDirectory, fnv1a, stamp, type GameType, type Install, type MergeConflict } from "@zax/core";
import type { ArchiveEntryInfo, Platform } from "@zax/platform";
import { CONFIG_FILES } from "./files.js";
import { preflightArchive } from "./archive-preflight.js";
import { datReadError, extractFromDat, type ReadyDatTool } from "./dat-tool.js";
import type { ModCreates, ModInput, ModManifest } from "./manifest.js";
import { fetchAsset, type ModProgress } from "./mod-asset.js";
import type { ModRelease, ReleaseAsset } from "./mod-feed.js";
import { refusalFor } from "./mod-install.js";
import { holdUserFiles, mergeUserFiles } from "./mod-state.js";
import { modWorkDirectory } from "./mod-transaction.js";
import { assertUsable, loadRecord, saveRecord, type InstallRecord, type InstalledMod } from "./records.js";

/**
 * What creating an install would do. Thicker than a delegated base mod's plan, because ZAX performs this one
 * and therefore knows - but still not a file list: 10,985 payload entries and 8,602 extracted ones are not
 * something anybody reads before pressing a button.
 */
export interface CreateInstallPlan {
  kind: "creates";
  version: string;
  /** The directory it makes, relative to the host install. */
  directory: string;
  asset: string;
  download: number;
  /** What the payload unpacks to, read from its own directory. */
  unpacked: number;
  /** Free bytes on the host's filesystem, where the host could say. */
  free?: number;
  /** The folders the user pointed at, by input id. */
  inputs: Readonly<Record<string, string>>;
  /** How many paths are lifted out of the user's own archive, counted from the list the payload ships. */
  extracts?: number;
  /** The game type the created install reports. The host's own type does not change. */
  becomes: GameType;
  fingerprint: string;
}

export interface CreateInstallOutcome {
  version: string;
  /** The install this made, which the caller registers - identified by reading it, not by the claim here. */
  created: string;
  /** How many paths were lifted out of the user's archive. */
  extracted: number;
  /** Paths the list named that the user's archive does not hold, which the extraction went without. */
  skipped: readonly string[];
  /** Settings both the user and the release changed; the user's won. Empty on a first install. */
  conflicts: readonly MergeConflict[];
}

interface CreatingRelease {
  manifest: ModManifest;
  creates: ModCreates;
  becomes: GameType;
  archive: ReleaseAsset;
}

function creatingRelease(release: ModRelease): CreatingRelease {
  const { manifest } = release;
  if (manifest.type !== "base" || !manifest.creates || manifest.becomes === undefined)
    throw new Error(`${manifest.name} does not create an install.`);
  if (!release.archive) throw new Error(`The ${manifest.name} release does not say which of its files is the payload.`);
  return { manifest, creates: manifest.creates, becomes: manifest.becomes, archive: release.archive };
}

const insidePath = (platform: Platform, root: string, relative: string): string =>
  platform.paths.join(root, ...relative.split("/"));

/** A name inside a directory as that directory really spells it, or null - the user's folder is theirs. */
async function namedIn(platform: Platform, directory: string, name: string): Promise<string | null> {
  const entries = await platform.fs.list(directory).catch(() => null);
  const found = entries?.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
  return found ? platform.paths.join(directory, found.name) : null;
}

/**
 * The archive each declared input points at, checked as far as looking can check it: a folder that is there
 * and holds the file the manifest names. Whether it is the right archive is the list gate's question, and
 * that one needs the payload.
 */
async function archivesFor(
  platform: Platform,
  manifest: ModManifest,
  answers: Readonly<Record<string, string>>,
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const input of manifest.inputs ?? []) {
    const answer = (answers[input.id] ?? "").trim();
    if (answer === "") throw new Error(`${manifest.name} needs ${input.label} before it can be installed.`);
    const at = await namedIn(platform, answer, input.holds);
    if (at === null)
      throw new Error(`${answer} does not hold ${input.holds}, so it is not ${input.label.toLowerCase()}.`);
    found.set(input.id, at);
  }
  return found;
}

/** The archive `extract-dat` reads, resolved through the input it names. */
function sourceArchive(manifest: ModManifest, archives: ReadonlyMap<string, string>): string | null {
  const from = manifest.extractDat?.from;
  return from === undefined ? null : (archives.get(from) ?? null);
}

/** Where the payload's own copy of the extraction list is put, out of the archive rather than off the disk. */
const listDirectory = (work: string, platform: Platform): string => platform.paths.join(work, "list");

/**
 * The list the payload ships, extracted on its own. It is read before the payload lands - the gate that
 * decides whether the user pointed at the right archive runs against it, and running that before an 800 MB
 * unpack is the difference between a refusal and a mess.
 */
async function fetchList(
  platform: Platform,
  work: string,
  archivePath: string,
  manifest: ModManifest,
  creates: ModCreates,
): Promise<{ path: string; entries: number } | null> {
  const declared = manifest.extractDat?.list;
  if (declared === undefined) return null;
  const inside = `${creates.directory}/${declared}`;
  const at = listDirectory(work, platform);
  await platform.archive.extract(archivePath, at, { only: [inside] });
  const path = insidePath(platform, at, inside);
  if ((await platform.fs.stat(path))?.kind !== "file")
    throw new Error(`The payload does not carry "${declared}", which the ${manifest.name} manifest declares.`);
  const text = new TextDecoder().decode(await platform.fs.read(path));
  return { path, entries: text.split("\n").filter((line) => line.trim() !== "").length };
}

/** Whether an archive entry sits inside the directory this mod creates, compared as the filesystem compares. */
const insideCreated = (name: string, directory: string): boolean =>
  name.toLowerCase() === directory.toLowerCase() || name.toLowerCase().startsWith(`${directory.toLowerCase()}/`);

/**
 * The payload's directory, refused unless every entry of it sits inside what the manifest says this mod
 * creates. The confinement this shape promises, and the reason it is checked on both sides: the plan's answer
 * is what the user agreed to, and this one runs where the writing happens.
 */
async function confinedEntries(
  platform: Platform,
  archivePath: string,
  archive: ReleaseAsset,
  manifest: ModManifest,
  creates: ModCreates,
): Promise<readonly ArchiveEntryInfo[]> {
  const entries = await preflightArchive(platform, archivePath, archive.name);
  const outside = entries.find((entry) => !insideCreated(entry.name, creates.directory));
  if (outside)
    throw new Error(
      `${archive.name} carries "${outside.name}", which is outside the ${creates.directory} folder ${manifest.name} creates - refused.`,
    );
  return entries;
}

/**
 * Resolves what creating this install would do, and downloads what it needs to say so - without writing
 * anything into the game folder.
 *
 * `tool` is the extraction tool, already fetched: obtaining it costs a download, and the same copy serves the
 * plan and the install that follows it.
 */
export async function planCreateInstall(
  platform: Platform,
  install: Install,
  release: ModRelease,
  answers: Readonly<Record<string, string>>,
  tool: ReadyDatTool,
  options?: ModProgress,
): Promise<CreateInstallPlan> {
  const { manifest, creates, becomes, archive } = creatingRelease(release);
  const record = await loadRecord(platform, install.path);
  assertUsable(record, manifest.id);

  // The user's own folders first: everything after this costs a download, and a folder that is not the game
  // the mod asked for is the likeliest thing to be wrong.
  const archives = await archivesFor(platform, manifest, answers);
  const source = sourceArchive(manifest, archives);
  if (source !== null) {
    const unreadable = await datReadError(platform, tool, source);
    if (unreadable !== null) throw new Error(`ZAX cannot read ${source}: ${unreadable}`);
  }

  const created = insidePath(platform, install.path, creates.directory);
  const upgrading = (await platform.fs.stat(created)) !== null;
  if (!upgrading) {
    const refusal = await refusalFor(platform, install, release);
    if (refusal !== null) throw new Error(refusal);
  }

  const download = archive.size ?? 0;
  const free = await platform.fs.freeSpace(install.path);
  if (free !== null && download > 0 && free < download)
    throw new Error(
      `${manifest.name} needs ${download} bytes to download and this drive has ${free} free. Nothing was downloaded.`,
    );

  const work = modWorkDirectory(platform, install, manifest.id);
  const archivePath = await fetchAsset(
    platform,
    work,
    archive,
    { mod: manifest.name, label: `${manifest.name} ${manifest.version}` },
    options,
  );

  options?.onStep?.(`Reading ${archive.name}`);
  const entries = await confinedEntries(platform, archivePath, archive, manifest, creates);
  const unpacked = entries.reduce((total, entry) => total + entry.size, 0);
  if (free !== null && free < unpacked)
    throw new Error(
      `${manifest.name} unpacks to ${unpacked} bytes and this drive has ${free} free. Nothing was installed.`,
    );

  const list = await fetchList(platform, work, archivePath, manifest, creates);
  const chosen = Object.fromEntries([...archives.keys()].map((id) => [id, (answers[id] ?? "").trim()]));

  return {
    kind: "creates",
    version: manifest.version,
    directory: creates.directory,
    asset: archive.name,
    download,
    unpacked,
    ...(free !== null ? { free } : {}),
    inputs: chosen,
    ...(list ? { extracts: list.entries } : {}),
    becomes,
    fingerprint: fnv1a(
      [
        manifest.version,
        archive.digest ?? "",
        creates.directory,
        ...Object.entries(chosen)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([id, folder]) => `${id}=${folder}`),
        String(unpacked),
        String(list?.entries ?? 0),
      ].join("\n"),
    ),
  };
}

/**
 * Creates the install: the payload into the directory it declares, then the user's own archive into that
 * directory's data folder.
 *
 * A failure leaves what has landed where it is. There is nothing to unwind - the host was never touched -
 * and deleting a finished 800 MB unpack because the last step failed would cost the user the whole download
 * over a folder they can point at again.
 */
export async function applyCreateInstall(
  platform: Platform,
  install: Install,
  release: ModRelease,
  plan: CreateInstallPlan,
  tool: ReadyDatTool,
  options?: ModProgress,
  now: Date = new Date(),
): Promise<CreateInstallOutcome> {
  // What the created install becomes is not read here: the caller identifies the directory by reading
  // it, so a payload that did not produce what it claimed is visible rather than recorded.
  const { manifest, creates, archive } = creatingRelease(release);
  const record = await loadRecord(platform, install.path);
  assertUsable(record, manifest.id);
  const previous = record.mods.find((mod) => mod.id === manifest.id && mod.complete);

  // The plan's answers rather than fresh ones: what runs is what was confirmed, down to which folder it
  // reads from. They are checked again all the same - the folder may have gone since.
  const archives = await archivesFor(platform, manifest, plan.inputs);
  const source = sourceArchive(manifest, archives);

  const created = insidePath(platform, install.path, creates.directory);
  const upgrading = previous !== undefined || (await platform.fs.stat(created)) !== null;
  if (!upgrading) {
    const refusal = await refusalFor(platform, install, release);
    if (refusal !== null) throw new Error(refusal);
  }

  const work = modWorkDirectory(platform, install, manifest.id);
  const archivePath = await fetchAsset(
    platform,
    work,
    archive,
    { mod: manifest.name, label: `${manifest.name} ${manifest.version}` },
    options,
  );

  const list = await fetchList(platform, work, archivePath, manifest, creates);

  const pending: InstalledMod = {
    id: manifest.id,
    version: manifest.version,
    type: "base",
    complete: false,
    // Empty for the reason a delegated base mod's is: what this install owns is a whole directory, and the
    // record is not the place to enumerate ten thousand paths. It is also what makes it unremovable in fact.
    files: [],
    manifest: release.manifestText,
    shipped: {},
  };
  await saveRecord(platform, withMod(record, pending));

  // The user's own settings in the created install, where there is one already - an upgrade unpacks the
  // release's copies of the same files over them.
  const stateFiles = CONFIG_FILES.map((name) => `${creates.directory}/${name}`);
  const backup = platform.paths.join(backupDirectory(platform), stamp(now));
  const mine = await holdUserFiles(platform, install.path, stateFiles, backup);

  options?.onStep?.(`Installing ${manifest.name} ${manifest.version}`);
  // Again here, not only in the plan: this is the call that writes, and what keeps a payload out of the host
  // install is this list rather than anything the archive itself promises.
  await confinedEntries(platform, archivePath, archive, manifest, creates);
  await platform.archive.extract(archivePath, install.path);

  let extracted = 0;
  let skipped: readonly string[] = [];
  if (source !== null && list !== null && manifest.extractDat) {
    options?.onStep?.(`Unpacking Fallout 1's files`);
    // The extraction is what discovers a path this edition of the archive spells differently: it is told to
    // skip those and says which they were. The count reported has to lose them too, or it names files that
    // never landed.
    skipped = await extractFromDat(
      platform,
      tool,
      source,
      list.path,
      insidePath(platform, created, manifest.extractDat.into),
    );
    extracted = list.entries - skipped.length;
  }

  const { shipped, conflicts } = await mergeUserFiles(
    platform,
    install.path,
    stateFiles,
    mine,
    previous?.shipped ?? {},
  );

  await saveRecord(
    platform,
    withMod(await loadRecord(platform, install.path), { ...pending, complete: true, shipped }),
  );
  await platform.fs.remove(work);
  return { version: manifest.version, created, extracted, skipped, conflicts };
}

function withMod(record: InstallRecord, mod: InstalledMod): InstallRecord {
  // Spread, so the entries this version could not read survive an install of something else entirely.
  return { ...record, mods: [...record.mods.filter((held) => held.id !== mod.id), mod] };
}

/** What the interface asks for before it can offer this install at all. */
export type { ModInput };

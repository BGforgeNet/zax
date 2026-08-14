/**
 * Installing, upgrading, restoring and removing stacking mods. Every write is bounded to `mods/`, and every
 * exit is finished, retryable, or restored - never a directory that is neither what it was nor the mod with
 * nothing to say about it.
 *
 * The working directory under the cache carries everything a recovery needs: the downloaded archive, copies
 * of whatever deployment overwrote or removed, and the record entry the install replaced. It is cleared when
 * an install finishes and kept by failure and cancellation alike, so a retry resumes instead of paying the
 * download again and a restore can put every byte back.
 */

import {
  IniDocument,
  backupDirectory,
  latin1,
  mergeIni,
  stamp,
  temporaryDirectory,
  type Install,
  type MergeConflict,
} from "@zax/core";
import type { DirEntry, DownloadOptions, Platform } from "@zax/platform";
import { MANIFEST_NAME, insideMods, parseManifest, type ModManifest } from "./manifest.js";
import { answersToId, listMods, readMods, saveMods, MODS_ORDER_PATH, type Mod } from "./mods.js";
import { loadRecord, saveRecord, type InstallRecord, type InstalledMod } from "./records.js";
import type { ModRelease } from "./mod-feed.js";

/** Preflight ceilings, calibrated against the real corpus with headroom - RPU's gigabyte is the outlier. */
const MAX_ENTRIES = 10_000;
const MAX_PATH_DEPTH = 16;
const MAX_TOTAL_BYTES = 8 * 1024 ** 3;

export interface ModProgress extends DownloadOptions {
  onStep?: (step: string) => void;
}

export interface PlannedFile {
  /** Relative to the install, under `mods/`. */
  path: string;
  size: number;
  /** Whether something already sits at the target - what restore would put back. */
  overwrites: boolean;
}

/** The resolved plan, shown before anything is written. */
export interface ModInstallPlan {
  files: readonly PlannedFile[];
  /** Order lines added or re-enabled: the payload's top-level dats. */
  orderLines: readonly string[];
  /** Recorded files the new release does not ship - an upgrade replaces, never overlays. */
  removes: readonly string[];
}

export interface ModInstallOutcome {
  version: string;
  files: readonly string[];
  /** Settings both the user and the release changed; the user's won. */
  conflicts: readonly MergeConflict[];
}

const workDirectory = (platform: Platform, id: string, version: string): string =>
  // Both components arrived shape-checked from the manifest, so they are path-safe by construction.
  platform.paths.join(temporaryDirectory(platform), `mod-${id}-${version}`);

const insidePath = (platform: Platform, root: string, relative: string): string =>
  platform.paths.join(root, ...relative.split("/"));

/** Where the record entry an install replaced waits, in case the install has to be unwound. */
const PREVIOUS_RECORD = "previous-record.json";

const ORDER_DAT = /^mods\/([^/]+\.dat)$/i;

async function fileExists(platform: Platform, path: string): Promise<boolean> {
  return (await platform.fs.stat(path))?.kind === "file";
}

/**
 * A relative path resolved to its on-disk spelling under `root`, or null when nothing answers to it. Matched
 * case-insensitively segment by segment, the way the loader and upstream's own checks treat paths, so
 * `MODS/Rpu.DAT` on a case-sensitive filesystem still answers to `mods/rpu.dat` - and the caller gets the
 * real name to copy or delete. `listings` caches one read per directory across a batch of lookups; pass it
 * only while nothing is writing, since a mutation would go unseen.
 */
async function realCasedPath(
  platform: Platform,
  root: string,
  relative: string,
  listings?: Map<string, readonly DirEntry[] | null>,
): Promise<string | null> {
  let at = root;
  for (const segment of relative.replace(/\\/g, "/").split("/")) {
    let entries = listings?.get(at);
    if (entries === undefined) {
      entries = await platform.fs.list(at).catch(() => null);
      listings?.set(at, entries);
    }
    if (entries === null) return null;
    const found = entries.find((entry) => entry.name.toLowerCase() === segment.toLowerCase());
    if (!found) return null;
    at = platform.paths.join(at, found.name);
  }
  return at;
}

/** The manifest's own refusal conditions, judged against the directory as it is now. */
export async function refusalFor(platform: Platform, install: Install, release: ModRelease): Promise<string | null> {
  for (const rule of release.manifest.refuse) {
    let fires = true;
    for (const path of rule.present) if ((await realCasedPath(platform, install.path, path)) === null) fires = false;
    for (const path of rule.absent) if ((await realCasedPath(platform, install.path, path)) !== null) fires = false;
    if (fires) return rule.reason;
  }
  return null;
}

/**
 * Downloads and verifies the release, then resolves what installing it would do - without writing a byte
 * into the game directory. The archive is fetched into the working directory unless a verified copy is
 * already there, which is what makes a retry resume instead of paying the download again.
 */
export async function planModInstall(
  platform: Platform,
  install: Install,
  release: ModRelease,
  options?: ModProgress,
): Promise<ModInstallPlan> {
  const { manifest } = release;
  const asset = release.archive;
  if (!asset) throw new Error(`The ${manifest.name} release does not say which of its files is the mod.`);
  const digest = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? "")?.[1]?.toLowerCase();
  // Required rather than best-effort: the digest is what closes in-transit tampering, truncation and a
  // corrupted resume in one check, and the feeds this list trusts all publish one.
  if (!digest) throw new Error(`The ${manifest.name} release states no digest for ${asset.name}.`);

  const work = workDirectory(platform, manifest.id, manifest.version);
  const archivePath = platform.paths.join(work, asset.name);

  const held = (await fileExists(platform, archivePath)) && (await platform.hash.sha256(archivePath)) === digest;
  if (!held) {
    options?.onStep?.(`Downloading ${manifest.name} ${manifest.version}`);
    await platform.net.download(asset.url, archivePath, options);
    const got = await platform.hash.sha256(archivePath);
    if (got !== digest) {
      await platform.fs.remove(archivePath);
      throw new Error(
        `What arrived for ${asset.name} does not match the digest its release states - the download may have been tampered with or corrupted. Nothing was installed.`,
      );
    }
  }

  options?.onStep?.("Reading the archive");
  const entries = await platform.archive.list(archivePath);
  if (entries.length > MAX_ENTRIES) throw new Error(`${asset.name} declares ${entries.length} entries - refused.`);
  let total = 0;
  for (const entry of entries) {
    if (entry.kind === "link")
      throw new Error(`${asset.name} contains a symbolic link (${entry.name}) - refused, nothing was extracted.`);
    if (entry.name.split("/").length > MAX_PATH_DEPTH)
      throw new Error(`${asset.name} nests paths deeper than any mod does (${entry.name}) - refused.`);
    total += entry.size;
  }
  if (total > MAX_TOTAL_BYTES)
    throw new Error(`${asset.name} declares ${total} bytes unpacked, past what any known mod needs - refused.`);

  // The embedded copy must match the asset eligibility was decided on, byte for byte - CI writes both from
  // one source, so a difference means the archive is not the release the manifest described.
  const embeddedAt = platform.paths.join(work, "embedded");
  await platform.archive.extract(archivePath, embeddedAt, { only: [MANIFEST_NAME] });
  const embeddedPath = platform.paths.join(embeddedAt, MANIFEST_NAME);
  if (!(await fileExists(platform, embeddedPath)))
    throw new Error(`${asset.name} carries no ${MANIFEST_NAME} at its root - refused.`);
  const embedded = new TextDecoder().decode(await platform.fs.read(embeddedPath));
  if (embedded !== release.manifestText)
    throw new Error(`The manifest inside ${asset.name} is not the one its release published - refused.`);

  const files: PlannedFile[] = [];
  // One read per directory across the whole archive; planning writes nothing, so the cache cannot go stale.
  const listings = new Map<string, readonly DirEntry[] | null>();
  for (const entry of entries) {
    if (entry.kind !== "file" || !insideMods(entry.name)) continue;
    const overwrites = (await realCasedPath(platform, install.path, entry.name, listings)) !== null;
    files.push({ path: entry.name, size: entry.size, overwrites });
  }
  if (files.length === 0) throw new Error(`${asset.name} ships nothing under mods/ - there is nothing to install.`);

  const planned = new Set(files.map((file) => file.path.toLowerCase()));
  const recorded = (await loadRecord(platform, install.path)).mods.find((mod) => mod.id === manifest.id);
  const removes = (recorded?.files ?? []).filter((path) => !planned.has(path.toLowerCase()));

  const orderLines = files.map((file) => ORDER_DAT.exec(file.path)?.[1]).filter((name): name is string => !!name);
  return { files, orderLines, removes };
}

/**
 * One pass over the order file: the mod's dats end enabled whatever an older file said, and lines whose dat
 * this change removed go with it. One save rather than two, so the user's file is read, backed up and
 * rewritten once per operation.
 */
async function updateOrderLines(
  platform: Platform,
  install: Install,
  changes: { enable?: readonly string[]; drop?: readonly string[] },
): Promise<void> {
  const enable = changes.enable ?? [];
  const drop = changes.drop ?? [];
  if (enable.length === 0 && drop.length === 0) return;
  const snapshot = await readMods(platform, install);
  const held = listMods(snapshot);
  const wanted = new Set(enable.map((name) => name.toLowerCase()));
  const gone = new Set(drop.map((name) => name.toLowerCase()));
  const mods: Mod[] = held
    .filter((mod) => !gone.has(mod.name.toLowerCase()))
    .map((mod) => (wanted.has(mod.name.toLowerCase()) ? { ...mod, enabled: true } : mod));
  for (const name of enable) {
    if (!held.some((mod) => mod.name.toLowerCase() === name.toLowerCase()))
      mods.push({ name, enabled: true, kind: "dat" });
  }
  const saved = await saveMods(platform, { installPath: install.path, original: snapshot.text, mods });
  if (!saved.ok) throw new Error(`${MODS_ORDER_PATH} changed underneath - retry to pick up the new file.`);
}

const orderDats = (paths: readonly string[]): string[] =>
  paths.map((path) => ORDER_DAT.exec(path)?.[1]).filter((name): name is string => !!name);

/**
 * Executes a confirmed plan. The record is written marked incomplete before the first byte lands and marked
 * complete as the last act, so a relaunch that finds one knows to offer retry or restore rather than
 * trusting the directory; what the entry replaced waits in the working directory for a restore.
 */
export async function applyModInstall(
  platform: Platform,
  install: Install,
  release: ModRelease,
  plan: ModInstallPlan,
  options?: ModProgress,
  now: Date = new Date(),
): Promise<ModInstallOutcome> {
  const { manifest } = release;
  const refusal = await refusalFor(platform, install, release);
  if (refusal !== null) throw new Error(refusal);

  const work = workDirectory(platform, manifest.id, manifest.version);
  const archivePath = platform.paths.join(work, release.archive?.name ?? "");
  const record = await loadRecord(platform, install.path);
  const previous = record.mods.find((mod) => mod.id === manifest.id);
  const upgrading = previous !== undefined;

  // What this install replaces waits in the working directory, so a restore can put the record back too.
  await platform.fs.write(
    platform.paths.join(work, PREVIOUS_RECORD),
    new TextEncoder().encode(JSON.stringify(previous ?? null)),
  );
  const pending: InstalledMod = {
    id: manifest.id,
    version: manifest.version,
    complete: false,
    files: plan.files.map((file) => file.path),
    manifest: release.manifestText,
    shipped: {},
  };
  await saveRecord(platform, withMod(record, pending));

  options?.onStep?.(`Installing ${manifest.name} ${manifest.version}`);
  const backup = platform.paths.join(backupDirectory(platform), stamp(now));
  for (const file of plan.files) {
    // Resolved fresh rather than trusting the plan's `overwrites` - the directory may have moved on since.
    const found = await realCasedPath(platform, install.path, file.path);
    if (found === null) continue;
    await platform.fs.copy(found, insidePath(platform, platform.paths.join(work, "overwritten"), file.path));
    // An upgrade's replaced files also reach the timestamped backup, as anything a save replaces does.
    if (upgrading) await platform.fs.copy(found, insidePath(platform, backup, file.path));
    // Replaced means replaced: left in place, a differently-spelled original would sit beside the extracted
    // file on a case-sensitive filesystem, and the loader - which folds case - would see the same mod twice.
    if (found !== insidePath(platform, install.path, file.path)) await platform.fs.remove(found);
  }
  for (const path of plan.removes) {
    const found = await realCasedPath(platform, install.path, path);
    if (found === null) continue;
    await platform.fs.copy(found, insidePath(platform, platform.paths.join(work, "removed"), path));
    if (upgrading) await platform.fs.copy(found, insidePath(platform, backup, path));
    await platform.fs.remove(found);
  }

  await platform.archive.extract(archivePath, install.path, { only: plan.files.map((file) => file.path) });

  // State files: what the release shipped is recorded as the next upgrade's merge base, then the user's
  // values are merged into the shipped file - with the previous release's copy as base where a record holds
  // one, and user-wins where none does, exactly as the sfall updater treats ddraw.ini.
  const stateFiles = manifest.state ?? plan.files.map((file) => file.path).filter((path) => /\.ini$/i.test(path));
  const shipped: Record<string, string> = {};
  const conflicts: MergeConflict[] = [];
  for (const path of stateFiles) {
    const target = insidePath(platform, install.path, path);
    if (!(await fileExists(platform, target))) continue;
    const shippedBytes = await platform.fs.read(target);
    shipped[path] = latin1(shippedBytes);
    const previousCopy = insidePath(platform, platform.paths.join(work, "overwritten"), path);
    if (!(await fileExists(platform, previousCopy))) continue;
    const base = previous?.shipped[path];
    const outcome = mergeIni(
      IniDocument.parseBytes(shippedBytes),
      IniDocument.parseBytes(await platform.fs.read(previousCopy)),
      base === undefined ? null : IniDocument.parse(base),
    );
    await platform.fs.write(target, outcome.document.toBytes());
    conflicts.push(...outcome.conflicts);
  }

  await updateOrderLines(platform, install, { enable: plan.orderLines, drop: orderDats(plan.removes) });

  await saveRecord(
    platform,
    withMod(await loadRecord(platform, install.path), { ...pending, complete: true, shipped }),
  );
  await platform.fs.remove(work);
  return { version: manifest.version, files: pending.files, conflicts };
}

function withMod(record: InstallRecord, mod: InstalledMod): InstallRecord {
  return { path: record.path, mods: [...record.mods.filter((held) => held.id !== mod.id), mod] };
}

function withoutMod(record: InstallRecord, id: string): InstallRecord {
  return { path: record.path, mods: record.mods.filter((held) => held.id !== id) };
}

/**
 * Unwinds an install that never finished: what deployment overwrote or removed goes back from the working
 * directory's copies, files new with the payload are deleted, the order lines go, and the record returns to
 * what it said before. The working directory is cleared last - it is the restore's own source.
 */
export async function restoreModInstall(platform: Platform, install: Install, id: string): Promise<void> {
  const record = await loadRecord(platform, install.path);
  const pending = record.mods.find((mod) => mod.id === id);
  if (!pending || pending.complete) throw new Error(`Nothing of "${id}" is waiting to be restored.`);

  const work = workDirectory(platform, pending.id, pending.version);
  for (const path of pending.files) {
    if (!insideMods(path)) continue;
    const target = insidePath(platform, install.path, path);
    const kept = insidePath(platform, platform.paths.join(work, "overwritten"), path);
    if (await fileExists(platform, kept)) await platform.fs.copy(kept, target);
    else await platform.fs.remove(target);
  }
  const removedRoot = platform.paths.join(work, "removed");
  if ((await platform.fs.stat(removedRoot))?.kind === "dir") {
    for (const path of await listRecursively(platform, removedRoot)) {
      await platform.fs.copy(
        platform.paths.join(removedRoot, ...path.split("/")),
        insidePath(platform, install.path, path),
      );
    }
  }

  // After the files, so a refused order-file write leaves a directory already made whole - and loudly. Only
  // lines whose dat is genuinely gone go: a restored upgrade put the previous release's dats back, and their
  // lines are theirs to keep.
  const gone: string[] = [];
  for (const path of pending.files) {
    const name = ORDER_DAT.exec(path)?.[1];
    if (name && !(await fileExists(platform, insidePath(platform, install.path, path)))) gone.push(name);
  }
  await updateOrderLines(platform, install, { drop: gone });

  let restored = withoutMod(record, id);
  const previousPath = platform.paths.join(work, PREVIOUS_RECORD);
  if (await fileExists(platform, previousPath)) {
    const previous = JSON.parse(new TextDecoder().decode(await platform.fs.read(previousPath))) as InstalledMod | null;
    if (previous !== null) restored = withMod(restored, previous);
  }
  await saveRecord(platform, restored);
  await platform.fs.remove(work);
}

async function listRecursively(platform: Platform, root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (at: string, prefix: string): Promise<void> => {
    for (const entry of await platform.fs.list(at)) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.kind === "dir") await walk(platform.paths.join(at, entry.name), path);
      else out.push(path);
    }
  };
  await walk(root, "");
  return out;
}

export interface ModRemoval {
  /** What was deleted, relative to the install. */
  files: readonly string[];
  /** Where the copies went before deletion. */
  backup: string;
}

/**
 * Uninstalls a pluggable mod: recorded files - or, recordless, whatever under `mods/` answers to the id -
 * are copied to the timestamped backup, then deleted, their order lines removed, the record dropped. Every
 * deleted path is confined to `mods/`; a record that says otherwise was already dropped at load.
 */
export async function uninstallMod(
  platform: Platform,
  install: Install,
  id: string,
  now: Date = new Date(),
): Promise<ModRemoval> {
  const record = await loadRecord(platform, install.path);
  const recorded = record.mods.find((mod) => mod.id === id);

  // The one gate every removal surface goes through, so no menu or shortcut can offer what the type forbids.
  // A recordless permanent mod is not covered here - the interface never offers Remove for one it knows, and
  // deleting an unknown folder by name is no more than the convention below could always do.
  if (recorded) {
    let manifest: ModManifest | null = null;
    try {
      manifest = parseManifest(new TextEncoder().encode(recorded.manifest));
    } catch {
      // A snapshot this version cannot read gives no verdict; the recorded list still bounds removal to mods/.
    }
    if (manifest?.type === "permanent")
      throw new Error(`${manifest.name} cannot be uninstalled: ${manifest.reason ?? "its manifest says so"}`);
  }

  let files: string[];
  if (recorded) {
    files = [...recorded.files];
  } else {
    // The `mods/<id>.*` convention - exactly the uninstall FO2tweaks' own readme prescribes.
    const directory = platform.paths.join(install.path, "mods");
    const entries = (await platform.fs.stat(directory))?.kind === "dir" ? await platform.fs.list(directory) : [];
    files = entries.filter((entry) => answersToId(entry.name, id)).map((entry) => `mods/${entry.name}`);
  }
  if (files.length === 0) throw new Error(`Nothing of "${id}" is here to remove.`);

  const backup = platform.paths.join(backupDirectory(platform), stamp(now));
  const deleted: string[] = [];
  for (const path of files) {
    if (!insideMods(path)) continue;
    const target = insidePath(platform, install.path, path);
    const found = await platform.fs.stat(target);
    if (found === null) continue;
    if (found.kind === "file") await platform.fs.copy(target, insidePath(platform, backup, path));
    else
      for (const inner of await listRecursively(platform, target))
        await platform.fs.copy(
          platform.paths.join(target, ...inner.split("/")),
          insidePath(platform, backup, `${path}/${inner}`),
        );
    await platform.fs.remove(target);
    deleted.push(path);
  }

  await updateOrderLines(platform, install, { drop: orderDats(deleted) });
  await saveRecord(platform, withoutMod(record, id));
  return { files: deleted, backup };
}

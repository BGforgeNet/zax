/**
 * Installing, upgrading, restoring and removing stacking mods. Every write is bounded to `mods/`, and every
 * exit is finished, retryable, or restored - never a directory that is neither what it was nor the mod with
 * nothing to say about it.
 *
 * An install runs in five phases, and the list is what recovery is written against: journal, deploy, merge,
 * order, commit. Its durable state is exactly four things - the deployed files, `mods_order.txt`, the
 * install record, and the working directory itself - so a restore that puts the first three back from the
 * fourth is total, and needs no phase marker to know how far the failure got.
 *
 * The working directory under the cache carries everything that recovery needs: the journal, the downloaded
 * archive, and copies of whatever deployment overwrote or removed. It is cleared when an install finishes
 * and kept by failure and cancellation alike, so a retry resumes instead of paying the download again and a
 * restore can put every byte back.
 */

import {
  IniDocument,
  backupDirectory,
  fnv1a,
  latin1,
  mergeIni,
  stamp,
  type Install,
  type MergeConflict,
} from "@zax/core";
import type { ArchiveEntryInfo, DirEntry, Platform } from "@zax/platform";
import { fetchAsset, type ModProgress } from "./mod-asset.js";
import { preflightArchive } from "./archive-preflight.js";
import { MANIFEST_NAME, mayWrite, parseManifest, type ModManifest, type ModPart, type ModType } from "./manifest.js";
import { grantsFor } from "./mod-grants.js";
import {
  answersToId,
  listMods,
  namedInOrder,
  readMods,
  restoreOrder,
  saveMods,
  MODS_DIRECTORY,
  MODS_ORDER_PATH,
  type Mod,
} from "./mods.js";
import { placeFor, recommendationFor } from "./recommended-order.js";
import { assertUsable, loadRecord, saveRecord, type InstallRecord, type InstalledMod } from "./records.js";
import { modWorkDirectory, readTransaction, writeTransaction, type ModTransaction } from "./mod-transaction.js";
import { isArchiveName, type ModRelease, type ReleaseAsset } from "./mod-feed.js";
import { chosenParts } from "./mod-parts.js";

export interface PlannedFile {
  /** Relative to the install, under `mods/`. */
  path: string;
  size: number;
  /** Whether something already sits at the target - what restore would put back. */
  overwrites: boolean;
  /** Which part ships it, for a mod that has them: deployment takes each file from its own payload. */
  part?: string;
}

/** The resolved plan, shown before anything is written. */
export interface ModInstallPlan {
  /** Which kind of install this plan is for, so the interface can tell it from a base mod's. */
  kind: "stacking";
  files: readonly PlannedFile[];
  /**
   * The mods-folder entries this install owns, as the manifest spells them - added or re-enabled in the
   * order file, and recorded so an uninstall can drop the lines a folder entry's paths could never name.
   */
  orderLines: readonly string[];
  /** The parts this plan installs, by id, absent for a mod without them. What the record keeps. */
  parts?: readonly string[];
  /** Recorded files the new release does not ship - an upgrade replaces, never overlays. */
  removes: readonly string[];
  /**
   * What this plan resolved to, in one short string. The install re-plans - the directory may have moved on
   * since the confirmation - and refuses when the answer no longer fingerprints the same, so what runs is
   * what was agreed to rather than whatever the same button would resolve to now.
   */
  fingerprint: string;
}

export interface ModInstallOutcome {
  version: string;
  files: readonly string[];
  /** Settings both the user and the release changed; the user's won. */
  conflicts: readonly MergeConflict[];
}

const insidePath = (platform: Platform, root: string, relative: string): string =>
  platform.paths.join(root, ...relative.split("/"));

/** Where deployment sets aside what it overwrote, and what it removed, relative to the working directory. */
const OVERWRITTEN = "overwritten";
const REMOVED = "removed";

const ORDER_DAT = /^mods\/([^/]+\.dat)$/i;

/**
 * One payload an install deploys: a whole mod, or one chosen part of it. A part is its own asset, its own
 * digest and its own preflight, because that is how a release publishes them.
 */
interface ModPayload {
  /** The part this belongs to, absent for a mod that declares none. */
  part?: ModPart;
  asset: ReleaseAsset;
  /** Where a payload that is not an archive lands, or null for one that is. */
  single: string | null;
}

/**
 * Where a payload that is not an archive lands, or null for one that is. Cassidy publishes four loose `.dat`
 * assets and the walk-speed and Goris fixes one each, and a single file carries no paths of its own - so the
 * declared entries are the only thing that can say what it installs as, and there must be exactly one.
 */
function singleFileTarget(asset: ReleaseAsset, entries: readonly string[] | undefined, mod: string): string | null {
  if (isArchiveName(asset.name)) return null;
  const declared = entries ?? [];
  if (declared.length !== 1)
    throw new Error(
      `${asset.name} is one file rather than an archive, so the ${mod} manifest has to declare the single "entries" name it installs as.`,
    );
  return `${MODS_DIRECTORY}/${declared[0]}`;
}

/** What this install downloads and deploys: the mod's own payload, or one per selected part. */
function payloadsFor(release: ModRelease, selection: readonly string[]): readonly ModPayload[] {
  const { manifest } = release;
  if (manifest.parts) {
    return chosenParts(release, selection).map((part) => {
      const asset = release.parts?.[part.id];
      // Unreachable through `chosenParts`, which offers only the parts the release published - kept because
      // a caller could hand a release and a selection that were never resolved together.
      if (!asset) throw new Error(`The ${manifest.name} release publishes no file for ${part.label}.`);
      return { part, asset, single: singleFileTarget(asset, part.entries, manifest.name) };
    });
  }
  const asset = release.archive;
  if (!asset)
    throw new Error(
      `The ${manifest.name} release does not say which of its files is the mod - its manifest needs an "archive".`,
    );
  return [{ asset, single: singleFileTarget(asset, manifest.entries, manifest.name) }];
}

/**
 * The entries one payload puts in the mods folder: what it declares, or - for a manifest written before the
 * field existed - the top-level dats it ships.
 *
 * The derivation cannot see two things the declaration can. A mod whose entry is a folder ships only paths
 * below it (`mods/InventoryFilter.dat/InvenFilter.ini`), which match no top-level dat, so it would install and
 * never be loaded; and `mods/patches/extra.dat` reads either as a folder entry `patches` or as a nested dat,
 * which only the mod knows.
 */
function entriesFor(payload: ModPayload, manifest: ModManifest, files: readonly PlannedFile[]): readonly string[] {
  return (payload.part ? payload.part.entries : manifest.entries) ?? orderDats(files.map((file) => file.path));
}

/** Whether the payload actually carries a declared entry - the name itself, or anything under it. */
function shipsEntry(files: readonly PlannedFile[], entry: string): boolean {
  const at = `mods/${entry}`.toLowerCase();
  return files.some((file) => {
    const path = file.path.toLowerCase();
    return path === at || path.startsWith(`${at}/`);
  });
}

/**
 * The plan in one line, hashed. Not a cryptographic digest and not meant as one: it detects a plan that
 * moved between the confirmation and the install, and anything that could forge it could have supplied the
 * plan itself.
 */
function fingerprintOf(
  release: ModRelease,
  files: readonly PlannedFile[],
  plan: Omit<ModInstallPlan, "fingerprint" | "files" | "kind">,
): string {
  return fnv1a(
    [
      release.manifest.version,
      release.archive?.digest ?? "",
      // The selection, so a plan confirmed for one set of parts cannot install another.
      ...(plan.parts ?? []).map((id) => `=${id}:${release.parts?.[id]?.digest ?? ""}`),
      ...files.map((file) => `${file.path}:${file.size}:${file.overwrites ? "over" : "new"}`),
      ...plan.orderLines.map((name) => `+${name}`),
      ...plan.removes.map((path) => `-${path}`),
    ].join("\n"),
  );
}

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
  selection: readonly string[] = [],
  options?: ModProgress,
): Promise<ModInstallPlan> {
  const { manifest } = release;
  // Ahead of the download rather than after it: a record this version may not write is a refusal the user
  // should get before spending a transfer on it.
  assertUsable(await loadRecord(platform, install.path), manifest.id);
  const payloads = payloadsFor(release, selection);
  const work = modWorkDirectory(platform, install, manifest.id);
  const granted = grantsFor(manifest.id);

  const files: PlannedFile[] = [];
  const orderLines: string[] = [];
  // One read per directory across every payload; planning writes nothing, so the cache cannot go stale.
  const listings = new Map<string, readonly DirEntry[] | null>();

  for (const payload of payloads) {
    const { asset } = payload;
    const archivePath = await fetchAsset(
      platform,
      work,
      payload.asset,
      {
        mod: manifest.name,
        label: payload.part ? `${manifest.name} - ${payload.part.label}` : `${manifest.name} ${manifest.version}`,
      },
      options,
    );

    let entries: readonly ArchiveEntryInfo[];
    if (payload.single !== null) {
      // Every archive-shaped step is beside the point for one file: no directory to read, no entry count or
      // unpacked total to bound, no symlink entry to refuse, and no embedded manifest to compare against. The
      // manifest's own declaration says where it lands, which is what an archive's paths would have said.
      entries = [
        { name: payload.single, kind: "file", size: asset.size ?? (await platform.fs.stat(archivePath))?.size ?? 0 },
      ];
    } else {
      options?.onStep?.(`Reading ${asset.name}`);
      entries = await preflightArchive(platform, archivePath, asset.name);
      await checkEmbeddedManifest(platform, work, payload, release);
    }

    const mine: PlannedFile[] = [];
    for (const entry of entries) {
      if (entry.kind !== "file" || !mayWrite(entry.name, granted)) continue;
      const overwrites = (await realCasedPath(platform, install.path, entry.name, listings)) !== null;
      mine.push({ path: entry.name, size: entry.size, overwrites, ...(payload.part ? { part: payload.part.id } : {}) });
    }
    if (mine.length === 0)
      throw new Error(
        `${asset.name} ships nothing under mods/${granted.length > 0 ? ` or in ${granted.join(", ")}` : ""} - there is nothing to install.`,
      );

    // Two payloads writing one path is an ambiguity only the mod can settle, and last-writer-wins would
    // resolve it silently - differently on a case-sensitive filesystem than elsewhere.
    for (const file of mine) {
      const held = files.find((other) => other.path.toLowerCase() === file.path.toLowerCase());
      if (held)
        throw new Error(
          `${asset.name} and ${payloads.find((other) => other.part?.id === held.part)?.asset.name ?? "the payload"} both land on ${file.path}, so they cannot be installed together.`,
        );
    }

    // A declared entry nothing carries would put a line in the order file naming something absent, which the
    // loader skips with a log line nobody reads - so it refuses here, where the cause is still visible.
    for (const entry of (payload.part ? payload.part.entries : manifest.entries) ?? []) {
      if (!shipsEntry(mine, entry))
        throw new Error(`${asset.name} does not carry "${entry}", which the ${manifest.name} manifest declares.`);
    }

    files.push(...mine);
    orderLines.push(...entriesFor(payload, manifest, mine));
  }

  const planned = new Set(files.map((file) => file.path.toLowerCase()));
  // What this install replaces comes from the open transaction when there is one. Read from the record
  // instead, a retry would find its own unfinished entry there and conclude it replaces itself - so the
  // files a first attempt already removed would go unlisted, and their order lines would outlive them.
  const open = await readTransaction(platform, install, manifest.id);
  const replacing =
    open?.previous ??
    (await loadRecord(platform, install.path)).mods.find((mod) => mod.id === manifest.id && mod.complete);
  const removes = (replacing?.files ?? []).filter((path) => !planned.has(path.toLowerCase()));

  const parts = manifest.parts ? payloads.map((payload) => payload.part?.id ?? "") : undefined;
  return {
    kind: "stacking",
    files,
    orderLines,
    removes,
    ...(parts ? { parts } : {}),
    fingerprint: fingerprintOf(release, files, { orderLines, removes, ...(parts ? { parts } : {}) }),
  };
}

/**
 * The copy inside the archive against the one eligibility was decided on, byte for byte - a difference means
 * the archive is not the release the manifest described.
 *
 * Required only of a release that published a manifest asset, where CI writes both from one source; a
 * manifest read from the repository is tied to the tag instead, and its payload is under no obligation to
 * carry a copy. A part's archive is never required to carry one either: the manifest names each part's asset
 * outright, so there is no inference for an embedded copy to confirm, and demanding one would put a copy of
 * the whole manifest inside every part a mod publishes. One that is there is still checked.
 */
async function checkEmbeddedManifest(
  platform: Platform,
  work: string,
  payload: ModPayload,
  release: ModRelease,
): Promise<void> {
  const at = platform.paths.join(work, "embedded", payload.part?.id ?? "mod");
  await platform.archive.extract(platform.paths.join(work, payload.asset.name), at, { only: [MANIFEST_NAME] });
  const embeddedPath = platform.paths.join(at, MANIFEST_NAME);
  if (await fileExists(platform, embeddedPath)) {
    const embedded = new TextDecoder().decode(await platform.fs.read(embeddedPath));
    if (embedded !== release.manifestText)
      throw new Error(`The manifest inside ${payload.asset.name} is not the one its release published - refused.`);
  } else if (release.manifestFromAsset && !payload.part) {
    throw new Error(`${payload.asset.name} carries no ${MANIFEST_NAME} at its root - refused.`);
  }
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
  // Spelled the way the loader does, here rather than at each caller: a manifest holds `/` like every other
  // path-shaped field, the order file's own separator is `\`, and `namedInOrder` reads its lines back
  // normalized - so a nested entry handed over with the wrong one matches no line, and neither the line it
  // just added nor the one it means to drop would be found.
  const spelled = (names: readonly string[]) => names.map((name) => name.replace(/\//g, "\\"));
  const enable = spelled(changes.enable ?? []);
  const drop = spelled(changes.drop ?? []);
  if (enable.length === 0 && drop.length === 0) return;
  const snapshot = await readMods(platform, install);
  const held = listMods(snapshot);
  const wanted = new Set(enable.map((name) => name.toLowerCase()));
  const gone = new Set(drop.map((name) => name.toLowerCase()));
  const mods: Mod[] = held
    .filter((mod) => !gone.has(mod.name.toLowerCase()))
    .map((mod) => (wanted.has(mod.name.toLowerCase()) ? { ...mod, enabled: true } : mod));
  // What the file itself names, rather than what `listMods` holds: by now the payload is deployed, so the
  // folder listing carries the new dat too, and a mod the file has never placed would keep the place that
  // listing gave it - the end - however the recommendation reads.
  const named = new Set(namedInOrder(snapshot.text).map((name) => name.toLowerCase()));
  for (const name of enable) {
    // A line the file already carries stays where the user put it; only a first placement is ZAX's to make.
    if (named.has(name.toLowerCase())) continue;
    const listed = mods.findIndex((mod) => mod.name.toLowerCase() === name.toLowerCase());
    if (listed !== -1) mods.splice(listed, 1);
    mods.splice(placeFor(mods, name, recommendationFor(install.type)), 0, { name, enabled: true, kind: "dat" });
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

  const work = modWorkDirectory(platform, install, manifest.id);
  const record = await loadRecord(platform, install.path);
  assertUsable(record, manifest.id);
  // Resolved here rather than at the deploy, so a release whose payload and manifest disagree about being
  // one file is refused before the transaction opens rather than part way through it.
  const payloads = payloadsFor(release, plan.parts ?? []);

  // Phase 1, journal. Opened once and resumed thereafter: everything it holds describes the directory as it
  // was before the first byte landed, and a retry that re-derived it would be recording its own wreckage -
  // the half-deployed files as the originals to restore, its own unfinished entry as what it replaces.
  const journal = (await readTransaction(platform, install, manifest.id)) ?? (await openJournal());
  const previous = journal.previous;
  const upgrading = previous !== null;

  async function openJournal(): Promise<ModTransaction> {
    const snapshot = await readMods(platform, install);
    const opened: ModTransaction = {
      id: manifest.id,
      ...(release.archive
        ? {
            archive: {
              name: release.archive.name,
              url: release.archive.url,
              digest: release.archive.digest ?? "",
            },
          }
        : {}),
      // One pin per chosen part, and the selection beside them: a retry finishes these parts from these
      // files rather than whatever a second answer to the dialog would have picked.
      ...(plan.parts
        ? {
            parts: Object.fromEntries(
              payloads.map((payload) => [
                payload.part?.id ?? "",
                { name: payload.asset.name, url: payload.asset.url, digest: payload.asset.digest ?? "" },
              ]),
            ),
            selection: plan.parts,
          }
        : {}),
      manifestText: release.manifestText,
      version: manifest.version,
      manifestFromAsset: release.manifestFromAsset,
      // Only a finished entry is something to go back to. An unfinished one here means an earlier
      // transaction whose working directory is gone, and nothing it replaced is recoverable either.
      previous: record.mods.find((mod) => mod.id === manifest.id && mod.complete) ?? null,
      order: snapshot.text ?? null,
      preexisting: plan.files.filter((file) => file.overwrites).map((file) => file.path),
    };
    await writeTransaction(platform, install, opened);
    return opened;
  }

  const pending: InstalledMod = {
    id: manifest.id,
    version: manifest.version,
    type: manifest.type,
    ...(manifest.reason !== undefined ? { reason: manifest.reason } : {}),
    complete: false,
    files: plan.files.map((file) => file.path),
    // A parts install records the entries its chosen parts resolved to, declared or derived: what an
    // uninstall drops from the order file cannot be re-derived from a selection the release may have moved on
    // from. A mod without parts records what its manifest declared, as it always has.
    ...(plan.parts ? { entries: plan.orderLines } : manifest.entries ? { entries: manifest.entries } : {}),
    // Kept when this release has no parts to choose: a mod that folded its parts into one payload has not
    // unmade the choice, and an older ZAX reading this record - or a release that goes back to parts - still
    // needs it. Nothing here reads it while the release has none.
    ...(plan.parts ? { parts: plan.parts } : previous?.parts ? { parts: previous.parts } : {}),
    manifest: release.manifestText,
    shipped: {},
  };
  await saveRecord(platform, withMod(record, pending));

  // Phase 2, deploy.
  options?.onStep?.(`Installing ${manifest.name} ${manifest.version}`);
  const backup = platform.paths.join(backupDirectory(platform), stamp(now));
  const held = new Set(journal.preexisting.map((path) => path.toLowerCase()));
  for (const file of plan.files) {
    // Resolved fresh rather than trusting the plan's `overwrites` - the directory may have moved on since.
    const found = await realCasedPath(platform, install.path, file.path);
    if (found === null) continue;
    // Only what was there before the transaction is worth setting aside, and only once. On a retry what
    // sits here is this transaction's own half-deployed file: copying it would overwrite the real original
    // with the wreckage, and a restore would then put the failed attempt back.
    const kept = insidePath(platform, platform.paths.join(work, OVERWRITTEN), file.path);
    if (held.has(file.path.toLowerCase()) && !(await fileExists(platform, kept))) {
      await platform.fs.copy(found, kept);
      // And to the timestamped backup, as anything a save replaces does. The working directory's copy is
      // cleared when the install finishes, so on a first install this is the only one that outlives it -
      // which is what a later uninstall would otherwise have nothing to put back.
      await platform.fs.copy(found, insidePath(platform, backup, file.path));
    }
    // Replaced means replaced: left in place, a differently-spelled original would sit beside the extracted
    // file on a case-sensitive filesystem, and the loader - which folds case - would see the same mod twice.
    if (found !== insidePath(platform, install.path, file.path)) await platform.fs.remove(found);
  }
  for (const path of plan.removes) {
    const found = await realCasedPath(platform, install.path, path);
    if (found === null) continue;
    await platform.fs.copy(found, insidePath(platform, platform.paths.join(work, REMOVED), path));
    if (upgrading) await platform.fs.copy(found, insidePath(platform, backup, path));
    await platform.fs.remove(found);
  }

  for (const payload of payloads) {
    const archivePath = platform.paths.join(work, payload.asset.name);
    if (payload.single !== null) {
      await platform.fs.copy(archivePath, insidePath(platform, install.path, payload.single));
      continue;
    }
    // Each payload extracts only its own planned files: an archive asked for another part's paths would be
    // asked for paths it does not carry, which is a question with no useful answer.
    const mine = plan.files.filter((file) => file.part === payload.part?.id);
    await platform.archive.extract(archivePath, install.path, { only: mine.map((file) => file.path) });
  }

  // Phase 3, merge.
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
    const previousCopy = insidePath(platform, platform.paths.join(work, OVERWRITTEN), path);
    if (!(await fileExists(platform, previousCopy))) continue;
    // The journal's entry, not the record's: on a retry the record holds this transaction's own unfinished
    // entry, whose base is empty, and merging against that would drop every default the last release set.
    const base = previous?.shipped[path];
    const outcome = mergeIni(
      IniDocument.parseBytes(shippedBytes),
      IniDocument.parseBytes(await platform.fs.read(previousCopy)),
      base === undefined ? null : IniDocument.parse(base),
    );
    await platform.fs.write(target, outcome.document.toBytes());
    conflicts.push(...outcome.conflicts);
  }

  // Phase 4, order. What the previous release ordered and this one no longer does goes with it - read from
  // its own declaration where it made one, since a folder entry names no line the deployed paths could yield.
  const dropped = journal.previous?.entries
    ? journal.previous.entries.filter(
        (name) => !plan.orderLines.some((kept) => kept.toLowerCase() === name.toLowerCase()),
      )
    : orderDats(plan.removes);
  await updateOrderLines(platform, install, { enable: plan.orderLines, drop: dropped });

  // Phase 5, commit. The working directory goes last: until it does, this is still a transaction to unwind.
  await saveRecord(
    platform,
    withMod(await loadRecord(platform, install.path), { ...pending, complete: true, shipped }),
  );
  await platform.fs.remove(work);
  return { version: manifest.version, files: pending.files, conflicts };
}

function withMod(record: InstallRecord, mod: InstalledMod): InstallRecord {
  // Spread, so the entries this version could not read survive an install of something else entirely.
  return { ...record, mods: [...record.mods.filter((held) => held.id !== mod.id), mod] };
}

function withoutMod(record: InstallRecord, id: string): InstallRecord {
  return { ...record, mods: record.mods.filter((held) => held.id !== id) };
}

/**
 * Unwinds an install that never finished, from the journal the transaction opened: what deployment
 * overwrote or removed goes back from the working directory's copies, files new with the payload are
 * deleted, the order file returns to the text it held, and so does the record. Every phase is undone
 * whichever one the failure reached - the copies say what deployment did, and the other two are snapshots -
 * so there is no phase marker to consult and no phase this misses. The working directory is cleared last:
 * it is the restore's own source.
 */
export async function restoreModInstall(
  platform: Platform,
  install: Install,
  id: string,
  now: Date = new Date(),
): Promise<void> {
  const record = await loadRecord(platform, install.path);
  assertUsable(record, id);
  const pending = record.mods.find((mod) => mod.id === id);
  if (!pending || pending.complete) throw new Error(`Nothing of "${id}" is waiting to be restored.`);

  const work = modWorkDirectory(platform, install, pending.id);
  const journal = await readTransaction(platform, install, id);
  // Without the journal there is nothing to restore from - the copies of whatever was overwritten lived in
  // the same directory. Said plainly rather than half-done: deleting the deployed files without putting the
  // originals back is not a restore, and retrying the install still reaches a finished state from here.
  if (journal === null) {
    throw new Error(
      `The working files for "${id}" are gone, so there is nothing to restore from - the cache they sat in was cleared. Retry the install instead.`,
    );
  }

  const granted = grantsFor(id);
  for (const path of pending.files) {
    if (!mayWrite(path, granted)) continue;
    const target = insidePath(platform, install.path, path);
    const kept = insidePath(platform, platform.paths.join(work, OVERWRITTEN), path);
    if (await fileExists(platform, kept)) await platform.fs.copy(kept, target);
    else await platform.fs.remove(target);
  }
  const removedRoot = platform.paths.join(work, REMOVED);
  if ((await platform.fs.stat(removedRoot))?.kind === "dir") {
    for (const path of await listRecursively(platform, removedRoot)) {
      await platform.fs.copy(
        platform.paths.join(removedRoot, ...path.split("/")),
        insidePath(platform, install.path, path),
      );
    }
  }

  // After the files, so a refused write leaves a directory already made whole - and loudly. The snapshot
  // rather than a computed order: a dat this install enabled may have been sitting there disabled, and
  // nothing readable off the folder afterwards distinguishes that from one it added.
  await restoreOrder(platform, install.path, journal.order, now);

  const restored = journal.previous === null ? withoutMod(record, id) : withMod(record, journal.previous);
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

/**
 * Whether a recorded mod may be removed, from the record's own validated fields first and the manifest
 * snapshot only for records written before those fields existed. `type: null` is "cannot be determined",
 * which is a distinct answer from "pluggable" and is treated as one.
 */
function permanenceOf(recorded: InstalledMod): {
  type: ModType | null;
  name: string;
  reason?: string;
} {
  if (recorded.type !== undefined) {
    return {
      type: recorded.type,
      name: recorded.id,
      ...(recorded.reason !== undefined ? { reason: recorded.reason } : {}),
    };
  }
  let manifest: ModManifest | null = null;
  try {
    manifest = parseManifest(new TextEncoder().encode(recorded.manifest), { version: recorded.version });
  } catch {
    // A snapshot this version cannot read gives no verdict, which the caller refuses on.
  }
  if (manifest === null) return { type: null, name: recorded.id };
  return {
    type: manifest.type,
    name: manifest.name,
    ...(manifest.reason !== undefined ? { reason: manifest.reason } : {}),
  };
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
  assertUsable(record, id);
  const recorded = record.mods.find((mod) => mod.id === id);

  // The one gate every removal surface goes through, so no menu or shortcut can offer what the type forbids.
  // A recordless permanent mod is not covered here - the interface never offers Remove for one it knows, and
  // deleting an unknown folder by name is no more than the convention below could always do.
  if (recorded) {
    const verdict = permanenceOf(recorded);
    if (verdict.type === "permanent")
      throw new Error(`${verdict.name} cannot be uninstalled: ${verdict.reason ?? "its manifest says so"}`);
    // A base mod's own answer, and it needs no declared reason: it replaced the game rather than stacking on
    // it, so there is nothing to take away and leave the install as it was. Upstream says the same thing.
    if (verdict.type === "base")
      throw new Error(
        `${verdict.name} cannot be uninstalled: it replaced this installation rather than adding to it. Starting from a fresh copy of the game is the way back.`,
      );
    // Closed rather than open: a record that cannot be read is exactly the state where a permanent mod would
    // look removable, and a wrong refusal costs a message while a wrong removal costs the install.
    if (verdict.type === null)
      throw new Error(
        `ZAX cannot tell whether "${id}" may be uninstalled: its record was written by a version this one cannot read. Update ZAX, or remove the mod by hand.`,
      );
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
  const granted = grantsFor(id);
  for (const path of files) {
    if (!mayWrite(path, granted)) continue;
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

  // The release's own declaration where the record holds one: a folder mod's deployed paths are all below
  // its entry, so deriving from them removes nothing and the line outlives the files.
  await updateOrderLines(platform, install, { drop: recorded?.entries ?? orderDats(deleted) });
  await saveRecord(platform, withoutMod(record, id));
  return { files: deleted, backup };
}

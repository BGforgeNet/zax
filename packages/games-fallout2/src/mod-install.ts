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
import type { DirEntry, DownloadOptions, Platform } from "@zax/platform";
import { preflightArchive } from "./archive-preflight.js";
import { MANIFEST_NAME, insideMods, parseManifest, type ModManifest } from "./manifest.js";
import {
  answersToId,
  listMods,
  namedInOrder,
  readMods,
  restoreOrder,
  saveMods,
  MODS_ORDER_PATH,
  type Mod,
} from "./mods.js";
import { placeFor, recommendationFor } from "./recommended-order.js";
import { loadRecord, saveRecord, type InstallRecord, type InstalledMod } from "./records.js";
import { modWorkDirectory, readTransaction, writeTransaction, type ModTransaction } from "./mod-transaction.js";
import type { ModRelease } from "./mod-feed.js";

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
 * The plan in one line, hashed. Not a cryptographic digest and not meant as one: it detects a plan that
 * moved between the confirmation and the install, and anything that could forge it could have supplied the
 * plan itself.
 */
function fingerprintOf(
  release: ModRelease,
  files: readonly PlannedFile[],
  plan: Omit<ModInstallPlan, "fingerprint" | "files">,
): string {
  return fnv1a(
    [
      release.manifest.version,
      release.archive?.digest ?? "",
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
  options?: ModProgress,
): Promise<ModInstallPlan> {
  const { manifest } = release;
  const asset = release.archive;
  if (!asset)
    throw new Error(
      `The ${manifest.name} release does not say which of its files is the mod - its manifest needs an "archive".`,
    );
  const digest = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? "")?.[1]?.toLowerCase();
  // Required rather than best-effort: the digest is what closes in-transit tampering, truncation and a
  // corrupted resume in one check, and the feeds this list trusts all publish one.
  if (!digest) throw new Error(`The ${manifest.name} release states no digest for ${asset.name}.`);

  const work = modWorkDirectory(platform, install, manifest.id);
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
  const entries = await preflightArchive(platform, archivePath, asset.name);

  // The embedded copy must match the one eligibility was decided on, byte for byte - a difference means the
  // archive is not the release the manifest described. Required only of a release that published a manifest
  // asset, where CI writes both from one source; a manifest read from the repository is tied to the tag
  // instead, and its payload is under no obligation to carry a copy. One that does is still checked.
  const embeddedAt = platform.paths.join(work, "embedded");
  await platform.archive.extract(archivePath, embeddedAt, { only: [MANIFEST_NAME] });
  const embeddedPath = platform.paths.join(embeddedAt, MANIFEST_NAME);
  if (await fileExists(platform, embeddedPath)) {
    const embedded = new TextDecoder().decode(await platform.fs.read(embeddedPath));
    if (embedded !== release.manifestText)
      throw new Error(`The manifest inside ${asset.name} is not the one its release published - refused.`);
  } else if (release.manifestFromAsset) {
    throw new Error(`${asset.name} carries no ${MANIFEST_NAME} at its root - refused.`);
  }

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
  // What this install replaces comes from the open transaction when there is one. Read from the record
  // instead, a retry would find its own unfinished entry there and conclude it replaces itself - so the
  // files a first attempt already removed would go unlisted, and their order lines would outlive them.
  const open = await readTransaction(platform, install, manifest.id);
  const replacing =
    open?.previous ??
    (await loadRecord(platform, install.path)).mods.find((mod) => mod.id === manifest.id && mod.complete);
  const removes = (replacing?.files ?? []).filter((path) => !planned.has(path.toLowerCase()));

  const orderLines = files.map((file) => ORDER_DAT.exec(file.path)?.[1]).filter((name): name is string => !!name);
  return { files, orderLines, removes, fingerprint: fingerprintOf(release, files, { orderLines, removes }) };
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
  const archivePath = platform.paths.join(work, release.archive?.name ?? "");
  const record = await loadRecord(platform, install.path);

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
      archive: {
        name: release.archive?.name ?? "",
        url: release.archive?.url ?? "",
        digest: release.archive?.digest ?? "",
      },
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
      // An upgrade's replaced files also reach the timestamped backup, as anything a save replaces does.
      if (upgrading) await platform.fs.copy(found, insidePath(platform, backup, file.path));
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

  await platform.archive.extract(archivePath, install.path, { only: plan.files.map((file) => file.path) });

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

  // Phase 4, order.
  await updateOrderLines(platform, install, { enable: plan.orderLines, drop: orderDats(plan.removes) });

  // Phase 5, commit. The working directory goes last: until it does, this is still a transaction to unwind.
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

  for (const path of pending.files) {
    if (!insideMods(path)) continue;
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
  type: "pluggable" | "permanent" | null;
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
  const recorded = record.mods.find((mod) => mod.id === id);

  // The one gate every removal surface goes through, so no menu or shortcut can offer what the type forbids.
  // A recordless permanent mod is not covered here - the interface never offers Remove for one it knows, and
  // deleting an unknown folder by name is no more than the convention below could always do.
  if (recorded) {
    const verdict = permanenceOf(recorded);
    if (verdict.type === "permanent")
      throw new Error(`${verdict.name} cannot be uninstalled: ${verdict.reason ?? "its manifest says so"}`);
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

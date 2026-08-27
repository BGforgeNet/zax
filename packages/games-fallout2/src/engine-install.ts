/**
 * Putting an engine into a game folder, replacing it with a newer build, and taking it out again.
 *
 * The shape is the sfall updater's with the merge removed - an engine ships no settings file to merge: back up
 * what is about to be replaced, unpack, copy the declared members in, record what was done.
 */

import { backupDirectory, copyTree, stamp, temporaryDirectory } from "@zax/core";
import type { Install } from "@zax/core";
import type { ArchiveEntryInfo, FileStat, Platform } from "@zax/platform";
import { preflightArchive } from "./archive-preflight.js";
import { cachedEngines, type EngineProgress, type EngineRelease } from "./engine-release.js";
import { buildFor, engineById, type EngineBuild, type EngineDefinition, type EngineMember } from "./engines.js";
import { assertUsable, loadRecord, reconcileRecord, saveRecord, type InstalledEngine } from "./records.js";

export interface EngineInstallOutcome {
  engine: string;
  release: string;
  published: string;
  /** What was deployed, relative to the install. */
  files: readonly string[];
  /** Which of those were already there, and so were copied aside first. */
  replaced: readonly string[];
  backup: string | null;
}

/** What the record says is here, judged against the directory - the same reconciliation the mods get. */
export async function installedEngines(platform: Platform, install: Install): Promise<readonly InstalledEngine[]> {
  const record = await reconcileRecord(platform, await loadRecord(platform, install.path));
  return record.engines ?? [];
}

/** The record with this engine's entry replaced by `entry`, or removed when there is none. */
function withEngine(
  engines: readonly InstalledEngine[],
  id: string,
  entry: InstalledEngine | null,
): readonly InstalledEngine[] {
  const others = engines.filter((one) => one.id !== id);
  return entry === null ? others : [...others, entry];
}

/**
 * Runs `action`, discarding the cached archive first when it throws - a cache keyed on existence would
 * otherwise fail preflight, or extraction, the same way on every attempt after this one.
 */
async function orDiscard<T>(platform: Platform, archive: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    await platform.fs.remove(archive);
    throw error;
  }
}

/**
 * Installs from a release the cache already holds, without asking the network anything. One machine downloads
 * an engine once; a second game folder is the same archive unpacked again, which is what makes running an
 * engine in a folder that has never had one a copy rather than a download.
 */
export async function installCachedEngine(
  platform: Platform,
  install: Install,
  engineId: string,
  choice: { published: string | null; pin: boolean },
  now: Date = new Date(),
  options?: EngineProgress,
): Promise<EngineInstallOutcome> {
  const engine = engineById(engineId);
  const build = buildFor(engine, platform.os, platform.arch);
  if (build === null) {
    throw new Error(`${engine.name} publishes no build ZAX can install for this machine. See ${engine.page}.`);
  }
  const cached = await cachedEngines(platform, engine, build.asset);
  const held = choice.published === null ? cached[0] : cached.find((one) => one.release.published === choice.published);
  if (held === undefined) throw new Error(`ZAX has no copy of ${engine.name} to install from. Check for one first.`);
  return deployEngine(platform, install, engine, build, held.release, held.archive, choice.pin, now, options);
}

/**
 * Unpacking an archive over a game folder and recording what that put there. Shared by the two ways a release
 * is arrived at - asking the project, or finding it already cached - because only how the archive was obtained
 * differs, and a second copy of this is a second place for the backup and the record to drift.
 */
async function deployEngine(
  platform: Platform,
  install: Install,
  engine: EngineDefinition,
  build: EngineBuild,
  release: EngineRelease,
  archive: string,
  pin: boolean,
  now: Date,
  options?: EngineProgress,
): Promise<EngineInstallOutcome> {
  const { join } = platform.paths;
  const at = stamp(now);
  const work = join(temporaryDirectory(platform), `engine-${engine.id}-${at}`);

  try {
    // Judged before it is opened: this is a third-party archive about to be unpacked over a game folder.
    const entries: readonly ArchiveEntryInfo[] = await orDiscard(platform, archive, () =>
      preflightArchive(platform, archive, `${engine.name} ${release.release}`),
    );

    // Null where the host cannot say - a check that cannot run is not a check that failed.
    //
    // Both drives, because the release lands on both: the whole archive is unpacked into ZAX's cache, and the
    // build's own files are then copied into the game folder. On most machines those are not the same drive,
    // and the cache is the one asked to hold everything.
    const needed = entries.reduce((sum, entry) => sum + entry.size, 0);
    const refuseIfShort = async (where: string) => {
      const drive = await platform.fs.freeSpace(where);
      if (drive !== null && drive < needed) {
        throw new Error(
          `${engine.name} ${release.release} needs ${needed} bytes unpacked, and the drive holding ${where} has ${drive}.`,
        );
      }
    };
    await platform.fs.mkdir(work);
    await refuseIfShort(work);
    await refuseIfShort(install.path);

    options?.onStep?.(`Unpacking ${engine.name}`);
    await orDiscard(platform, archive, () => platform.archive.extract(archive, work));

    options?.onStep?.(`Installing ${engine.name}`);
    const backup = join(backupDirectory(platform), at);
    const replaced: string[] = [];
    const files: string[] = [];

    // Written before anything is deployed and marked complete after, so a crash leaves a record saying so
    // rather than one that reads as a good copy of a release nobody can identify.
    const record = await loadRecord(platform, install.path);
    const entry: InstalledEngine = {
      id: engine.id,
      release: release.release,
      published: release.published,
      complete: false,
      files: build.members.map((member) => member.to),
      ...(release.commit !== null ? { commit: release.commit } : {}),
      // Written here as well as on the finished entry: a crash between the two must not leave the folder
      // silently following the newest build again when the user had picked this one.
      ...(pin ? { pinned: true } : {}),
    };
    await saveRecord(platform, { ...record, engines: withEngine(record.engines ?? [], engine.id, entry) });

    // Checked whole before anything is written: a release missing one declared member must fail without
    // having already moved the user's original aside for the members that were there.
    const resolved: Array<{ member: EngineMember; source: string; found: FileStat }> = [];
    for (const member of build.members) {
      const source = join(work, ...member.from.split("/"));
      const found = await platform.fs.stat(source);
      if (found === null) {
        throw new Error(
          `The ${engine.name} release does not contain ${member.from} - its layout has changed, and ZAX will not guess where that went.`,
        );
      }
      resolved.push({ member, source, found });
    }

    for (const { member, source, found } of resolved) {
      const destination = join(install.path, ...member.to.split("/"));
      const existing = await platform.fs.stat(destination);
      if (existing !== null) {
        const keep = join(backup, ...member.to.split("/"));
        if (existing.kind === "dir") {
          await copyTree(platform, destination, keep);
          // Removed rather than left for `copyTree` to merge into: it only ever adds files, so a release
          // that drops one from the bundle would otherwise leave the old copy behind inside the new one.
          await platform.fs.remove(destination);
        } else {
          await platform.fs.copy(destination, keep);
        }
        replaced.push(member.to);
      }
      if (found.kind === "dir") await copyTree(platform, source, destination);
      else await platform.fs.copy(source, destination);
      files.push(member.to);
    }

    // A binary that arrived inside an archive may arrive without its mode, and an engine that cannot be
    // executed is an install that did not happen.
    await platform.fs.makeExecutable(join(install.path, ...build.program.split("/")));

    const done: InstalledEngine = {
      ...entry,
      complete: true,
      ...(replaced.length > 0 ? { backup } : {}),
    };
    const written = await loadRecord(platform, install.path);
    await saveRecord(platform, { ...written, engines: withEngine(written.engines ?? [], engine.id, done) });

    return {
      engine: engine.id,
      release: release.release,
      published: release.published,
      files,
      replaced,
      backup: replaced.length > 0 ? backup : null,
    };
  } finally {
    await platform.fs.remove(work);
  }
}

/**
 * Sets or clears the pin on the build already deployed here, touching no file. What picking the build that is
 * in place amounts to, and what picking `Latest` undoes.
 */
export async function pinEngine(platform: Platform, install: Install, engineId: string, pin: boolean): Promise<void> {
  const record = await loadRecord(platform, install.path);
  assertUsable(record, engineId);
  const entry = (record.engines ?? []).find((one) => one.id === engineId);
  if (entry === undefined) return;
  // Rebuilt without the field rather than assigned undefined, which `exactOptionalPropertyTypes` refuses.
  const { pinned: _cleared, ...rest } = entry;
  const updated: InstalledEngine = { ...rest, ...(pin ? { pinned: true } : {}) };
  await saveRecord(platform, { ...record, engines: withEngine(record.engines ?? [], engineId, updated) });
}

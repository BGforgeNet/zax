/**
 * sfall: reading which version an install has, asking what the latest one is, and replacing one with the other.
 *
 * The update is the riskiest thing this application does - it overwrites files in the game folder - so it
 * copies every file it is about to replace into the backup directory first, and it merges the user's existing
 * `ddraw.ini` into the new one rather than shipping the release's defaults over their settings.
 */

import {
  IniDocument,
  backupDirectory,
  compareVersions,
  copyTree,
  listFilesRecursively,
  mergeIni,
  packageDirectory,
  stamp,
  temporaryDirectory,
  type MergeConflict,
} from "@zax/core";
import type { Install } from "@zax/core";
import type { DownloadOptions, Platform } from "@zax/platform";
import { installedLibraryVersion } from "./pe-version.js";

/** sfall is a DirectDraw wrapper: it ships as this DLL, and its version is the DLL's own. */
export const SFALL_LIBRARY = "ddraw.dll";

const RELEASE_INFO = "https://sourceforge.net/projects/sfall/best_release.json";

/** Every published archive, newest first. The feed caps at 100 entries and ignores a page parameter. */
const RELEASE_LIST = "https://sourceforge.net/projects/sfall/rss?path=/sfall";

export interface SfallRelease {
  version: string;
  url: string;
}

/**
 * Where a given version is published. The release feed names only the newest, but every version is a file in
 * the same directory under a predictable name, which is what makes changing to an arbitrary version possible.
 */
export function releaseUrl(version: string): string {
  return `https://sourceforge.net/projects/sfall/files/sfall/sfall_${version}.7z/download`;
}

/**
 * The shape every release name has. Checked wherever a version is about to become a path segment or a URL,
 * not only when one is read out of the feed: the interface hands versions across the process boundary, and
 * that caller is not the curated list.
 */
const VERSION_SHAPE = /^\d[\d.a-z]*$/i;

function assertVersionShape(version: string): void {
  if (!VERSION_SHAPE.test(version)) throw new Error(`Not an sfall version: "${version}"`);
}

/**
 * The versions available to change to, newest first. Read from the file listing rather than the release feed,
 * which names one: the listing is capped at its most recent 100 files, so this is not the whole history.
 */
export async function listSfallVersions(platform: Platform): Promise<readonly string[]> {
  const feed = await platform.net.fetchText(RELEASE_LIST);
  const seen = new Set<string>();
  for (const match of feed.matchAll(/sfall_(\d[^< "]*?)\.7z/g)) {
    if (match[1] && VERSION_SHAPE.test(match[1])) seen.add(match[1]);
  }
  return [...seen].sort((a, b) => compareVersions(b, a));
}

/** The installed version, or null when the install has no sfall. */
export function installedSfallVersion(platform: Platform, install: Install): Promise<string | null> {
  return installedLibraryVersion(platform, install, SFALL_LIBRARY);
}

/**
 * The current release, from the project's own release feed. The version is not published as a field: it is the
 * archive's name, `sfall_4.5.7z`, which is also what the previous implementation read.
 */
export async function latestSfall(platform: Platform): Promise<SfallRelease> {
  const body: unknown = JSON.parse(await platform.net.fetchText(RELEASE_INFO));
  const release = (body as { release?: { filename?: unknown; url?: unknown } }).release;
  const filename = typeof release?.filename === "string" ? release.filename : "";
  const url = typeof release?.url === "string" ? release.url : "";
  const version =
    filename
      .split("_")
      .pop()
      ?.replace(/\.[^.]+$/, "") ?? "";
  if (version === "" || url === "") throw new Error("The sfall release feed did not name a release.");
  return { version, url };
}

export interface SfallUpdate {
  version: string;
  /** Files replaced in the game folder, relative to it. */
  replaced: readonly string[];
  /** Where the replaced copies were put, or null when the update added files without replacing any. */
  backup: string | null;
  /** Settings both the user and the release changed. The user's won; these are worth a second look. */
  conflicts: readonly MergeConflict[];
  /** Settings the release retired that the user had left at the old default. */
  removed: readonly { section: string; key: string }[];
}

/**
 * What a long sfall operation reports as it runs. The download carries byte counts because its length is
 * knowable; the steps after it only say what they are doing, which is enough to keep a proportion stuck at
 * 100% from reading as a hang.
 */
export interface SfallProgress extends DownloadOptions {
  onStep?: (step: string) => void;
}

/**
 * Every 7z archive begins with these bytes. Worth checking because two of the ways a mirror misbehaves are
 * invisible to the transport: an error page served with a 200, and a chunked body that stops early without
 * having declared a length. Both write a file that exists, which is all the cache used to ask for.
 */
const SEVEN_ZIP_MAGIC = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];

async function isArchive(platform: Platform, path: string): Promise<boolean> {
  const found = await platform.fs.stat(path);
  if (found?.kind !== "file" || found.size < SEVEN_ZIP_MAGIC.length) return false;
  const head = await platform.fs.read(path);
  return SEVEN_ZIP_MAGIC.every((byte, at) => head[at] === byte);
}

/**
 * The cached archive for a version, downloaded if this is the first time it is asked for.
 *
 * What is on disk is checked rather than assumed, in both directions: a cached file that is not an archive is
 * discarded instead of being handed out for ever, and a fresh download that is not one fails here rather than
 * at extraction, where the message would be about 7-Zip's exit status instead of about the mirror.
 */
export async function sfallPackage(platform: Platform, version: string, options?: SfallProgress): Promise<string> {
  assertVersionShape(version);
  const path = platform.paths.join(packageDirectory(platform), `sfall-${version}.7z`);
  if (await isArchive(platform, path)) return path;
  // Something is there but it is not an archive, so it came from an answer that was not the file.
  await platform.fs.remove(path);

  // Named here rather than by the caller: an update fetches two archives - this release and the one its
  // merge compares against - and labelling both with the release's version reads as the download restarting.
  options?.onStep?.(`Downloading sfall ${version}`);

  await platform.net.download(releaseUrl(version), path, options);
  if (!(await isArchive(platform, path))) {
    await platform.fs.remove(path);
    throw new Error(
      `What ${new URL(releaseUrl(version)).host} sent for sfall ${version} was not an archive - the mirror may have answered with an error page. Trying again may reach a different one.`,
    );
  }
  return path;
}

/** sfall's own settings file, which is both what the merge works on and the only file a base is read from. */
const DDRAW_INI = "ddraw.ini";

/**
 * Extracts a release, and throws away the cached archive if it will not open. An archive can begin with the
 * right bytes and still be truncated - a chunked body that ended early is not detectable until something tries
 * to read it - and a cache keyed on existence would hand the same broken file to every attempt after this one.
 */
async function extractPackage(
  platform: Platform,
  version: string,
  destination: string,
  options?: SfallProgress,
  only?: readonly string[],
): Promise<void> {
  const archive = await sfallPackage(platform, version, options);
  try {
    await platform.archive.extract(archive, destination, only ? { only } : undefined);
  } catch (error) {
    await platform.fs.remove(archive);
    throw error;
  }
}

/** Where a version's own `ddraw.ini` is kept once it has been seen, so no later update has to fetch it again. */
function defaultsPath(platform: Platform, version: string): string {
  return platform.paths.join(packageDirectory(platform), "defaults", `ddraw-${version}.ini`);
}

/**
 * Keeps what a release ships as its `ddraw.ini`. Called while the release is unpacked and before the merge
 * rewrites that file in place, because this is the pristine copy - the next update from this version reads it
 * as the merge base and needs no second archive at all.
 */
async function rememberDefaults(platform: Platform, version: string, from: string): Promise<void> {
  if ((await platform.fs.stat(from))?.kind !== "file") return;
  await platform.fs.copy(from, defaultsPath(platform, version));
}

/**
 * What a version shipped as its own `ddraw.ini`, or null when that version's archive cannot be had. This is the
 * base a merge compares against: without it there is no telling a chosen setting from an untouched one.
 *
 * Read from the copy kept when that version was installed where there is one. Otherwise the archive is fetched
 * and only this one file is taken out of it - the whole release used to be unpacked and deleted to read 44 KB.
 */
export async function sfallDefaults(
  platform: Platform,
  version: string,
  options?: SfallProgress,
): Promise<IniDocument | null> {
  // Before the try below: a malformed version is a caller error to surface, not a missing base to absorb.
  assertVersionShape(version);
  const { join } = platform.paths;
  const kept = defaultsPath(platform, version);
  if ((await platform.fs.stat(kept))?.kind === "file") return IniDocument.parseBytes(await platform.fs.read(kept));

  const work = join(temporaryDirectory(platform), `sfall-defaults-${version}`);
  try {
    await extractPackage(platform, version, work, options, [DDRAW_INI]);
    const ini = join(work, DDRAW_INI);
    if ((await platform.fs.stat(ini))?.kind !== "file") return null;
    const content = await platform.fs.read(ini);
    await platform.fs.write(kept, content);
    return IniDocument.parseBytes(content);
  } catch {
    // An archive that will not download or will not open is a missing base, not a failed update: the merge
    // falls back to carrying every value across, which is what it did before any of this existed.
    return null;
  } finally {
    await platform.fs.remove(work);
  }
}

/**
 * Downloads a release, merges the install's `ddraw.ini` into the one it ships, and copies the result over the
 * install - after copying every file it is about to overwrite into the backup directory.
 */
export async function updateSfall(
  platform: Platform,
  install: Install,
  version: string,
  now: Date = new Date(),
  options?: SfallProgress,
): Promise<SfallUpdate> {
  // This is what the process boundary calls, so the shape is checked here too, not only in the path builders.
  assertVersionShape(version);
  const { join } = platform.paths;
  const at = stamp(now);
  const work = join(temporaryDirectory(platform), `sfall-${at}`);
  const unpacked = join(work, "unpacked");

  try {
    await extractPackage(platform, version, unpacked, options);
    // Before the merge, which rewrites this file in place: what is on disk now is what the release ships, and
    // that is what the next update from this version needs as its base.
    await rememberDefaults(platform, version, join(unpacked, DDRAW_INI));

    // The version being replaced, read before anything is written over it.
    const previous = await installedSfallVersion(platform, install);
    options?.onStep?.("Merging your settings");
    const merge = await mergeSettings(platform, install, unpacked, previous, options);

    options?.onStep?.("Backing up the files being replaced");
    const incoming = await listFilesRecursively(platform, unpacked);
    const replaced: string[] = [];
    const backup = join(backupDirectory(platform), at);
    for (const file of incoming) {
      const existing = join(install.path, ...file.split("/"));
      if ((await platform.fs.stat(existing))?.kind !== "file") continue;
      await platform.fs.copy(existing, join(backup, ...file.split("/")));
      replaced.push(file);
    }

    options?.onStep?.(`Installing sfall ${version}`);
    await copyTree(platform, unpacked, install.path);
    return {
      version,
      replaced,
      backup: replaced.length > 0 ? backup : null,
      conflicts: merge.conflicts,
      removed: merge.removed,
    };
  } finally {
    await platform.fs.remove(work);
  }
}

/**
 * Carries the install's settings into the release's `ddraw.ini`. That direction rather than the reverse: the
 * new file's comments are sfall's documentation and its keys are what this release understands, while only the
 * values are the user's.
 *
 * What the version being replaced shipped decides the rest - see `mergeIni`. Reading it costs a download the
 * first time and nothing after, since the archive is kept.
 */
async function mergeSettings(
  platform: Platform,
  install: Install,
  unpacked: string,
  previous: string | null,
  options?: SfallProgress,
): Promise<{ conflicts: readonly MergeConflict[]; removed: readonly { section: string; key: string }[] }> {
  const { join } = platform.paths;
  const empty = { conflicts: [], removed: [] };
  const mine = join(install.path, DDRAW_INI);
  const theirs = join(unpacked, DDRAW_INI);
  if ((await platform.fs.stat(mine))?.kind !== "file") return empty;
  if ((await platform.fs.stat(theirs))?.kind !== "file") return empty;

  const base = previous === null ? null : await sfallDefaults(platform, previous, options);
  const outcome = mergeIni(
    IniDocument.parseBytes(await platform.fs.read(theirs)),
    IniDocument.parseBytes(await platform.fs.read(mine)),
    base,
  );
  await platform.fs.write(theirs, outcome.document.toBytes());
  return { conflicts: outcome.conflicts, removed: outcome.removed };
}

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
import type { Platform } from "@zax/platform";
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
 * The versions available to change to, newest first. Read from the file listing rather than the release feed,
 * which names one: the listing is capped at its most recent 100 files, so this is not the whole history.
 */
export async function listSfallVersions(platform: Platform): Promise<readonly string[]> {
  const feed = await platform.net.fetchText(RELEASE_LIST);
  const seen = new Set<string>();
  for (const match of feed.matchAll(/sfall_(\d[^< "]*?)\.7z/g)) if (match[1]) seen.add(match[1]);
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
  const version = filename.split("_").pop()?.replace(/\.[^.]+$/, "") ?? "";
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

/** The cached archive for a version, downloaded if this is the first time it is asked for. */
export async function sfallPackage(platform: Platform, version: string): Promise<string> {
  const path = platform.paths.join(packageDirectory(platform), `sfall-${version}.7z`);
  if ((await platform.fs.stat(path))?.kind === "file") return path;
  await platform.net.download(releaseUrl(version), path);
  return path;
}

/**
 * What a version shipped as its own `ddraw.ini`, or null when that version's archive cannot be had. This is the
 * base a merge compares against: without it there is no telling a chosen setting from an untouched one.
 */
export async function sfallDefaults(platform: Platform, version: string): Promise<IniDocument | null> {
  const { join } = platform.paths;
  const work = join(temporaryDirectory(platform), `sfall-defaults-${version}`);
  try {
    await platform.archive.extract(await sfallPackage(platform, version), work);
    const ini = join(work, "ddraw.ini");
    if ((await platform.fs.stat(ini))?.kind !== "file") return null;
    return IniDocument.parseBytes(await platform.fs.read(ini));
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
): Promise<SfallUpdate> {
  const { join } = platform.paths;
  const at = stamp(now);
  const work = join(temporaryDirectory(platform), `sfall-${at}`);
  const unpacked = join(work, "unpacked");

  try {
    await platform.archive.extract(await sfallPackage(platform, version), unpacked);

    // The version being replaced, read before anything is written over it.
    const previous = await installedSfallVersion(platform, install);
    const merge = await mergeSettings(platform, install, unpacked, previous);

    const incoming = await listFilesRecursively(platform, unpacked);
    const replaced: string[] = [];
    const backup = join(backupDirectory(platform), at);
    for (const file of incoming) {
      const existing = join(install.path, ...file.split("/"));
      if ((await platform.fs.stat(existing))?.kind !== "file") continue;
      await platform.fs.copy(existing, join(backup, ...file.split("/")));
      replaced.push(file);
    }

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
): Promise<{ conflicts: readonly MergeConflict[]; removed: readonly { section: string; key: string }[] }> {
  const { join } = platform.paths;
  const empty = { conflicts: [], removed: [] };
  const mine = join(install.path, "ddraw.ini");
  const theirs = join(unpacked, "ddraw.ini");
  if ((await platform.fs.stat(mine))?.kind !== "file") return empty;
  if ((await platform.fs.stat(theirs))?.kind !== "file") return empty;

  const base = previous === null ? null : await sfallDefaults(platform, previous);
  const outcome = mergeIni(
    IniDocument.parseBytes(await platform.fs.read(theirs)),
    IniDocument.parseBytes(await platform.fs.read(mine)),
    base,
  );
  await platform.fs.write(theirs, outcome.document.toBytes());
  return { conflicts: outcome.conflicts, removed: outcome.removed };
}

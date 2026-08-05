/**
 * sfall: reading which version an install has, asking what the latest one is, and replacing one with the other.
 *
 * The update is the riskiest thing this application does - it overwrites files in the game folder - so it
 * copies every file it is about to replace into the backup directory first, and it merges the user's existing
 * `ddraw.ini` into the new one rather than shipping the release's defaults over their settings.
 */

import { IniDocument, backupDirectory, copyTree, listFilesRecursively, stamp, temporaryDirectory } from "@zax/core";
import type { Install } from "@zax/core";
import type { Platform } from "@zax/platform";
import { NtExecutable, NtExecutableResource } from "pe-library";
import { Resource } from "resedit";

/** sfall is a DirectDraw wrapper: it ships as this DLL, and its version is the DLL's own. */
export const SFALL_LIBRARY = "ddraw.dll";

const RELEASE_INFO = "https://sourceforge.net/projects/sfall/best_release.json";

export interface SfallRelease {
  version: string;
  url: string;
}

/**
 * The version recorded in the DLL's own resources, or null when the file is not a PE image with one - which is
 * also the answer for an install with no sfall at all. The caller reports "unknown" rather than guessing.
 */
export function readSfallVersion(library: Uint8Array): string | null {
  try {
    const image = library.buffer.slice(library.byteOffset, library.byteOffset + library.byteLength) as ArrayBuffer;
    const resources = NtExecutableResource.from(NtExecutable.from(image, { ignoreCert: true }));
    for (const info of Resource.VersionInfo.fromEntries(resources.entries)) {
      for (const language of info.getAllLanguagesForStringValues()) {
        const version = info.getStringValues(language)["FileVersion"];
        if (version) return version.trim();
      }
    }
    return null;
  } catch {
    // A file that is not a PE image, or one without a version resource. Either way there is nothing to report.
    return null;
  }
}

/** The installed version, or null when the install has no sfall. */
export async function installedSfallVersion(platform: Platform, install: Install): Promise<string | null> {
  const path = platform.paths.join(install.path, SFALL_LIBRARY);
  if ((await platform.fs.stat(path))?.kind !== "file") return null;
  return readSfallVersion(await platform.fs.read(path));
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
}

/**
 * Downloads a release, merges the install's `ddraw.ini` into the one it ships, and copies the result over the
 * install - after copying every file it is about to overwrite into the backup directory.
 */
export async function updateSfall(
  platform: Platform,
  install: Install,
  release: SfallRelease,
  now: Date = new Date(),
): Promise<SfallUpdate> {
  const { join } = platform.paths;
  const at = stamp(now);
  const work = join(temporaryDirectory(platform), `sfall-${at}`);
  const unpacked = join(work, "unpacked");

  try {
    const archive = join(work, "sfall.7z");
    await platform.net.download(release.url, archive);
    await platform.archive.extract(archive, unpacked);

    await mergeSettings(platform, install, unpacked);

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
    return { version: release.version, replaced, backup: replaced.length > 0 ? backup : null };
  } finally {
    await platform.fs.remove(work);
  }
}

/**
 * Carries the install's settings into the release's `ddraw.ini`. That direction rather than the reverse: the
 * new file's comments are sfall's documentation and its keys are what this release understands, while only the
 * values are the user's. A key the user has that the release dropped is still written, so nothing is lost
 * silently.
 */
async function mergeSettings(platform: Platform, install: Install, unpacked: string): Promise<void> {
  const { join } = platform.paths;
  const mine = join(install.path, "ddraw.ini");
  const theirs = join(unpacked, "ddraw.ini");
  if ((await platform.fs.stat(mine))?.kind !== "file") return;
  if ((await platform.fs.stat(theirs))?.kind !== "file") return;

  const merged = IniDocument.parseBytes(await platform.fs.read(theirs));
  for (const entry of IniDocument.parseBytes(await platform.fs.read(mine)).entries()) {
    merged.set(entry.section, entry.key, entry.value);
  }
  await platform.fs.write(theirs, merged.toBytes());
}

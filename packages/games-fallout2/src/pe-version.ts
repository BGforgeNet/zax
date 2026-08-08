/**
 * The version a Windows library records in its own resources.
 *
 * Both components ZAX reports on - sfall and the High Resolution Patch - ship as a DLL whose version appears
 * nowhere in its filename, so the image itself is the only thing that knows which one an install has.
 */

import type { Install } from "@zax/core";
import type { Platform } from "@zax/platform";
import { NtExecutable, NtExecutableResource } from "pe-library";
import { Resource } from "resedit";

/**
 * The version resource holds free text, formatted by whoever built the library: sfall writes "4.5", the
 * hi-res patch writes "4, 1, 8, 0". Separators become dots and a trailing zero build field is dropped, so both
 * read as the version their project publishes and compare against the versions their feeds name.
 */
function normalize(version: string): string {
  const parts = version.trim().split(/\s*[,.]\s*/);
  while (parts.length > 2 && /^0+$/.test(parts[parts.length - 1] ?? "")) parts.pop();
  return parts.join(".");
}

/**
 * The version recorded in a library's own resources, or null when the file is not a PE image with one. The
 * caller reports "unknown" rather than guessing.
 */
export function readFileVersion(image: Uint8Array): string | null {
  try {
    const buffer = image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength) as ArrayBuffer;
    const resources = NtExecutableResource.from(NtExecutable.from(buffer, { ignoreCert: true }));
    for (const info of Resource.VersionInfo.fromEntries(resources.entries)) {
      for (const language of info.getAllLanguagesForStringValues()) {
        const version = info.getStringValues(language)["FileVersion"];
        if (version) return normalize(version);
      }
    }
    return null;
  } catch {
    // A file that is not a PE image, or one without a version resource. Either way there is nothing to report.
    return null;
  }
}

/** The version of one of the install's libraries, or null when the install does not have it. */
export async function installedLibraryVersion(
  platform: Platform,
  install: Install,
  library: string,
): Promise<string | null> {
  const path = platform.paths.join(install.path, library);
  if ((await platform.fs.stat(path))?.kind !== "file") return null;
  return readFileVersion(await platform.fs.read(path));
}

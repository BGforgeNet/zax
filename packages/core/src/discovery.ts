/**
 * Finding installs on a real machine. The rule for *what counts as* an install lives in `install.ts` and takes
 * directory listings; this module is the part that has to read them.
 */

import type { Platform } from "@zax/platform";
import { SCAN_LOCATIONS, detectGameType, type GameType, type Install } from "./install.js";

/**
 * What kind of install sits at a path, or null when it is not one - including when the path is gone or is not a
 * directory at all, which is what a recorded install on an unmounted drive looks like.
 */
export async function identifyInstall(platform: Platform, path: string): Promise<GameType | null> {
  const root = await listNames(platform, path);
  if (root === null) return null;
  const mods = (await listNames(platform, platform.paths.join(path, "mods"))) ?? [];
  return detectGameType(root, mods);
}

async function listNames(platform: Platform, path: string): Promise<string[] | null> {
  const found = await platform.fs.stat(path);
  if (found?.kind !== "dir") return null;
  return (await platform.fs.list(path)).map((entry) => entry.name);
}

/**
 * Where an unattended scan looks. On Windows that is each drive root; elsewhere it is both the home directory,
 * where a native build lives, and the Wine prefix's C: drive, where a Windows build does. The previous
 * implementation looked only inside the Wine prefix, which finds nothing for anyone running fallout2-ce.
 */
export function scanRoots(platform: Platform, winePrefix?: string): string[] {
  const { join, home } = platform.paths;
  if (platform.os === "windows") return ["C:\\", "D:\\"];
  return [home, join(winePrefix ?? join(home, ".wine"), "drive_c")];
}

/**
 * Installs found at the known locations and not already on the list. Directory names are compared
 * case-insensitively by trying both spellings, since a Wine drive may hold either.
 */
export async function scanForInstalls(
  platform: Platform,
  known: readonly Install[],
  winePrefix?: string,
): Promise<Install[]> {
  const seen = new Set(known.map((install) => install.path));
  const found: Install[] = [];

  for (const root of scanRoots(platform, winePrefix)) {
    for (const location of SCAN_LOCATIONS) {
      for (const spelling of [location, location.toLowerCase()]) {
        const path = platform.paths.join(root, ...spelling.split("/"));
        if (seen.has(path)) continue;
        const type = await identifyInstall(platform, path);
        if (type === null) continue;
        seen.add(path);
        found.push({ path, type });
      }
    }
  }
  return found;
}

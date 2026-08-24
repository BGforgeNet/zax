/**
 * The archive a bug report attaches. What goes in is a fact about this game's layout - where sfall writes its
 * logs, that `mods/` holds the mod files, that saves live under `data/` in a directory whose case varies - so
 * it lives here rather than in the view that offers the button.
 */

import { debugDirectory, listFilesRecursively, logFile, stamp, temporaryDirectory } from "@zax/core";
import type { Install } from "@zax/core";
import type { ArchiveEntry, Platform } from "@zax/platform";
import { WINE_LOG } from "./launch.js";
import { MODS_ORDER_FILE } from "./mods.js";

/** Fallout 2 installers disagree about the case of this directory, and both spellings occur in the wild. */
const SAVE_DIRECTORIES = ["data/SAVEGAME", "data/savegame"];

/** Files from the game folder worth having, beyond every `.ini` and `.cfg`. */
export const WANTED: readonly string[] = ["ddraw.dll", "debug.log", "sfall-log.txt", WINE_LOG];

const interesting = (name: string) => {
  const lower = name.toLowerCase();
  return lower.endsWith(".ini") || lower.endsWith(".cfg") || WANTED.includes(lower);
};

/** Where this install keeps its saves, or null when it has no save directory yet. */
export async function saveDirectory(platform: Platform, install: Install): Promise<string | null> {
  for (const candidate of SAVE_DIRECTORIES) {
    const path = platform.paths.join(install.path, ...candidate.split("/"));
    if ((await platform.fs.stat(path))?.kind === "dir") return path;
  }
  return null;
}

/** The save slots the user can choose to attach, in the order the game numbers them. */
export async function listSaves(platform: Platform, install: Install): Promise<string[]> {
  const directory = await saveDirectory(platform, install);
  if (directory === null) return [];
  const entries = await platform.fs.list(directory);
  return entries
    .filter((entry) => entry.kind === "dir" && entry.name.toUpperCase().startsWith("SLOT"))
    .map((entry) => entry.name)
    .sort();
}

export interface DebugPackage {
  /** Where the archive was written. */
  path: string;
  /** What went into it, by the name it has inside the archive. */
  contents: readonly string[];
}

/**
 * Collects the configs, logs and chosen saves into one zip under the debug directory.
 *
 * The two listings are generated rather than collected: which files an install has is exactly the question a
 * bug report cannot answer from the configs alone, and a mod that failed to install shows up as an absence.
 */
export async function createDebugPackage(
  platform: Platform,
  install: Install,
  saves: readonly string[] = [],
  now: Date = new Date(),
): Promise<DebugPackage> {
  const { join } = platform.paths;
  const at = stamp(now);
  const scratch = join(temporaryDirectory(platform), `debug-${at}`);
  const entries: ArchiveEntry[] = [];

  const listing = async (directory: string, name: string): Promise<void> => {
    if ((await platform.fs.stat(directory))?.kind !== "dir") return;
    const names = (await platform.fs.list(directory)).map((entry) => entry.name).sort();
    const path = join(scratch, name);
    await platform.fs.write(path, new TextEncoder().encode(names.join("\n")));
    entries.push({ source: path, name });
  };

  try {
    for (const entry of await platform.fs.list(install.path)) {
      if (entry.kind === "file" && interesting(entry.name)) {
        entries.push({ source: join(install.path, entry.name), name: entry.name });
      }
    }
    await listing(install.path, "game.txt");

    const mods = join(install.path, "mods");
    if ((await platform.fs.stat(mods))?.kind === "dir") {
      for (const entry of await platform.fs.list(mods)) {
        // The load order by name as well as by suffix: it is the only file saying which of the mods listed
        // beside it are enabled and in what order the loader takes them, which is the question a conflict asks.
        const wanted =
          entry.name.toLowerCase().endsWith(".ini") || entry.name.toLowerCase() === MODS_ORDER_FILE.toLowerCase();
        if (entry.kind === "file" && wanted) {
          entries.push({ source: join(mods, entry.name), name: `mods/${entry.name}` });
        }
      }
      await listing(mods, "mods.txt");
    }

    // ZAX's own record of what it did - failed and resumed downloads above all, which nothing in the game
    // folder witnesses and a report from a poor connection cannot reconstruct. Absent until something has
    // been written, and an install that has had no trouble legitimately has none.
    const log = logFile(platform);
    if ((await platform.fs.stat(log))?.kind === "file") {
      entries.push({ source: log, name: platform.paths.basename(log) });
    }

    const savesAt = await saveDirectory(platform, install);
    if (savesAt !== null) {
      for (const slot of saves) {
        const from = join(savesAt, slot);
        for (const file of await listFilesRecursively(platform, from)) {
          entries.push({ source: join(from, ...file.split("/")), name: `${slot}/${file}` });
        }
      }
    }

    const path = join(debugDirectory(platform), `zax_debug_${at}.zip`);
    await platform.archive.createZip(path, entries);
    return { path, contents: entries.map((entry) => entry.name) };
  } finally {
    await platform.fs.remove(scratch);
  }
}

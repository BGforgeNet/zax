/**
 * Reading and writing a game's config files.
 *
 * Two things make this more than a write. The files are the user's and are routinely hand-edited, so a file
 * that changed underneath the open window is reported rather than overwritten. And every file is copied to the
 * backup directory before the first write, so a bad save is recoverable without the user having kept a copy.
 */

import type { Platform } from "@zax/platform";
import { backupDirectory } from "./directories.js";
import { IniDocument } from "./ini.js";
import { stamp } from "./stamp.js";
import { latin1 } from "./text.js";

/** One key to write. The catalog maps a setting id to this; core does not know what a setting is. */
export interface ConfigChange {
  file: string;
  section: string;
  key: string;
  value: string;
}

export interface ConfigFileContents {
  /** Contents as latin1, one character per byte, or undefined when the file is not there. */
  [file: string]: string | undefined;
}

/** Reads the named files from an install. A file that is not there reads as undefined rather than empty. */
export async function loadConfigFiles(
  platform: Platform,
  installPath: string,
  names: readonly string[],
): Promise<ConfigFileContents> {
  const out: ConfigFileContents = {};
  for (const name of names) {
    const path = platform.paths.join(installPath, name);
    out[name] = (await platform.fs.stat(path))?.kind === "file" ? latin1(await platform.fs.read(path)) : undefined;
  }
  return out;
}

export type SaveOutcome =
  | { ok: true; files: readonly string[]; backup: string | null }
  /**
   * Files that changed on disk since they were read. Nothing is written: applying half a save and reporting the
   * other half would leave the user with settings from two different intentions and no way to tell which.
   */
  | { ok: false; changed: readonly string[] };

export interface SaveRequest {
  installPath: string;
  /** The contents the edits were made against, as `loadConfigFiles` returned them. */
  original: ConfigFileContents;
  changes: readonly ConfigChange[];
}

/**
 * Writes the changed keys back, one line each, leaving every other line of the file exactly as it was.
 *
 * `now` is passed rather than read so the backup directory a save produces is predictable in a test; callers
 * pass the current time.
 */
export async function saveConfigFiles(
  platform: Platform,
  request: SaveRequest,
  now: Date = new Date(),
): Promise<SaveOutcome> {
  const { installPath, original, changes } = request;
  const files = [...new Set(changes.map((change) => change.file))].sort();
  if (files.length === 0) return { ok: true, files: [], backup: null };

  const current: Record<string, string | undefined> = {};
  const changed: string[] = [];
  for (const file of files) {
    const path = platform.paths.join(installPath, file);
    const found = (await platform.fs.stat(path))?.kind === "file" ? latin1(await platform.fs.read(path)) : undefined;
    current[file] = found;
    if (found !== original[file]) changed.push(file);
  }
  if (changed.length > 0) return { ok: false, changed };

  const backup = platform.paths.join(backupDirectory(platform), stamp(now));
  for (const file of files) {
    if (current[file] === undefined) continue;
    await platform.fs.copy(platform.paths.join(installPath, file), platform.paths.join(backup, file));
  }

  for (const file of files) {
    const document = IniDocument.parse(current[file] ?? "");
    for (const change of changes) {
      if (change.file === file) document.set(change.section, change.key, change.value);
    }
    await platform.fs.write(platform.paths.join(installPath, file), document.toBytes());
  }

  return { ok: true, files, backup };
}

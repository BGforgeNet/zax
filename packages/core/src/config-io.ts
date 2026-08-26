/**
 * Reading and writing a game's config files.
 *
 * What makes this more than a write: the files are the user's and are routinely hand-edited, so a file that
 * changed underneath the open window is reported rather than overwritten.
 *
 * No copy is taken aside: a save rewrites one line per changed key, and doing it on every change filled the
 * backup directory with copies nothing ever pointed at. Backups belong to the paths that replace whole files -
 * installing and removing mods, engines and sfall.
 */

import type { Platform } from "@zax/platform";
import { IniDocument } from "./ini.js";
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

/**
 * Where a file sits inside an install, for the few whose location is not their own name - one of them is kept
 * in a directory another file's settings name, so it cannot be addressed by its path. A name this does not
 * mention is its own path.
 */
export type ConfigFilePaths = Readonly<Record<string, string>>;

const pathOf = (paths: ConfigFilePaths, name: string) => paths[name] ?? name;

/** Reads the named files from an install. A file that is not there reads as undefined rather than empty. */
export async function loadConfigFiles(
  platform: Platform,
  installPath: string,
  names: readonly string[],
  paths: ConfigFilePaths = {},
): Promise<ConfigFileContents> {
  const out: ConfigFileContents = {};
  for (const name of names) {
    const path = platform.paths.join(installPath, pathOf(paths, name));
    out[name] = (await platform.fs.stat(path))?.kind === "file" ? latin1(await platform.fs.read(path)) : undefined;
  }
  return out;
}

export type SaveOutcome =
  | { ok: true; files: readonly string[] }
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
  /** The same map `loadConfigFiles` was given, so a save writes where the read read. */
  paths?: ConfigFilePaths;
}

/** Writes the changed keys back, one line each, leaving every other line of the file exactly as it was. */
export async function saveConfigFiles(platform: Platform, request: SaveRequest): Promise<SaveOutcome> {
  const { installPath, original, changes, paths = {} } = request;
  const files = [...new Set(changes.map((change) => change.file))].sort();
  if (files.length === 0) return { ok: true, files: [] };

  const current: Record<string, string | undefined> = {};
  const changed: string[] = [];
  for (const file of files) {
    const path = platform.paths.join(installPath, pathOf(paths, file));
    const found = (await platform.fs.stat(path))?.kind === "file" ? latin1(await platform.fs.read(path)) : undefined;
    current[file] = found;
    if (found !== original[file]) changed.push(file);
  }
  if (changed.length > 0) return { ok: false, changed };

  for (const file of files) {
    const document = IniDocument.parse(current[file] ?? "");
    for (const change of changes) {
      if (change.file === file) document.set(change.section, change.key, change.value);
    }
    await platform.fs.write(platform.paths.join(installPath, pathOf(paths, file)), document.toBytes());
  }

  return { ok: true, files };
}

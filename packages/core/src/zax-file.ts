/**
 * `zax.yml`: the installs ZAX knows about and the application's own preferences. The file is the previous
 * implementation's, key for key, so an existing one loads rather than the application starting over with an
 * empty list - which is a silent failure, since an empty list looks exactly like a first run.
 *
 * What kind of install sits at a path is *not* stored. It is decided by reading the directory, so a mod
 * installed since the file was written is reflected rather than remembered wrongly.
 */

import { parse, stringify } from "yaml";
import type { Theme, WineConfig } from "./install.js";

export interface StoredInstall {
  path: string;
  /** Only what the user typed: an install left at its type's name stores nothing, so it follows the type. */
  alias?: string;
  wine?: WineConfig;
}

export interface ZaxFile {
  installs: readonly StoredInstall[];
  theme: Theme;
  /** Whether an edit is written as it is made, rather than waiting for the Save button. */
  autosave: boolean;
}

const THEMES: readonly string[] = ["light", "dark", "system"];

/** The empty state, which is also what a first run has. */
export const EMPTY_ZAX_FILE: ZaxFile = { installs: [], theme: "system", autosave: false };

function trimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === "" ? undefined : text;
}

/**
 * Reads the file, keeping whatever is well-formed and dropping the rest. Entries are skipped one at a time
 * rather than the file being rejected whole: one hand-edited line should not cost the user every other install.
 *
 * Throws only when the YAML itself will not parse, which the caller reports - silently returning an empty state
 * there would look like a first run and then overwrite the file the user was trying to keep.
 */
export function parseZaxFile(text: string): ZaxFile {
  const raw: unknown = parse(text);
  if (raw === null || typeof raw !== "object") return EMPTY_ZAX_FILE;
  const record = raw as Record<string, unknown>;

  const installs: StoredInstall[] = [];
  for (const entry of Array.isArray(record["games"]) ? record["games"] : []) {
    if (entry === null || typeof entry !== "object") continue;
    const fields = entry as Record<string, unknown>;
    const path = trimmed(fields["path"]);
    if (path === undefined) continue;
    const alias = trimmed(fields["alias"]);
    const prefix = trimmed(fields["wine_prefix"]);
    const debug = trimmed(fields["wine_debug"]);
    const wine: WineConfig = { ...(prefix ? { prefix } : {}), ...(debug ? { debug } : {}) };
    installs.push({ path, ...(alias ? { alias } : {}), ...(Object.keys(wine).length ? { wine } : {}) });
  }

  const theme = record["theme"];
  return {
    installs,
    theme: typeof theme === "string" && THEMES.includes(theme) ? (theme as Theme) : "system",
    // Anything but a true written by this application means off: the safe reading of a hand-edited file.
    autosave: record["autosave"] === true,
  };
}

/**
 * Writes the file back. Empty Wine fields are dropped rather than written blank, so an install the user never
 * configured does not accumulate two empty keys every time anything else is saved.
 */
export function formatZaxFile(state: ZaxFile): string {
  const games = [...state.installs]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((install) => ({
      path: install.path,
      ...(install.alias ? { alias: install.alias } : {}),
      ...(install.wine?.prefix ? { wine_prefix: install.wine.prefix } : {}),
      ...(install.wine?.debug ? { wine_debug: install.wine.debug } : {}),
    }));
  // Unwrapped: the emitter folds a long scalar across lines by default, which is lossless but splits an install
  // path over two lines in a file people hand-edit.
  return stringify({ games, theme: state.theme, autosave: state.autosave }, { lineWidth: 0 });
}

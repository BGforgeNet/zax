/**
 * Loading and saving the application's own state. The file format lives in `zax-file.ts`; this is the part that
 * reaches the disk and resolves what each stored path actually holds.
 */

import type { Platform } from "@zax/platform";
import { identifyInstall } from "./discovery.js";
import type { Install, Theme } from "./install.js";
import { EMPTY_ZAX_FILE, formatZaxFile, parseZaxFile, type StoredInstall } from "./zax-file.js";

export const ZAX_FILE_NAME = "zax.yml";

export interface AppState {
  /** Installs that are on the list and readable now, with the type read from the directory. */
  installs: readonly Install[];
  /**
   * Installs on the list that could not be read - an unplugged drive, a folder moved since last time. Kept
   * rather than dropped, because writing the file back without them would turn a drive being offline for one
   * session into losing the entry permanently.
   */
  unavailable: readonly StoredInstall[];
  theme: Theme;
  autosave: boolean;
}

export const EMPTY_STATE: AppState = { installs: [], unavailable: [], theme: "system", autosave: false };

export interface LoadedState {
  state: AppState;
  /**
   * Why the file could not be read, when it could not be. The caller shows this and does not overwrite: an
   * unreadable file replaced by an empty one is the user's install list gone.
   */
  problem?: string;
}

function zaxFilePath(platform: Platform): string {
  return platform.paths.join(platform.paths.config, ZAX_FILE_NAME);
}

const utf8 = new TextDecoder();

export async function loadState(platform: Platform): Promise<LoadedState> {
  const path = zaxFilePath(platform);
  if ((await platform.fs.stat(path)) === null) return { state: EMPTY_STATE };

  let stored;
  try {
    stored = parseZaxFile(utf8.decode(await platform.fs.read(path)));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { state: EMPTY_STATE, problem: `${path} could not be read: ${reason}` };
  }

  const installs: Install[] = [];
  const unavailable: StoredInstall[] = [];
  for (const entry of stored.installs) {
    const type = await identifyInstall(platform, entry.path);
    if (type === null) unavailable.push(entry);
    else {
      installs.push({
        path: entry.path,
        type,
        ...(entry.alias ? { alias: entry.alias } : {}),
        ...(entry.wine ? { wine: entry.wine } : {}),
      });
    }
  }

  return { state: { installs, unavailable, theme: stored.theme, autosave: stored.autosave } };
}

export async function saveState(platform: Platform, state: AppState): Promise<void> {
  const stored: StoredInstall[] = [
    ...state.installs.map((install) => ({
      path: install.path,
      ...(install.alias ? { alias: install.alias } : {}),
      ...(install.wine ? { wine: install.wine } : {}),
    })),
    ...state.unavailable,
  ];
  const text = formatZaxFile({ ...EMPTY_ZAX_FILE, installs: stored, theme: state.theme, autosave: state.autosave });
  await platform.fs.write(zaxFilePath(platform), new TextEncoder().encode(text));
}

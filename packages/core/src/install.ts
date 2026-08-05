/**
 * The per-user state that is not a game config file: which installs ZAX knows about, how to launch each, and
 * the application's own preferences. The previous implementation kept this in `zax.yml` under the platform
 * config directory, and the shape here is the same one so an existing file still loads.
 */

/** Which mod is installed, decided by what sits in `mods/` rather than by anything the user tells us. */
export type GameType = "fallout2" | "fallout2upu" | "fallout2rpu";

export const GAME_TYPES: Readonly<Record<GameType, { label: string; badge: string }>> = {
  fallout2: { label: "Fallout 2", badge: "vanilla" },
  fallout2upu: { label: "Fallout 2 with the unofficial patch", badge: "upu" },
  fallout2rpu: { label: "Fallout 2 with the restoration project", badge: "rpu" },
};

/**
 * Wine settings are per install rather than global: one install can be a Windows build under its own prefix
 * while another is native, and a prefix that is right for one is wrong for the other.
 */
export interface WineConfig {
  prefix?: string;
  debug?: string;
}

export interface Install {
  path: string;
  type: GameType;
  wine?: WineConfig;
}

/**
 * The type of install at a directory, or null when it is not a Fallout 2 install at all.
 *
 * Takes listings rather than a path so the rule is testable without a filesystem: deciding what counts as an
 * install is domain logic, and only reading the directory needs the platform. Matching is case-insensitive
 * because the same install reads back differently through Wine than it does natively.
 */
export function detectGameType(rootEntries: readonly string[], modEntries: readonly string[]): GameType | null {
  const root = new Set(rootEntries.map((f) => f.toLowerCase()));
  if (!root.has("fallout2.exe")) return null;
  const mods = new Set(modEntries.map((f) => f.toLowerCase()));
  if (mods.has("rpu.dat")) return "fallout2rpu";
  if (mods.has("upu.dat")) return "fallout2upu";
  return "fallout2";
}

/** Installs are held sorted by path, so the list does not reorder itself as one is added or removed. */
const byPath = (a: Install, b: Install) => a.path.localeCompare(b.path);

export type AddResult = { ok: true; installs: readonly Install[] } | { ok: false; reason: string };

/**
 * Adds an install, refusing a duplicate rather than silently merging it - the same path added twice would
 * otherwise give two rows that edit one set of files and disagree about what is on disk.
 */
export function addInstall(installs: readonly Install[], candidate: Install): AddResult {
  if (installs.some((g) => g.path === candidate.path)) {
    return { ok: false, reason: "That install is already on the list." };
  }
  return { ok: true, installs: [...installs, candidate].sort(byPath) };
}

export function removeInstall(installs: readonly Install[], path: string): readonly Install[] {
  return installs.filter((g) => g.path !== path);
}

/**
 * Wine settings are dropped rather than stored empty, so an install the user never configured does not carry
 * two blank keys, and clearing a field removes it instead of pinning it to "".
 */
export function withWine(installs: readonly Install[], path: string, wine: WineConfig): readonly Install[] {
  const prefix = wine.prefix?.trim() ?? "";
  const debug = wine.debug?.trim() ?? "";
  const kept: WineConfig = { ...(prefix ? { prefix } : {}), ...(debug ? { debug } : {}) };
  return installs.map((g) =>
    g.path !== path ? g : { path: g.path, type: g.type, ...(Object.keys(kept).length ? { wine: kept } : {}) },
  );
}

/**
 * Where an unattended scan looks, relative to each drive on Windows and to the Wine prefix elsewhere. Data
 * rather than code so the platform layer decides how to walk it and the list stays reviewable.
 */
export const SCAN_LOCATIONS: readonly string[] = [
  "GOG Games/Fallout 2",
  "Games/Fallout 2",
  "Games/Fallout2",
  "Program Files (x86)/Steam/steamapps/common/Fallout 2",
];

export type Theme = "light" | "dark" | "system";

/** The whole of `zax.yml`. Written back in one piece, so it is one type rather than a bag of loose keys. */
export interface ZaxSettings {
  installs: readonly Install[];
  theme: Theme;
}

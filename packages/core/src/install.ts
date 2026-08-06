/**
 * The per-user state that is not a game config file: which installs ZAX knows about, how to launch each, and
 * the application's own preferences. The previous implementation kept this in `zax.yml` under the platform
 * config directory, and the shape here is the same one so an existing file still loads.
 */

/**
 * Which mod is installed, decided by reading the directory rather than by anything the user tells us.
 *
 * The four patched types are two pairs, and the distinction is not cosmetic: killap's Unofficial Patch and
 * Restoration Project patch `data/` in place, while the Updated forks that descend from them are separate mods
 * distributed as a `mods/*.dat`. Calling either one "the unofficial patch" mislabels the other.
 */
export type GameType = "fallout2" | "fallout2up" | "fallout2rp" | "fallout2upu" | "fallout2rpu";

/** `name` is the install's default display name; `label` says the same thing in full, for the tooltip. */
export const GAME_TYPES: Readonly<Record<GameType, { name: string; label: string; badge: string }>> = {
  fallout2: { name: "Fallout 2", label: "Fallout 2", badge: "vanilla" },
  fallout2up: {
    name: "Unofficial Patch",
    label: "Fallout 2 with killap's Unofficial Patch",
    badge: "up",
  },
  fallout2rp: {
    name: "Restoration Project",
    label: "Fallout 2 with killap's Restoration Project",
    badge: "rp",
  },
  fallout2upu: {
    name: "Unofficial Patch Updated",
    label: "Fallout 2 with the Unofficial Patch Updated",
    badge: "upu",
  },
  fallout2rpu: {
    name: "Restoration Project Updated",
    label: "Fallout 2 with the Restoration Project Updated",
    badge: "rpu",
  },
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
  /** What the user chose to call this install. Absent means the type's own name, which is what most use. */
  alias?: string;
  wine?: WineConfig;
}

/** What to call an install: the user's name for it, or the one its type carries. */
export function displayName(install: Install): string {
  return install.alias ?? GAME_TYPES[install.type].name;
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

  // The Updated forks first: each descends from a killap patch and can carry the files that identify it, so
  // testing killap's markers first would report the ancestor.
  const mods = new Set(modEntries.map((f) => f.toLowerCase()));
  if (mods.has("rpu.dat")) return "fallout2rpu";
  if (mods.has("upu.dat")) return "fallout2upu";

  for (const { marker, type } of ROOT_MARKERS) if (root.has(marker)) return type;
  return "fallout2";
}

/**
 * What killap's installers leave in the game folder. These patches write into `data/` and add no `mods/*.dat`,
 * so a root file is the only thing that distinguishes them from an unpatched game.
 *
 * The Restoration Project comes first because it carries the Unofficial Patch and leaves both files. This is
 * the same test the Restoration Project's own installer makes, which reads an install as the Unofficial Patch
 * only when `up-changelog.txt` is present and `rp-changelog.txt` is not:
 * https://github.com/BGforgeNet/Fallout2_Restoration_Project/blob/master/release/rpu-install.sh
 */
const ROOT_MARKERS: readonly { marker: string; type: GameType }[] = [
  { marker: "rp-changelog.txt", type: "fallout2rp" },
  { marker: "up-changelog.txt", type: "fallout2up" },
];

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
    g.path !== path
      ? g
      : {
          path: g.path,
          type: g.type,
          ...(g.alias ? { alias: g.alias } : {}),
          ...(Object.keys(kept).length ? { wine: kept } : {}),
        },
  );
}

/**
 * Sets an install's alias, or clears it back to the type's name when given nothing - the same drop-when-empty
 * rule the Wine fields use, so clearing the field removes it rather than pinning an empty string the display
 * would then show in place of a name.
 */
export function setAlias(installs: readonly Install[], path: string, alias: string): readonly Install[] {
  const chosen = alias.trim();
  return installs.map((g) =>
    g.path !== path
      ? g
      : { path: g.path, type: g.type, ...(chosen ? { alias: chosen } : {}), ...(g.wine ? { wine: g.wine } : {}) },
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

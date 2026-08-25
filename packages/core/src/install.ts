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
 *
 * `fo1in2` is not a fifth patch but a different game: Fallout 1 rebuilt on this engine, in its own directory.
 */
export type GameType = "fallout2" | "fallout2up" | "fallout2rp" | "fallout2upu" | "fallout2rpu" | "fo1in2";

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
  fo1in2: {
    name: "Fallout et tu",
    label: "Fallout 1 in the Fallout 2 engine",
    badge: "fo1in2",
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

/**
 * What a new install starts WINEDEBUG at. Wine's default leaves `err` and `fixme` on, which is a stub notice
 * for every unimplemented call rather than anything diagnostic; clearing the field is what asks for them.
 */
export const DEFAULT_WINE_DEBUG = "-all";

/**
 * An install as it joins the list, whether the user pointed at it or a scan turned it up, so both routes start
 * it the same way. The Wine default is stored on Windows too: it costs one line nothing reads there, and it is
 * already right if the folder is later opened from a machine that does use Wine.
 */
export function newInstall(path: string, type: GameType): Install {
  return { path, type, wine: { debug: DEFAULT_WINE_DEBUG } };
}

/** What to call an install: the user's name for it, or the one its type carries. */
export function displayName(install: Install): string {
  return install.alias ?? GAME_TYPES[install.type].name;
}

/**
 * The one file every install ZAX recognises must have in its root. Named rather than inlined because the
 * interface points its picker at it: what the user is asked to find has to be the same thing that decides.
 *
 * Lowercase, as the comparison below is; a real install may shout it, which is the caller's problem to allow.
 */
export const INSTALL_MARKER = "fallout2.exe";

/**
 * The type of install at a directory, or null when it is not a Fallout 2 install at all.
 *
 * Takes listings rather than a path so the rule is testable without a filesystem: deciding what counts as an
 * install is domain logic, and only reading the directory needs the platform. Matching is case-insensitive
 * because the same install reads back differently through Wine than it does natively.
 */
export function detectGameType(rootEntries: readonly string[], modEntries: readonly string[]): GameType | null {
  const root = new Set(rootEntries.map((f) => f.toLowerCase()));
  if (!root.has(INSTALL_MARKER)) return null;

  const mods = new Set(modEntries.map((f) => f.toLowerCase()));
  // Fallout et tu replaces the game rather than patching it, and ships no marker of its own in the root it
  // shares with a stock Fallout 2 layout. Its core mod is what names it.
  if (mods.has("fo1_base")) return "fo1in2";

  // The Updated forks next: each descends from a killap patch and can carry the files that identify it, so
  // testing killap's markers first would report the ancestor.
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
 * Where an unattended scan looks, relative to each drive on Windows and to the home directory or a Wine prefix
 * elsewhere. Data rather than code so the platform layer decides how to walk it and the list stays reviewable.
 *
 * Every one of these is only a store's default, which the user is free to change - the launchers that record
 * where the game actually went are asked separately, and this list is what is left: retail copies, installs made
 * by hand, and machines whose launcher is not running or not installed.
 */
export const SCAN_LOCATIONS: readonly string[] = [
  // GOG's offline installers use the first; Galaxy does not put games there.
  "GOG Games/Fallout 2",
  "Program Files (x86)/GOG Galaxy/Games/Fallout 2",
  // Steam's first library. Every other library is found through `libraryfolders.vdf` instead.
  "Program Files (x86)/Steam/steamapps/common/Fallout 2",
  // Epic, which gave the game away for a week in 2024 and so put it in a great many libraries.
  "Program Files/Epic Games/Fallout 2",
  // The Xbox app writes into a directory nothing may modify until the user enables mod support for the game,
  // at which point it moves it to one of these.
  "XboxGames/Fallout 2/Content",
  "Program Files/ModifiableWindowsApps/Fallout 2",
  // Heroic and Lutris, which is how a Linux machine usually holds a GOG or Epic copy.
  "Games/Heroic/Fallout 2",
  "Games/Fallout 2",
  "Games/Fallout2",
];

/**
 * The folder Fallout et tu is unpacked into, inside a Fallout 2 install - the game it converts is required, and
 * its `master.dat` is what the mod reads. Nothing that looks for a Fallout 2 install reaches it: the launchers
 * name the install itself, and the shallow search stops at the level that install sits on, so it is looked for
 * under each install the scan knows about instead.
 */
export const FO1IN2_DIRECTORY = "Fallout1in2";

/**
 * Where the Steam client itself may be, relative to a root. Only a starting point: whichever of these exists
 * names every library on the machine, including ones on other drives.
 */
export const STEAM_LOCATIONS: readonly string[] = [
  "Program Files (x86)/Steam",
  "Program Files/Steam",
  "Steam",
  "SteamLibrary",
  ".steam/steam",
  ".steam/root",
  ".local/share/Steam",
  ".var/app/com.valvesoftware.Steam/data/Steam",
];

/** Fallout 2 on Steam. Names the manifest that says which folder this machine's copy sits in. */
export const STEAM_APP_ID = "38410";

/** Epic's per-game manifests, relative to a root. Each names the directory that game was installed into. */
export const EPIC_MANIFEST_DIRECTORY = "ProgramData/Epic/EpicGamesLauncher/Data/Manifests";

/** Where Steam records its own location, for an install that is not under any of `STEAM_LOCATIONS`. */
export const STEAM_REGISTRY_KEY = { key: "HKCU\\Software\\Valve\\Steam", value: "SteamPath" };

/** Where Epic records the directory its `Manifests` folder sits in. */
export const EPIC_REGISTRY_KEY = {
  key: "HKLM\\SOFTWARE\\WOW6432Node\\Epic Games\\EpicGamesLauncher",
  value: "AppDataPath",
};

/**
 * Where GOG records an install's directory, one key per product. Two of them because the store sells Fallout 2
 * as a pack: which id an install registers under depends on which product was installed, and asking for a key
 * that is not there costs nothing.
 */
export const GOG_REGISTRY_KEYS: readonly string[] = [
  "HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1440166436",
  "HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1440151285",
];

/**
 * Directories the shallow search does not descend into, lowercased. Each is either large enough to spend the
 * whole budget on its own or somewhere no game is installed, and none of them is where a user puts one.
 */
export const UNSEARCHABLE_DIRECTORIES: readonly string[] = [
  "windows",
  "winsxs",
  "$recycle.bin",
  "system volume information",
  "recovery",
  "appdata",
  "node_modules",
  "proc",
  "sys",
  "dev",
];

export type Theme = "light" | "dark" | "system";

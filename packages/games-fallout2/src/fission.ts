/**
 * What Fission does with the mods folder, which is not what sfall does with it.
 *
 * `mods.ts` describes sfall's loader: the order file names a path relative to `mods\`, a dat or a folder, under
 * any name. Fission reads neither that file's format nor those paths. It scans `mods/` for `mod_*.dat`, mounts
 * from its own pipe-separated list, and rewrites that list from the scan every time it starts. So a mod can sit
 * in the folder, be enabled in the order, and still never load - which nothing in the order file can show.
 *
 * Both facts live here rather than beside the catalog entry: the caution is shown in three places and the rule
 * decides what one of them lists, and a second copy of either is what drifts.
 */

/** The engine these describe. Named once so the surfaces that single it out do not each carry the literal. */
export const FISSION_ID = "fission";

/**
 * Said wherever Fission's mods are listed and before it is launched. One text rather than one per surface: it
 * is the same mechanic each time, and three wordings of one constraint read as three different constraints.
 */
export const FISSION_CAUTION =
  "Fission does not read the sfall load order. It loads only dat archives named mod_<name>.dat from the mods " +
  "folder - never a folder, and never a dat under another name - and it rewrites mods_order.txt into its own " +
  "format every time it starts. A mod installed as a folder will not load under Fission whatever the load " +
  "order says. ZAX keeps both lists: each engine's is filed beside mods_order.txt under its own name and " +
  "swapped back in before that engine runs, so switching between engines does not cost you either one.";

/**
 * Anchored to the whole entry, so a dat inside a subfolder does not match: Fission's scan reads the top level of
 * `mods/` only. Case-insensitive because the folder is the user's, and on Windows it is theirs to spell.
 */
const MOUNTED = /^mod_[^/\\]+\.dat$/i;

/** Whether Fission would find this entry in the mods folder. The name is the one the order file writes. */
export const fissionMounts = (name: string): boolean => MOUNTED.test(name);

/** The file a Fission record names, which carries neither the prefix nor the extension its `datName` field has. */
const fissionDatFile = (datName: string): string => `mod_${datName}.dat`;

/**
 * The dats a Fission list turns on, by the name they have on disk.
 *
 * Only the first two fields are read, because only those two are what its mount path reads: the enabled flag
 * and the dat. Everything after them is a cache of what it found in the mod's own cfg, for its in-game manager
 * to list without opening every one, and no engine behaviour depends on any of it.
 */
export function fissionEnabled(text: string): readonly string[] {
  const on: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const body = line.trim();
    if (body === "" || body.startsWith("#") || body.startsWith(";")) continue;
    const [flag, datName] = body.split("|");
    if (flag?.trim() !== "1" || datName === undefined || datName.trim() === "") continue;
    on.push(fissionDatFile(datName.trim()));
  }
  return on;
}

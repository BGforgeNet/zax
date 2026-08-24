/**
 * Finding installs on a real machine. The rule for *what counts as* an install lives in `install.ts` and takes
 * directory listings; this module is the part that has to read them.
 *
 * Every store lets the user put the game somewhere else, so a list of default paths can only ever be a guess.
 * Where a launcher records what it did - Steam's library list, Epic's manifests, GOG's registry keys - the scan
 * asks it and learns the real directory; the default paths are the fallback for retail copies and for anything
 * installed by hand, and a shallow search catches folders whose names nobody predicted. One conversion installs
 * inside another install, so the installs themselves are a source too, asked once the rest have answered.
 *
 * Whatever a source proposes is only a candidate: one gate, `identifyInstall`, decides what is really an install,
 * so a new source cannot invent a way for something to qualify.
 */

import type { DirEntry, Platform } from "@zax/platform";
import { appendLog } from "./log.js";
import {
  EPIC_MANIFEST_DIRECTORY,
  FO1IN2_DIRECTORY,
  GOG_REGISTRY_KEYS,
  SCAN_LOCATIONS,
  STEAM_APP_ID,
  STEAM_LOCATIONS,
  STEAM_REGISTRY_KEY,
  EPIC_REGISTRY_KEY,
  UNSEARCHABLE_DIRECTORIES,
  detectGameType,
  newInstall,
  type GameType,
  type Install,
} from "./install.js";
import { isVdfMap, parseVdf, vdfEntry, type VdfMap } from "./vdf.js";

/** How many directories the shallow search may look at. Reached only on a machine with a very wide drive root. */
const SEARCH_BUDGET = 4_000;

/** How deep below a root the shallow search goes. Two levels reaches `D:/Games/Fallout 2 GOG` and stops. */
const SEARCH_DEPTH = 2;

/** A directory some source thinks may hold a game, and what suggested it - which is what the log reports. */
interface Candidate {
  path: string;
  source: string;
}

/**
 * One scan's shared state. Listings are kept because the sources overlap heavily - several of them look at the
 * same drive root - and a scan that re-read every parent per candidate would cost multiples of what it needs.
 */
interface Scan {
  readonly platform: Platform;
  readonly listings: Map<string, ReadonlyMap<string, DirEntry> | null>;
  readonly notes: string[];
  budget: number;
}

function newScan(platform: Platform): Scan {
  return { platform, listings: new Map(), notes: [], budget: SEARCH_BUDGET };
}

/**
 * A directory's entries by lowercased name, or null when it is not a readable directory. Unreadable is an
 * ordinary answer to a scan: it probes directories it was never given permission to, and a machine that refuses
 * one of them must not lose the rest of the scan with it.
 */
async function listing(scan: Scan, path: string): Promise<ReadonlyMap<string, DirEntry> | null> {
  const held = scan.listings.get(path);
  if (held !== undefined) return held;

  let found: ReadonlyMap<string, DirEntry> | null = null;
  try {
    if ((await scan.platform.fs.stat(path))?.kind === "dir") {
      const entries = await scan.platform.fs.list(path);
      found = new Map(entries.map((entry) => [entry.name.toLowerCase(), entry]));
    }
  } catch (error) {
    // The Xbox app's own directory is the one that reliably does this, which is worth telling the user about
    // rather than silently finding nothing there.
    scan.notes.push(`could not look inside ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  scan.listings.set(path, found);
  return found;
}

/**
 * A relative path under a root, spelled the way the filesystem actually spells it, or null when it is not there.
 *
 * Matching is case-insensitive because the same install reads back differently through Wine than it does
 * natively, and because none of these paths were typed by the user. Resolving against the real entries rather
 * than guessing a second spelling is also what keeps one directory from being found twice under two casings.
 */
async function resolve(scan: Scan, root: string, relative: string): Promise<string | null> {
  let at = root;
  for (const segment of relative.split("/")) {
    const entries = await listing(scan, at);
    const found = entries?.get(segment.toLowerCase());
    if (!found || found.kind !== "dir") return null;
    at = scan.platform.paths.join(at, found.name);
  }
  return at;
}

async function readText(scan: Scan, path: string): Promise<string | null> {
  try {
    if ((await scan.platform.fs.stat(path))?.kind !== "file") return null;
    return new TextDecoder().decode(await scan.platform.fs.read(path));
  } catch {
    return null;
  }
}

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
  try {
    if ((await platform.fs.stat(path))?.kind !== "dir") return null;
    return (await platform.fs.list(path)).map((entry) => entry.name);
  } catch {
    return null;
  }
}

/**
 * Where the scan starts. On Windows that is every drive that answers, rather than the two that used to be
 * assumed - a second disk holding games is the ordinary case, and it is rarely D:. Elsewhere it is the home
 * directory, the Wine prefix's C: drive where a Windows build lives, and any mounted volume, which is where a
 * Steam Deck keeps its SD card.
 */
export async function scanRoots(platform: Platform, winePrefix?: string): Promise<string[]> {
  const { join, home, separator } = platform.paths;
  if (platform.os === "windows") {
    const drives: string[] = [];
    // From C: rather than A:, because the two letters below it are the floppy drives and asking a machine that
    // still has one costs seconds of it seeking for a disk nobody has installed a game on.
    for (let letter = "C".charCodeAt(0); letter <= "Z".charCodeAt(0); letter++) {
      const root = `${String.fromCharCode(letter)}:${separator}`;
      if ((await platform.fs.stat(root))?.kind === "dir") drives.push(root);
    }
    return drives;
  }

  const roots = [home, join(winePrefix ?? join(home, ".wine"), "drive_c")];
  const scan = newScan(platform);
  for (const mount of ["/run/media", "/media", "/mnt"]) {
    const entries = await listing(scan, mount);
    for (const entry of entries?.values() ?? []) {
      if (entry.kind !== "dir") continue;
      // `/run/media/<user>/<volume>` on some desktops, `/media/<volume>` on others; take both levels.
      const at = join(mount, entry.name);
      roots.push(at);
      const inner = await listing(scan, at);
      for (const below of inner?.values() ?? []) if (below.kind === "dir") roots.push(join(at, below.name));
    }
  }
  return roots;
}

/** Steam's own directories: the defaults under every root, plus wherever the registry says Steam went. */
async function steamDirectories(scan: Scan, roots: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  const recorded = await scan.platform.registry.read(STEAM_REGISTRY_KEY.key, STEAM_REGISTRY_KEY.value);
  if (recorded) out.push(recorded);
  for (const root of roots) {
    for (const location of STEAM_LOCATIONS) {
      const found = await resolve(scan, root, location);
      if (found) out.push(found);
    }
  }
  return out;
}

/**
 * Steam keeps every library it knows about in one file, including the one it was installed into, so finding any
 * Steam directory finds all of them - on every drive, wherever the user put them. Each library then records the
 * folder each game sits in, which is how this avoids having to know what Steam calls the folder.
 */
async function fromSteam(scan: Scan, roots: readonly string[]): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const seen = new Set<string>();

  for (const steam of await steamDirectories(scan, roots)) {
    const libraries = [steam];
    const listed = await resolve(scan, steam, "steamapps");
    const text = listed && (await readText(scan, scan.platform.paths.join(listed, "libraryfolders.vdf")));
    if (text) libraries.push(...libraryPaths(parseVdf(text)));

    for (const library of libraries) {
      if (seen.has(library)) continue;
      seen.add(library);
      const apps = await resolve(scan, library, "steamapps");
      if (!apps) continue;
      const manifest = await readText(scan, scan.platform.paths.join(apps, `appmanifest_${STEAM_APP_ID}.acf`));
      if (!manifest) continue;
      const state = vdfEntry(parseVdf(manifest), "AppState");
      const directory = isVdfMap(state) ? vdfEntry(state, "installdir") : null;
      if (typeof directory !== "string") continue;
      const at = await resolve(scan, apps, `common/${directory}`);
      if (at) out.push({ path: at, source: "Steam library" });
    }
  }
  return out;
}

/** Every `path` one level under `libraryfolders`, which is where each library's own root is recorded. */
function libraryPaths(parsed: VdfMap): string[] {
  const folders = vdfEntry(parsed, "libraryfolders");
  if (!isVdfMap(folders)) return [];
  const out: string[] = [];
  for (const entry of Object.values(folders)) {
    if (!isVdfMap(entry)) continue;
    const path = vdfEntry(entry, "path");
    if (typeof path === "string" && path !== "") out.push(path);
  }
  return out;
}

/**
 * Epic writes one manifest per installed game, each naming the directory it went into. Every manifest is offered
 * rather than the one for Fallout 2, because which product id that is cannot be read off the launcher and the
 * gate rejects the rest for free.
 */
async function fromEpic(scan: Scan, roots: readonly string[]): Promise<Candidate[]> {
  const directories: string[] = [];
  const recorded = await scan.platform.registry.read(EPIC_REGISTRY_KEY.key, EPIC_REGISTRY_KEY.value);
  if (recorded) directories.push(scan.platform.paths.join(recorded, "Manifests"));
  for (const root of roots) {
    const found = await resolve(scan, root, EPIC_MANIFEST_DIRECTORY);
    if (found) directories.push(found);
  }

  const out: Candidate[] = [];
  for (const directory of directories) {
    const entries = await listing(scan, directory);
    for (const entry of entries?.values() ?? []) {
      if (entry.kind !== "file" || !entry.name.toLowerCase().endsWith(".item")) continue;
      const text = await readText(scan, scan.platform.paths.join(directory, entry.name));
      if (!text) continue;
      const where = installLocation(text);
      if (where) out.push({ path: where, source: "Epic manifest" });
    }
  }
  return out;
}

/** A manifest is JSON, and a damaged one costs the install it describes rather than the scan. */
function installLocation(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return null;
    const where = (parsed as Record<string, unknown>)["InstallLocation"];
    return typeof where === "string" && where !== "" ? where : null;
  } catch {
    return null;
  }
}

/** GOG records the directory per product. Both ids are asked for: the store sells the game as a pack, and which
 * of the two an install registers under depends on which of them was installed. */
async function fromGog(scan: Scan): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const key of GOG_REGISTRY_KEYS) {
    const found = await scan.platform.registry.read(key, "path");
    if (found) out.push({ path: found, source: "GOG registry" });
  }
  return out;
}

/** The store defaults, which is all there is for a retail copy or one installed by hand. */
async function fromKnownLocations(scan: Scan, roots: readonly string[]): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const root of roots) {
    for (const location of SCAN_LOCATIONS) {
      const found = await resolve(scan, root, location);
      if (found) out.push({ path: found, source: "known location" });
    }
  }
  return out;
}

/**
 * A shallow look below each root, for the copies no list of defaults can predict - a renamed folder, a second
 * library directory, a game moved by hand. Bounded in both depth and total directories examined, because this is
 * the one source whose cost is set by what is on the machine rather than by what it is looking for.
 */
async function fromSearch(scan: Scan, roots: readonly string[]): Promise<Candidate[]> {
  const out: Candidate[] = [];

  const walk = async (at: string, depth: number): Promise<void> => {
    if (depth > SEARCH_DEPTH || scan.budget <= 0) return;
    const entries = await listing(scan, at);
    for (const entry of entries?.values() ?? []) {
      if (entry.kind !== "dir" || scan.budget <= 0) continue;
      const name = entry.name.toLowerCase();
      if (name.startsWith(".") || UNSEARCHABLE_DIRECTORIES.includes(name)) continue;
      scan.budget -= 1;
      const below = scan.platform.paths.join(at, entry.name);
      out.push({ path: below, source: "search" });
      await walk(below, depth + 1);
    }
  };

  for (const root of roots) await walk(root, 1);
  return out;
}

/**
 * Fallout et tu, which lives in a folder inside a Fallout 2 install rather than anywhere a launcher or a
 * default path would name. Installs already on the list are asked as well as the ones just found: the mod is
 * normally installed long after the game it sits in was added, and a scan that only looked inside new installs
 * would never find it on the machine of anyone who had already used ZAX.
 */
async function fromInstalls(scan: Scan, installs: readonly string[]): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const path of installs) {
    const found = await resolve(scan, path, FO1IN2_DIRECTORY);
    if (found) out.push({ path: found, source: "inside an install" });
  }
  return out;
}

/** Two spellings of one directory are one install, on the filesystems that do not distinguish them. */
function dedupeKey(platform: Platform, path: string): string {
  const at = path.replace(/[\\/]+$/, "");
  return platform.os === "linux" ? at : at.toLowerCase();
}

/**
 * Installs found on this machine and not already on the list, in the order the sources are asked: the launchers
 * that know where they put things first, then the defaults, then the search, then inside the installs. The
 * order is what decides which source a directory is credited to in the log when more than one proposes it.
 */
export async function scanForInstalls(
  platform: Platform,
  known: readonly Install[],
  now: Date,
  winePrefix?: string,
): Promise<Install[]> {
  const scan = newScan(platform);
  const roots = await scanRoots(platform, winePrefix);

  const candidates = [
    ...(await fromSteam(scan, roots)),
    ...(await fromEpic(scan, roots)),
    ...(await fromGog(scan)),
    ...(await fromKnownLocations(scan, roots)),
    ...(await fromSearch(scan, roots)),
  ];

  const seen = new Set(known.map((install) => dedupeKey(platform, install.path)));
  const found: Install[] = [];
  const credited: string[] = [];

  const consider = async (proposed: readonly Candidate[]): Promise<void> => {
    for (const candidate of proposed) {
      const key = dedupeKey(platform, candidate.path);
      if (seen.has(key)) continue;
      seen.add(key);
      const type = await identifyInstall(platform, candidate.path);
      if (type === null) continue;
      found.push(newInstall(candidate.path, type));
      credited.push(`${candidate.path} (${candidate.source}, ${type})`);
    }
  };

  await consider(candidates);
  // Last, because it is the one source whose directories are not known until every other has answered.
  const nested = await fromInstalls(scan, [...known.map((one) => one.path), ...found.map((one) => one.path)]);
  await consider(nested);

  for (const note of scan.notes) await appendLog(platform, `scan: ${note}`, now);
  await appendLog(
    platform,
    `scan: ${roots.length} roots, ${candidates.length + nested.length} candidates, ${found.length} new${
      credited.length ? `: ${credited.join("; ")}` : ""
    }`,
    now,
  );
  return found;
}

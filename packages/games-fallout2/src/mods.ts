/**
 * sfall's mod load order: `mods/mods_order.txt`, which says what the engine loads out of the `mods` folder and
 * in what order.
 *
 * The rules here are the loader's own rather than what the file looks like. An entry is a path relative to
 * `mods\` naming either a `.dat` archive or a folder; a `;` or a `#` starts a comment and the rest of the line
 * is dropped; separators are normalized and a path that could leave the game folder is refused; an entry
 * naming something absent is skipped with a line in the log. A mod further down the file overrides one above
 * it, and where the same mod is named twice only the last line counts.
 *
 * Disabling is commenting the line out. That is the only representation the format has, and the only one that
 * keeps the mod's place in the order for when it is turned back on.
 */

import { backupDirectory, latin1, latin1Bytes, splitLines, stamp, type Install, type SaveOutcome } from "@zax/core";
import type { Platform } from "@zax/platform";

export const MODS_DIRECTORY = "mods";
export const MODS_ORDER_FILE = "mods_order.txt";

/** How the file is named to the user, in one piece rather than assembled at each site that mentions it. */
export const MODS_ORDER_PATH = `${MODS_DIRECTORY}/${MODS_ORDER_FILE}`;

/** What is on disk under a mod's name. `missing` is an entry whose file or folder is no longer there. */
export type ModKind = "dat" | "folder" | "file" | "missing";

export interface Mod {
  /** The entry as the file writes it, relative to `mods\`. */
  name: string;
  enabled: boolean;
  kind: ModKind;
}

/** Something in the mods folder that the engine could load. */
export interface ModsDirEntry {
  name: string;
  kind: Exclude<ModKind, "missing">;
}

export interface ModsSnapshot {
  /** The order file exactly as read, or undefined when the install has none. */
  text: string | undefined;
  /** Every name that resolves: what the folder holds, plus anything the file names that exists. */
  present: readonly ModsDirEntry[];
}

export interface ModsSaveRequest {
  installPath: string;
  /** The text the edits were made against, as `readMods` returned it. */
  original: string | undefined;
  mods: readonly Mod[];
}

const fold = (s: string) => s.toLowerCase();

/** `findLastIndex` in the form this project's ES2022 target has. */
function lastIndexWhere<T>(items: readonly T[], match: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (match(items[i]!)) return i;
  return -1;
}

const LEADING_COMMENT = /^\s*[;#]/;

/**
 * An entry as the loader reads it: comment stripped, trimmed, separators normalized, leading slashes dropped,
 * and refused outright when it could point outside the game folder. Null when the line names no usable entry.
 */
export function entryName(text: string): string | null {
  const cut = text.search(/[;#]/);
  const path = (cut === -1 ? text : text.slice(0, cut)).trim().replace(/\//g, "\\").replace(/^\\+/, "");
  if (path === "" || path.includes(":") || path.includes("..\\")) return null;
  return path;
}

/** One line of the file. `name` is empty for a blank line, and for a comment that names nothing. */
interface OrderLine {
  name: string;
  enabled: boolean;
  /** The line without its terminator, kept so an untouched entry is written back byte for byte. */
  body: string;
  eol: string;
}

function parseOrder(text: string): { lines: OrderLine[]; eol: string } {
  const lines: OrderLine[] = [];
  let crlf = 0;
  let lf = 0;
  for (const { body, eol } of splitLines(text)) {
    if (eol === "\r\n") crlf++;
    else if (eol === "\n") lf++;
    const marker = LEADING_COMMENT.exec(body);
    const name = entryName(marker ? body.slice(marker[0].length) : body);
    lines.push({ name: name ?? "", enabled: marker === null, body, eol });
  }
  return { lines, eol: crlf >= lf && crlf > 0 ? "\r\n" : "\n" };
}

/** Every name the order file mentions, whether the line is commented out or not. */
function namedInOrder(text: string | undefined): readonly string[] {
  return parseOrder(text ?? "")
    .lines.filter((line) => line.name !== "")
    .map((line) => line.name);
}

/**
 * The mods to show, in load order: what the file names, then whatever sits in the folder it never named.
 *
 * A commented line counts as a disabled mod only when it names something actually in the folder. Nothing in
 * the syntax separates `; rpu.dat` from `; the ones below are optional` - both are valid paths - so the folder
 * is what decides, and a note that names nothing stays a note.
 */
export function listMods(snapshot: ModsSnapshot): readonly Mod[] {
  const present = new Map(snapshot.present.map((entry) => [fold(entry.name), entry]));
  const out: Mod[] = [];

  for (const line of parseOrder(snapshot.text ?? "").lines) {
    if (line.name === "") continue;
    const key = fold(line.name);
    if (!line.enabled && !present.has(key)) continue;
    // The loader drops the earlier of two lines naming the same mod, so the last one is the one that decides.
    const already = out.findIndex((mod) => fold(mod.name) === key);
    if (already !== -1) out.splice(already, 1);
    out.push({ name: line.name, enabled: line.enabled, kind: present.get(key)?.kind ?? "missing" });
  }

  const listed = new Set(out.map((mod) => fold(mod.name)));
  // In the folder but named nowhere: the engine does not load it, which is what disabled means here.
  for (const entry of snapshot.present) {
    if (!listed.has(fold(entry.name))) out.push({ name: entry.name, enabled: false, kind: entry.kind });
  }
  return out;
}

/**
 * The file that expresses this order, keeping as much of the old one as a reorder can.
 *
 * An entry whose state did not change is written back as its own bytes, so nothing about a line the user did
 * not touch changes - not its spacing, not its trailing note. Turning one on or off adds or removes the
 * comment marker and leaves the rest of the line alone.
 *
 * Comment lines directly above an entry are that entry's own note and travel with it. Everything else keeps
 * its side of the file: what was above the first entry is the file's header and stays at the top, and prose
 * set off by a blank line joins what was below the last. Blank lines between entries are dropped, being
 * separators for an order that has just changed.
 */
export function writeOrder(original: string | undefined, mods: readonly Mod[]): string {
  const { lines, eol } = parseOrder(original ?? "");
  const named = new Set(mods.map((mod) => fold(mod.name)));

  /*
    Which lines are entries is decided against the list being written, not by syntax: `; the ones below are
    optional` parses as a perfectly good path, so a commented line is one mod's line only when it names a mod
    that is actually here. An uncommented line always is - one naming a mod no longer in the list was dropped
    on purpose, and writing it back would hand it to the engine again.
  */
  const isEntry = (line: OrderLine) => line.name !== "" && (line.enabled || named.has(fold(line.name)));
  const isProse = (line: OrderLine) => !isEntry(line) && line.body.trim() !== "";

  const first = lines.findIndex(isEntry);
  const last = lastIndexWhere(lines, isEntry);

  /** The run of comment lines sitting directly above an entry, with no blank line between. */
  const preamble = (at: number): OrderLine[] => {
    let from = at;
    while (from > 0 && isProse(lines[from - 1]!)) from--;
    return lines.slice(from, at);
  };

  /** Whether a comment line belongs to the entry below it: everything down to that entry is comment too. */
  const attached = (at: number): boolean => {
    for (let i = at + 1; i < lines.length; i++) {
      if (isEntry(lines[i]!)) return true;
      if (!isProse(lines[i]!)) return false;
    }
    return false;
  };

  // Everything above the first entry is the file's own header and stays at the top. A note there reads as the
  // file's rather than as the first mod's, and letting that mod carry it away would strand the header mid-file.
  const head = first === -1 ? lines : lines.slice(0, first);
  const tail = last === -1 ? [] : lines.slice(last + 1);
  const loose = lines.filter((line, at) => at > first && at < last && isProse(line) && !attached(at));

  const pieces: Array<{ text: string; eol: string }> = [];
  const keep = (line: OrderLine) => pieces.push({ text: line.body, eol: line.eol });

  for (const line of head) keep(line);
  for (const mod of mods) {
    const at = lastIndexWhere(lines, (line) => isEntry(line) && fold(line.name) === fold(mod.name));
    const source = at === -1 ? undefined : lines[at]!;
    if (source && at !== first) for (const note of preamble(at)) keep(note);
    pieces.push({
      text: source ? restate(source, mod.enabled) : mod.enabled ? mod.name : `; ${mod.name}`,
      eol: source?.eol ?? eol,
    });
  }
  for (const line of [...loose, ...tail]) keep(line);

  // Every line but the last is terminated: one that was the file's last and now is not would otherwise run
  // into the line below it. Ending without a newline is a property of the file rather than of whichever line
  // has drifted to the bottom, so it is read off the original and applied to whatever ends up last.
  const endsBare = lines.length > 0 && lines[lines.length - 1]!.eol === "";
  return pieces.map((piece, i) => piece.text + (endsBare && i === pieces.length - 1 ? "" : piece.eol || eol)).join("");
}

/** The same line, enabled or not. Prefixing rather than rebuilding keeps the indentation and any note on it. */
function restate(line: OrderLine, enabled: boolean): string {
  if (line.enabled === enabled) return line.body;
  return enabled ? line.body.replace(/^(\s*)[;#][ \t]?/, "$1") : `; ${line.body}`;
}

/** Reads the order file and the folder beside it. Neither existing is an ordinary answer, not a failure. */
export async function readMods(platform: Platform, install: Install): Promise<ModsSnapshot> {
  const directory = platform.paths.join(install.path, MODS_DIRECTORY);
  const orderPath = platform.paths.join(directory, MODS_ORDER_FILE);
  const text =
    (await platform.fs.stat(orderPath))?.kind === "file" ? latin1(await platform.fs.read(orderPath)) : undefined;

  const present = new Map<string, ModsDirEntry>();
  if ((await platform.fs.stat(directory))?.kind === "dir") {
    for (const entry of await platform.fs.list(directory)) {
      if (entry.kind === "dir") present.set(fold(entry.name), { name: entry.name, kind: "folder" });
      // Loose files other than archives are the folder's own clutter - a readme, the order file itself - and
      // offering them as mods to enable would be offering something the engine cannot load.
      else if (/\.dat$/i.test(entry.name)) present.set(fold(entry.name), { name: entry.name, kind: "dat" });
    }
  }

  // An entry may name a path further down - `patches\extra.dat` - which one listing never reaches, so
  // whatever the file names and the listing did not resolve is looked up on its own.
  for (const name of namedInOrder(text)) {
    if (present.has(fold(name))) continue;
    const found = await platform.fs.stat(platform.paths.join(directory, ...name.split("\\")));
    if (found?.kind === "dir") present.set(fold(name), { name, kind: "folder" });
    else if (found?.kind === "file") present.set(fold(name), { name, kind: /\.dat$/i.test(name) ? "dat" : "file" });
  }

  return {
    text,
    present: [...present.values()].sort((a, b) => fold(a.name).localeCompare(fold(b.name))),
  };
}

/**
 * Writes the order back, refusing a file that changed underneath and copying the old one aside first - the
 * same two guarantees a config file save makes, for a file the user is equally likely to hand-edit.
 *
 * `now` is passed rather than read so the backup directory a save produces is predictable in a test.
 */
export async function saveMods(
  platform: Platform,
  request: ModsSaveRequest,
  now: Date = new Date(),
): Promise<SaveOutcome> {
  const path = platform.paths.join(request.installPath, MODS_DIRECTORY, MODS_ORDER_FILE);
  const current = (await platform.fs.stat(path))?.kind === "file" ? latin1(await platform.fs.read(path)) : undefined;
  if (current !== request.original) return { ok: false, changed: [MODS_ORDER_PATH] };

  let backup: string | null = null;
  if (current !== undefined) {
    backup = platform.paths.join(backupDirectory(platform), stamp(now));
    await platform.fs.copy(path, platform.paths.join(backup, MODS_DIRECTORY, MODS_ORDER_FILE));
  }

  await platform.fs.write(path, latin1Bytes(writeOrder(current, request.mods)));
  return { ok: true, files: [MODS_ORDER_PATH], backup };
}

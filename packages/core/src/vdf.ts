/**
 * Valve's key-values format, in the subset the two Steam files a scan reads are written in: `libraryfolders.vdf`
 * for where the libraries are, and `appmanifest_<id>.acf` for the folder one game sits in. Both are the same
 * format under different extensions, so they share one reader.
 *
 * Deliberately lenient. This parses files another program wrote and a scan must survive whatever it finds: an
 * unterminated string, a stray brace or a key with no value yields whatever was readable up to that point rather
 * than failing, because a malformed library list should cost the installs it describes, not the whole scan.
 */

export type VdfValue = string | VdfMap;

export interface VdfMap {
  readonly [key: string]: VdfValue;
}

interface Cursor {
  at: number;
}

/** Braces are tokens of their own; anything else is a key or a value. Null at the end of the text. */
function nextToken(text: string, cursor: Cursor): string | null {
  for (; cursor.at < text.length; cursor.at++) {
    const ch = text[cursor.at]!;
    if (ch === "/" && text[cursor.at + 1] === "/") {
      while (cursor.at < text.length && text[cursor.at] !== "\n") cursor.at++;
      continue;
    }
    if (!/\s/.test(ch)) break;
  }
  if (cursor.at >= text.length) return null;

  const ch = text[cursor.at]!;
  if (ch === "{" || ch === "}") {
    cursor.at++;
    return ch;
  }
  if (ch === '"') return readQuoted(text, cursor);

  const start = cursor.at;
  while (cursor.at < text.length && !/[\s{}"]/.test(text[cursor.at]!)) cursor.at++;
  return text.slice(start, cursor.at);
}

function readQuoted(text: string, cursor: Cursor): string {
  cursor.at++;
  let out = "";
  while (cursor.at < text.length) {
    const ch = text[cursor.at]!;
    if (ch === "\\") {
      // Valve escapes the path separator, so `C:\\Steam` is one backslash. Only the two whitespace escapes mean
      // anything else; every other pair keeps the character that followed.
      const next = text[cursor.at + 1];
      out += next === "n" ? "\n" : next === "t" ? "\t" : (next ?? "");
      cursor.at += 2;
      continue;
    }
    if (ch === '"') {
      cursor.at++;
      return out;
    }
    out += ch;
    cursor.at++;
  }
  return out;
}

function readMap(text: string, cursor: Cursor, top: boolean): VdfMap {
  const out: Record<string, VdfValue> = {};
  for (;;) {
    const key = nextToken(text, cursor);
    if (key === null) return out;
    // A closing brace ends this map, except at the top level where it can only be stray punctuation.
    if (key === "}") {
      if (!top) return out;
      continue;
    }
    if (key === "{") continue;

    const value = nextToken(text, cursor);
    if (value === null) return out;
    out[key] = value === "{" ? readMap(text, cursor, false) : value;
  }
}

export function parseVdf(text: string): VdfMap {
  return readMap(text, { at: 0 }, true);
}

/** Narrows a lookup's result to a nested map. Spelled out because `typeof null` is also `"object"`. */
export function isVdfMap(value: VdfValue | null): value is VdfMap {
  return value !== null && typeof value === "object";
}

/**
 * Keys are matched case-insensitively because these files are not written by hand and their casing has changed
 * across Steam versions - `libraryfolders.vdf` held `LibraryFolders` before it held `libraryfolders`.
 */
export function vdfEntry(map: VdfMap, key: string): VdfValue | null {
  const wanted = key.toLowerCase();
  for (const [name, value] of Object.entries(map)) if (name.toLowerCase() === wanted) return value;
  return null;
}

/**
 * Lowercasing a game directory, which is what makes a base mod's install work on a case-sensitive
 * filesystem at all.
 *
 * Upstream's shell installer refuses over an uppercase filename and tells the user to lowercase the tree by
 * hand; the Windows route never meets the problem and carries no such check. So this is ZAX's to do, and it
 * is the widest-reaching rename in the application - hence the guards. It runs only where the filesystem
 * actually distinguishes case, only on entries that actually differ from their lowercase form, never inside
 * `backup/`, and not at all if two entries would collide, which is the one outcome that loses a file.
 */

import type { Platform } from "@zax/platform";

/** Where the install's own way back lives. Renaming inside it would rewrite the history it exists to keep. */
const BACKUP = "backup";

const inside = (platform: Platform, root: string, relative: string): string =>
  platform.paths.join(root, ...relative.split("/"));

/** Whether a name has anything for case to apply to - `12.dat` reads the same either way. */
const hasLetters = (name: string): boolean => name.toLowerCase() !== name.toUpperCase();

/**
 * Whether this filesystem tells `Foo.dat` from `foo.dat`, asked by looking rather than by writing: an entry
 * that is already there is requested under a name that differs only in case, and a filesystem that answers
 * folds case. The shell installer writes two probe files to learn the same thing; nothing is written here.
 *
 * False where the directory holds nothing to ask about, which is the same outcome: a pass with nothing to
 * rename changes nothing whichever kind of filesystem it is on.
 */
export async function caseSensitiveAt(platform: Platform, root: string): Promise<boolean> {
  const entries = await platform.fs.list(root).catch(() => []);
  const probe = entries.find((entry) => hasLetters(entry.name));
  if (!probe) return false;
  const flipped = probe.name === probe.name.toLowerCase() ? probe.name.toUpperCase() : probe.name.toLowerCase();
  return (await platform.fs.stat(platform.paths.join(root, flipped))) === null;
}

/**
 * Every entry under `root` whose name is not already lowercase, deepest first - so a directory is renamed
 * only once nothing below it still has to be found under the old name.
 *
 * Throws when two entries in one directory differ only by case: legal here and impossible afterwards, so
 * renaming one onto the other would lose it. The refusal names both and the pass does not start.
 */
export async function mixedCasePaths(platform: Platform, root: string): Promise<readonly string[]> {
  const out: string[] = [];

  const walk = async (prefix: string): Promise<void> => {
    const at = prefix === "" ? root : inside(platform, root, prefix);
    const entries = await platform.fs.list(at).catch(() => []);

    const folded = new Map<string, string>();
    for (const entry of entries) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const held = folded.get(entry.name.toLowerCase());
      if (held !== undefined) throw new Error(caseCollision(held, path));
      folded.set(entry.name.toLowerCase(), path);
    }

    for (const entry of entries) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      // The one exclusion, and it is the whole of it: everything else in the tree is the game's.
      if (prefix === "" && entry.kind === "dir" && entry.name.toLowerCase() === BACKUP) continue;
      if (entry.kind === "dir") await walk(path);
      if (entry.name !== entry.name.toLowerCase()) out.push(path);
    }
  };

  await walk("");
  return out;
}

const caseCollision = (one: string, other: string): string =>
  `This game folder holds both "${one}" and "${other}", which differ only in case. Lowercasing it would leave one of them on top of the other, so nothing was renamed - remove or rename one of the two by hand first.`;

/**
 * Lowercases the tree, deepest first, and answers with what it renamed. Every path is resolved before the
 * first rename, so a collision anywhere refuses before anything moves.
 */
export async function lowercaseTree(platform: Platform, root: string): Promise<readonly string[]> {
  const paths = await mixedCasePaths(platform, root);
  for (const path of paths) {
    const pieces = path.split("/");
    const name = pieces[pieces.length - 1] ?? "";
    const lowered = [...pieces.slice(0, -1), name.toLowerCase()].join("/");
    await platform.fs.rename(inside(platform, root, path), inside(platform, root, lowered));
  }
  return paths;
}

/**
 * Directory walking, built on the platform interface rather than in it: the interface stays the set of things
 * only a host can do, and anything expressible in terms of those belongs above it where it is testable.
 */

import type { Platform } from "@zax/platform";

/**
 * Every file under a directory, as paths relative to it, deepest last. An absent directory yields nothing
 * rather than failing - callers ask about directories that may not exist (`mods`, a save folder).
 */
export async function listFilesRecursively(platform: Platform, root: string): Promise<string[]> {
  if ((await platform.fs.stat(root))?.kind !== "dir") return [];
  const out: string[] = [];

  const walk = async (relative: string): Promise<void> => {
    const here = relative === "" ? root : platform.paths.join(root, relative);
    for (const entry of await platform.fs.list(here)) {
      const next = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.kind === "dir") await walk(next);
      else if (entry.kind === "file") out.push(next);
    }
  };

  await walk("");
  return out;
}

/**
 * Copies every file from one tree into another, overwriting. Returns the relative paths copied, which is what
 * a caller needs to report or to have backed up first.
 */
export async function copyTree(platform: Platform, from: string, to: string): Promise<string[]> {
  const files = await listFilesRecursively(platform, from);
  for (const file of files) {
    const parts = file.split("/");
    await platform.fs.copy(platform.paths.join(from, ...parts), platform.paths.join(to, ...parts));
  }
  return files;
}

/**
 * The user's own files across an install that rewrites them.
 *
 * Both kinds of base install need this and neither owns it: a delegated one hands the directory to an
 * installer that writes `ddraw.ini` from its own copy, and a created one unpacks a payload carrying the same
 * files. Without it, installing either would silently reset two of ZAX's own settings tabs.
 *
 * The order is hold, let the install write, merge back - the user's values winning over the release's new
 * defaults, with the previous release's copy as the base where a record holds one.
 */

import { IniDocument, latin1, mergeIni, type MergeConflict } from "@zax/core";
import type { Platform } from "@zax/platform";

const insidePath = (platform: Platform, root: string, relative: string): string =>
  platform.paths.join(root, ...relative.split("/"));

/** The declared files that are actually there, read into memory and copied to the timestamped backup. */
export async function holdUserFiles(
  platform: Platform,
  root: string,
  declared: readonly string[],
  backup: string,
): Promise<ReadonlyMap<string, Uint8Array>> {
  const held = new Map<string, Uint8Array>();
  for (const path of declared) {
    const at = insidePath(platform, root, path);
    if ((await platform.fs.stat(at))?.kind !== "file") continue;
    held.set(path, await platform.fs.read(at));
    await platform.fs.copy(at, insidePath(platform, backup, path));
  }
  return held;
}

/**
 * Puts held copies back exactly as they were, for a file the merge cannot carry: `mods_order.txt` is a list of
 * names rather than keys, so an ini merge would find nothing of the user's in it and keep the release's copy -
 * dropping a load order the user built. Paired with `holdUserFiles` and kept beside it, since a hold whose
 * restore lives somewhere else is a pair nobody can check.
 *
 * Files that were not there are not created: what was held is what comes back.
 */
export async function restoreUserFiles(
  platform: Platform,
  root: string,
  held: ReadonlyMap<string, Uint8Array>,
): Promise<void> {
  for (const [path, bytes] of held) await platform.fs.write(insidePath(platform, root, path), bytes);
}

export interface MergedState {
  /** What the release shipped, latin1 text - the base the next upgrade's merge compares against. */
  shipped: Record<string, string>;
  /** Settings both the user and the release changed; the user's won. */
  conflicts: readonly MergeConflict[];
}

/**
 * Merges the held copies back into what the install has just written, and records what it wrote. Every
 * declared file that is there now is recorded, including one this install introduced: it is the base the next
 * upgrade needs, and there is nothing else that could supply it later.
 */
export async function mergeUserFiles(
  platform: Platform,
  root: string,
  declared: readonly string[],
  held: ReadonlyMap<string, Uint8Array>,
  previous?: Readonly<Record<string, string>>,
): Promise<MergedState> {
  const shipped: Record<string, string> = {};
  const conflicts: MergeConflict[] = [];
  for (const path of declared) {
    const target = insidePath(platform, root, path);
    if ((await platform.fs.stat(target))?.kind !== "file") continue;
    const shippedBytes = await platform.fs.read(target);
    shipped[path] = latin1(shippedBytes);
    const mine = held.get(path);
    if (!mine) continue;
    const base = previous?.[path];
    const merged = mergeIni(
      IniDocument.parseBytes(shippedBytes),
      IniDocument.parseBytes(mine),
      base === undefined ? null : IniDocument.parse(base),
    );
    await platform.fs.write(target, merged.document.toBytes());
    conflicts.push(...merged.conflicts);
  }
  return { shipped, conflicts };
}

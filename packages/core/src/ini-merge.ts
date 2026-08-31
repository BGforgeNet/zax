/**
 * Merging one INI file into another across a version change.
 *
 * A two-way overlay - write every value the user has over the new file - cannot tell a setting the user chose
 * from one they never touched, so the old default wins even where the new release deliberately changed it, and
 * a key the release retired comes back forever. Knowing what the *previous* release shipped answers both: a
 * value equal to the old default was never chosen, and one the release dropped is only worth keeping if it was.
 */

import type { IniDocument } from "./ini.js";

/** A key both sides changed. The user's value is kept; the caller decides whether to say so. */
export interface MergeConflict {
  section: string;
  key: string;
  mine: string;
  theirs: string;
}

export interface MergeOutcome {
  /** The release's document, with the user's settings written into it. */
  document: IniDocument;
  conflicts: readonly MergeConflict[];
  /** Keys the release retired that the user had left at the old default, so they are gone from the result. */
  removed: readonly { section: string; key: string }[];
}

/**
 * Writes `mine` into `theirs`, using `base` - what the installed version shipped - to tell a chosen value from
 * an untouched one. `theirs` is mutated and returned, because it is what carries the release's own comments and
 * key order, which is the reason it is the side we build on.
 *
 * With no `base` this degrades to the two-way overlay: every value the user has wins. That is the right answer
 * for an install whose previous version was never recorded, and it is not silently worse than doing nothing.
 */
export function mergeIni(theirs: IniDocument, mine: IniDocument, base: IniDocument | null): MergeOutcome {
  const conflicts: MergeConflict[] = [];
  const removed: { section: string; key: string }[] = [];

  for (const { section, key, value } of mine.entries()) {
    if (base === null) {
      theirs.set(section, key, value);
      continue;
    }

    const theirValue = theirs.get(section, key);
    const baseValue = base.get(section, key);

    // Left at what the installed version shipped, so it was never a choice: whatever the release says now
    // stands, including the release having dropped the key.
    if (value === baseValue) {
      if (theirValue === undefined) removed.push({ section, key });
      continue;
    }

    theirs.set(section, key, value);

    // A key neither the base nor the release has is the user's own addition, not a disagreement.
    if (theirValue === undefined || baseValue === undefined) continue;
    if (theirValue !== baseValue) conflicts.push({ section, key, mine: value, theirs: theirValue });
  }

  return { document: theirs, conflicts, removed };
}

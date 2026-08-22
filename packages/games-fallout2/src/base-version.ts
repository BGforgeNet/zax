/**
 * Which release of a base mod an install is carrying, read from what the mod itself wrote.
 *
 * Base mods stamp their version into `ddraw.ini` as `[Misc] VersionString`, which is what the game shows and
 * what sfall reads. ZAX parses it rather than requiring a record, because the common state is an install ZAX
 * never performed: upstream's Windows route is an exe installer, and nothing of ZAX was there when it ran.
 * Without this, such an install is a game type with no version, and no update could be offered for it.
 *
 * The four strings the shipped releases carry:
 *
 *     FALLOUT II 1.02.34              UPU v34
 *     FALLOUT II 1.02d  RP 2.4.34     RPU v2.4.34
 *     FALLOUT II 1.02d  RP 2.3.34     RPU v2.3.34
 *     FALLOUT II 1.02d  RP 2.3.3u30   RPU v30, from before the lines split
 *
 * A fifth is coming - RPU's current `sfall.sh` writes `RPU` where every shipped release writes `RP` - so the
 * parser finds the trailing version and does not match on the prefix.
 */

import { IniDocument, type Install } from "@zax/core";
import type { Platform } from "@zax/platform";

/** What an install says about itself: the release it carries, and the line that release belongs to. */
export interface BaseVersion {
  version: string;
  /**
   * Which sequence of releases this one follows - `2.3` and `2.4` ship in lockstep and never upgrade across.
   * Absent for a pre-split install, which belongs to no line: its first update is where the user picks one.
   */
  line?: string;
}

/** The post-split shape: `2.4.34`, a line and a patch. */
const LINE_AND_PATCH = /^(\d+\.\d+)\.\d+$/;

/** The pre-split shape: `2.3.3u30` is patch 30 of RP 2.3.3, and names no line at all. */
const PRE_SPLIT = /^\d+(\.\d+)*u\d+$/;

/** UPU's, which carries no marker of its own: the engine version with the patch number after it. */
const UPU = /^1\.02\.(\d+)$/;

/**
 * The release a `VersionString` names, or null where it names none - a vanilla install with sfall has the
 * field too, and it says nothing about a base mod.
 */
export function baseVersionOf(text: string): BaseVersion | null {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const last = tokens[tokens.length - 1];
  if (last === undefined) return null;

  // UPU's shape first, because it is the one that is only the engine's version with a patch number after it:
  // asked second, `FALLOUT II 1.02.34` would read as a marked version whose line is the engine's `1.02`.
  const upu = UPU.exec(last);
  if (upu?.[1]) return { version: upu[1] };

  // Otherwise a marker before the version is what tells the RPU family from anything else. Which marker it
  // is does not matter, and deliberately: `RP` today, `RPU` in the next release.
  if (!/^[A-Za-z]+$/.test(tokens[tokens.length - 2] ?? "")) return null;
  if (PRE_SPLIT.test(last)) return { version: last };
  const split = LINE_AND_PATCH.exec(last);
  return split?.[1] ? { version: last, line: split[1] } : null;
}

/** The same, read from the install's own `ddraw.ini`. */
export async function installedBaseVersion(platform: Platform, install: Install): Promise<BaseVersion | null> {
  const at = platform.paths.join(install.path, "ddraw.ini");
  if ((await platform.fs.stat(at))?.kind !== "file") return null;
  const held = IniDocument.parseBytes(await platform.fs.read(at)).get("Misc", "VersionString");
  return held === null || held === undefined ? null : baseVersionOf(held);
}

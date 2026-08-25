/**
 * Which release of a base mod an install is carrying, read from what the mod itself wrote.
 *
 * Base mods stamp their version into `ddraw.ini` as `[Misc] VersionString`, which is what the game shows and
 * what sfall reads. ZAX parses it rather than requiring a record, because the common state is an install ZAX
 * never performed: upstream's Windows route is an exe installer, and nothing of ZAX was there when it ran.
 * Without this, such an install is a game type with no version, and no update could be offered for it.
 *
 * The strings seen in the wild - the four the shipped releases carry, and what a nightly writes instead:
 *
 *     FALLOUT II 1.02.34              UPU v34
 *     FALLOUT II 1.02d  RP 2.4.34     RPU v2.4.34
 *     FALLOUT II 1.02d  RP 2.3.34     RPU v2.3.34
 *     FALLOUT II 1.02d  RP 2.3.3u30   RPU v30, from before the lines split
 *     FALLOUT II 1.02.gitfc706658     a UPU nightly, naming the commit rather than a release
 *
 * Another release spelling is coming - RPU's current `sfall.sh` writes `RPU` where every shipped release
 * writes `RP` - so the parser finds the trailing version and does not match on the prefix.
 */

import { IniDocument } from "@zax/core";
import type { Platform } from "@zax/platform";

/**
 * What an install says about itself.
 *
 * A release names a version, and which line it belongs to is the feed list's to declare rather than this
 * parser's - a version says its own numbering and nothing about branches. A nightly names the commit it was
 * built from instead, which orders against nothing: the two are separate cases so that a commit cannot reach
 * a comparison meant for versions and come out of it as older or newer than a release.
 */
export type BaseVersion = { kind: "release"; version: string } | { kind: "nightly"; commit: string };

/** The post-split shape: `2.4.34`, a line and a patch. */
const LINE_AND_PATCH = /^(\d+\.\d+)\.\d+$/;

/** The pre-split shape: `2.3.3u30` is patch 30 of RP 2.3.3, and names no line at all. */
const PRE_SPLIT = /^\d+(\.\d+)*u\d+$/;

/** UPU's, which carries no marker of its own: the engine version with the patch number after it. */
const UPU = /^1\.02\.(\d+)$/;

/**
 * A nightly, which stamps the commit it was built from where a release stamps its number - `1.02.gitfc706658`.
 * The dot is required so this cannot claim a string that merely ends in something hex-shaped.
 */
const NIGHTLY = /\.git([0-9a-f]{6,})$/i;

/**
 * The release a `VersionString` names, or null where it names none - a vanilla install with sfall has the
 * field too, and it says nothing about a base mod.
 */
export function baseVersionOf(text: string): BaseVersion | null {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const last = tokens[tokens.length - 1];
  if (last === undefined) return null;

  // Ahead of the release shapes, and whatever family wrote it: a nightly stamps a commit where a release
  // stamps its number, so none of the shapes below would match it anyway.
  const nightly = NIGHTLY.exec(last);
  if (nightly?.[1]) return { kind: "nightly", commit: nightly[1] };

  // UPU's shape next, because it is the one that is only the engine's version with a patch number after it:
  // asked later, `FALLOUT II 1.02.34` would read as a marked version whose line is the engine's `1.02`.
  const upu = UPU.exec(last);
  if (upu?.[1]) return { kind: "release", version: upu[1] };

  // Otherwise a marker before the version is what tells the RPU family from anything else. Which marker it
  // is does not matter, and deliberately: `RP` today, `RPU` in the next release.
  if (!/^[A-Za-z]+$/.test(tokens[tokens.length - 2] ?? "")) return null;
  // Dropped rather than kept: Fallout et tu writes `v1.16.3771`, the same spelling as its tag, and the
  // version compared against a release is the number rather than the way that release wrote it.
  const version = last.replace(/^v/i, "");
  if (PRE_SPLIT.test(version)) return { kind: "release", version };
  return LINE_AND_PATCH.test(version) ? { kind: "release", version } : null;
}

/**
 * The same, read from an install's own `ddraw.ini`. Takes the directory rather than an install because a mod
 * that creates one writes its stamp inside the directory it made, which is no install of its own yet.
 */
export async function installedBaseVersion(platform: Platform, root: string): Promise<BaseVersion | null> {
  const at = platform.paths.join(root, "ddraw.ini");
  if ((await platform.fs.stat(at))?.kind !== "file") return null;
  const held = IniDocument.parseBytes(await platform.fs.read(at)).get("Misc", "VersionString");
  return held === null || held === undefined ? null : baseVersionOf(held);
}

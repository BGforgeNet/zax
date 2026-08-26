/**
 * Which build of an engine a game folder should run.
 *
 * Pure, and kept apart from the deployment it decides for: a folder holds at most one build, so choosing is the
 * whole of what a version list does, and every arm of the rule is assertable without a filesystem.
 */

import type { CachedEngine } from "./engine-release.js";
import type { InstalledEngine } from "./records.js";

export type BuildChoice =
  /** What the folder holds is what should run. `pin` is what the record should say afterwards. */
  | { run: "here"; pin: boolean }
  /** Put this build in place first, then run it. */
  | { run: "deploy"; build: CachedEngine; pin: boolean }
  /** Nothing to run: the folder holds none, and none the machine holds answers. */
  | { run: "nothing" };

/**
 * `cached` is newest first, as `cachedEngines` returns it. `asked` names a build by its publication instant,
 * which is what a version list offers; null follows the rule rather than a choice.
 *
 * An unpinned folder follows the newest cached build, so fetching a newer one moves it forward on the next run.
 * That is what makes latest the default, and the pin is how a user opts out of it.
 */
export function chooseBuild(
  deployed: InstalledEngine | undefined,
  cached: readonly CachedEngine[],
  asked: string | null,
): BuildChoice {
  if (asked !== null) {
    const wanted = cached.find((one) => one.release.published === asked);
    // The cache moved since the list was drawn. Refusing beats silently running a different build.
    if (wanted === undefined) return { run: "nothing" };
    return deployed?.published === asked ? { run: "here", pin: true } : { run: "deploy", build: wanted, pin: true };
  }

  const newest = cached[0];
  if (deployed === undefined) {
    return newest === undefined ? { run: "nothing" } : { run: "deploy", build: newest, pin: false };
  }
  if (deployed.pinned) return { run: "here", pin: true };
  // The instants are ISO 8601, so a lexical comparison is chronological.
  if (newest !== undefined && newest.release.published > deployed.published) {
    return { run: "deploy", build: newest, pin: false };
  }
  return { run: "here", pin: false };
}

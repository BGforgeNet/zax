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
 * What a user picked for a folder: one build by its publication instant, or `latest` to clear a pin and follow
 * the newest build the machine holds. A string and an object rather than two strings, since a tag could be
 * spelled `latest` and an instant cannot be told from one by type.
 */
export type BuildPick = { published: string } | "latest";

/**
 * `cached` is newest first, as `cachedEngines` returns it. `asked` is what the user picked, or null to follow
 * the folder's rule - what a plain run does, and the one answer that leaves a pin standing.
 *
 * An unpinned folder follows the newest cached build, so fetching a newer one moves it forward on the next run.
 * That is what makes latest the default, and the pin is how a user opts out of it.
 */
export function chooseBuild(
  deployed: InstalledEngine | undefined,
  cached: readonly CachedEngine[],
  asked: BuildPick | null,
): BuildChoice {
  if (asked !== null && asked !== "latest") {
    const wanted = cached.find((one) => one.release.published === asked.published);
    // The cache moved since the list was drawn. Refusing beats silently running a different build.
    if (wanted === undefined) return { run: "nothing" };
    return deployed?.published === asked.published
      ? { run: "here", pin: true }
      : { run: "deploy", build: wanted, pin: true };
  }

  const newest = cached[0];
  if (deployed === undefined) {
    return newest === undefined ? { run: "nothing" } : { run: "deploy", build: newest, pin: false };
  }
  if (deployed.pinned && asked === null) return { run: "here", pin: true };
  // The instants are ISO 8601, so a lexical comparison is chronological.
  if (newest !== undefined && newest.release.published > deployed.published) {
    return { run: "deploy", build: newest, pin: false };
  }
  return { run: "here", pin: false };
}

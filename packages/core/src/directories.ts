/**
 * The directories ZAX keeps under the per-user cache. Named in one place because the interface offers to open
 * and to wipe them, and a second spelling of one of these would wipe a directory nothing is written to while
 * the real one grew without bound.
 */

import type { Platform } from "@zax/platform";

/** Copies of config files taken before each save, and of game files replaced by an sfall update. */
export const backupDirectory = (platform: Platform): string => platform.paths.join(platform.paths.cache, "backup");

/** Debug archives prepared for bug reports. */
export const debugDirectory = (platform: Platform): string => platform.paths.join(platform.paths.cache, "debug");

/** Scratch space for downloads and for listings that go into an archive. Safe to remove at any point. */
export const temporaryDirectory = (platform: Platform): string => platform.paths.join(platform.paths.cache, "tmp");

/**
 * Release archives, kept by version. They are what a merge reads the previous version's defaults out of, and
 * what makes changing version again cost an extract rather than a download. Genuinely a cache: everything here
 * can be fetched again, which is why emptying it is offered.
 */
export const packageDirectory = (platform: Platform): string =>
  platform.paths.join(platform.paths.cache, "packages");

export const logFile = (platform: Platform): string => platform.paths.join(platform.paths.cache, "zax.log");

/**
 * Every backend operation, by name, in a module that imports nothing at runtime.
 *
 * Separate from the backend itself so the preload can carry the list without the implementation behind it: the
 * type import below is erased at build time, leaving a bundle of one array rather than the whole domain layer
 * in a script that only needs to know what to forward.
 *
 * The desktop build registers one channel per entry and the preload builds one caller per entry, so the two
 * halves of the boundary cannot drift apart. A test asserts this covers the interface, which is what a
 * hand-maintained list would eventually stop doing.
 */

import type { Backend } from "./backend.js";

export const BACKEND_METHODS = [
  "describe",
  "loadState",
  "saveState",
  "loadConfigFiles",
  "saveConfigFiles",
  "identifyInstall",
  "scanForInstalls",
  "installedSfallVersion",
  "latestSfall",
  "updateSfall",
  "latestZax",
  "listSaves",
  "createDebugPackage",
  "launch",
  "open",
  "wipe",
] as const satisfies ReadonlyArray<keyof Backend>;

export type BackendMethod = (typeof BACKEND_METHODS)[number];

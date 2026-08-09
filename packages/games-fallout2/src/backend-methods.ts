/**
 * Every backend operation, by name, in a module that imports nothing at runtime.
 *
 * Separate from the backend itself so the preload can carry the list without the implementation behind it: the
 * type import below is erased at build time, leaving a bundle of this module alone rather than the whole
 * domain layer in a script that only needs to know what to forward.
 *
 * The desktop build registers one channel per entry and the preload builds one caller per entry, so the two
 * halves of the boundary cannot drift apart. A test asserts this covers the interface, which is what a
 * hand-maintained list would eventually stop doing.
 */

import type { Backend } from "./backend.js";

export const BACKEND_METHODS = [
  "describe",
  "chooseFolder",
  "loadState",
  "saveState",
  "loadConfigFiles",
  "saveConfigFiles",
  "identifyInstall",
  "scanForInstalls",
  "installedSfallVersion",
  "latestSfall",
  "updateSfall",
  "listSfallVersions",
  "installedHiresVersion",
  "latestZax",
  "listSaves",
  "createDebugPackage",
  "launch",
  "open",
  "wipe",
] as const satisfies ReadonlyArray<keyof Backend>;

export type BackendMethod = (typeof BACKEND_METHODS)[number];

/**
 * A backend built by making one function per operation. The one cast lives here instead of at every site that
 * builds or wraps a backend: the object holds exactly the interface's keys by construction, which is the claim
 * the cast makes and the coverage test checks.
 */
export function fromMethods(make: (method: BackendMethod) => (...args: unknown[]) => unknown): Backend {
  return Object.fromEntries(BACKEND_METHODS.map((method) => [method, make(method)])) as unknown as Backend;
}

/** A backend whose every operation goes through `wrap` on its way to the one behind it. */
export function wrapMethods(
  backend: Backend,
  wrap: (call: (...args: unknown[]) => unknown, method: BackendMethod) => (...args: unknown[]) => unknown,
): Backend {
  // Indexed by method name, which the interface's per-method signatures do not allow without widening.
  const callable = backend as unknown as Record<BackendMethod, (...args: unknown[]) => unknown>;
  return fromMethods((method) => wrap((...args) => callable[method](...args), method));
}

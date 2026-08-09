/**
 * The main-process side of the channel, separated from the ipcMain registration so the boundary's behavior -
 * the allowlist, the failure logging, the rethrow - runs under tests that have no Electron in the room.
 */

import type { Backend } from "@zax/fallout2";
import { BACKEND_METHODS } from "@zax/fallout2/backend-methods";

export const describeError = (error: unknown): string =>
  error instanceof Error ? (error.stack ?? error.message) : String(error);

export function createDispatch(
  backend: Backend,
  log: (line: string) => void,
): (method: string, args: unknown[]) => Promise<unknown> {
  const callable = backend as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  return async (method, args) => {
    // Only the named operations, and only by exact name: a renderer asking for anything else gets an error
    // rather than a lookup on the object's prototype.
    if (!(BACKEND_METHODS as readonly string[]).includes(method)) throw new Error(`Unknown operation: ${method}`);
    try {
      return await callable[method]!(...args);
    } catch (error) {
      // The renderer's notice shows the message; the log keeps the stack, which the notice cannot carry.
      log(`${method} failed: ${describeError(error)}`);
      throw error;
    }
  };
}

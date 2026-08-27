/**
 * What a worker threw, as text a message can carry.
 *
 * `String(error)` is not enough for the workers 7-Zip runs in. Emscripten throws plain objects rather than
 * errors - `FS.ErrnoError` carries an errno and nothing else, `ExitStatus` a message and a status, and neither
 * class extends `Error` or declares a `toString` - so every failure that is not a non-zero exit reaches the
 * user as "[object Object]" and the only account of it is gone. The errno is the diagnosis, so it is what this
 * keeps.
 */

/** The fields such an object carries are its own and enumerable, which is what makes them readable here. */
function fieldsOf(error: object): { name: string; message: string; numbers: readonly string[] } {
  const held = error as Record<string, unknown>;
  return {
    name: typeof held["name"] === "string" ? held["name"] : "a failure",
    message: typeof held["message"] === "string" ? held["message"] : "",
    numbers: Object.entries(held)
      .filter(([, value]) => typeof value === "number")
      .map(([key, value]) => `${key} ${String(value)}`),
  };
}

export function failureText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error === null || typeof error !== "object") return String(error);
  const { name, message, numbers } = fieldsOf(error);
  return `${name}${message === "" ? "" : `: ${message}`}${numbers.length === 0 ? "" : ` (${numbers.join(", ")})`}`;
}

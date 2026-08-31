/**
 * The narrowing every read of an external document starts from: a parsed value whose keys can be read.
 *
 * Spelled out rather than `typeof value === "object"` alone, which is also true of null and of an array - and
 * an array reached through a keyed read is the shape that produces `undefined` fields rather than a refusal.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * FNV-1a, 64-bit, as sixteen hex digits.
 *
 * For the places that want a short stable name for a string and depend on nothing being hard to forge: a
 * record's filename, a transaction's working directory, the fingerprint that says a plan is still the plan.
 * Not WebCrypto - `crypto.subtle` is absent in the browser preview when it is served over plain http away
 * from localhost, and all of these run there too.
 */

export function fnv1a(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

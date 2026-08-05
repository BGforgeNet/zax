/**
 * Comparing dotted version strings. Both versions this application reads - sfall's from a DLL resource, its own
 * from a release tag - are plain numeric sequences, so this compares them number by number rather than pulling
 * in a full semantic-version implementation for a case neither of them has.
 */

/** Negative when `a` is older, positive when newer, zero when the two name the same version. */
export function compareVersions(a: string, b: string): number {
  // Not `parseInt`, which stops at the first non-digit and reads "5-beta" as 5 - so a pre-release would compare
  // equal to the release it precedes.
  const parts = (version: string) =>
    version
      .replace(/^v/i, "")
      .split(".")
      .map((piece) => (/^\d+$/.test(piece) ? Number(piece) : Number.NaN));
  const left = parts(a);
  const right = parts(b);
  for (let at = 0; at < Math.max(left.length, right.length); at++) {
    // A missing component is zero, so 4.5 and 4.5.0 are the same version rather than one being older.
    const one = left[at] ?? 0;
    const other = right[at] ?? 0;
    if (Number.isNaN(one) || Number.isNaN(other)) return a === b ? 0 : a.localeCompare(b);
    if (one !== other) return one - other;
  }
  return 0;
}

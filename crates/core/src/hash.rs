//! FNV-1a, 64-bit, as sixteen hex digits.
//!
//! For the places that want a short stable name for a string and depend on nothing being hard to
//! forge: a record's filename, a transaction's working directory, the fingerprint that says a plan
//! is still the plan. Never for anything security-bearing.

const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const PRIME: u64 = 0x0000_0100_0000_01b3;

#[must_use]
pub fn fnv1a(text: &str) -> String {
    let mut hash = OFFSET;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(PRIME);
    }
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_published_vectors() {
        // The reference digests for FNV-1a 64, which is what makes this a port rather than a new
        // hash: a record written by the TypeScript build has to keep its filename.
        assert_eq!(fnv1a(""), "cbf29ce484222325");
        assert_eq!(fnv1a("a"), "af63dc4c8601ec8c");
        assert_eq!(fnv1a("foobar"), "85944171f73967e8");
    }

    #[test]
    fn is_always_sixteen_digits() {
        for text in ["", "a", "a longer string", "\u{00e9}"] {
            assert_eq!(fnv1a(text).len(), 16, "{text:?} hashed to the wrong width");
        }
    }

    #[test]
    fn hashes_the_utf8_bytes() {
        // Two strings differing only past the ASCII range must not collide through a truncated byte.
        assert_ne!(fnv1a("\u{00e9}"), fnv1a("e"));
    }
}

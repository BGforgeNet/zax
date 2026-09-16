//! Comparing dotted version strings.
//!
//! Both versions this application reads - sfall's from a DLL resource, its own from a release tag -
//! are plain numeric sequences, so this compares them number by number rather than pulling in a full
//! semantic-version implementation for a case neither of them has.

use std::cmp::Ordering;

/// One component, or `None` where it is not a plain number.
///
/// Not a permissive integer parse, which stops at the first non-digit and reads "5-beta" as 5 - so a
/// pre-release would compare equal to the release it precedes.
fn component(piece: &str) -> Option<u64> {
    if piece.is_empty() || !piece.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    piece.parse().ok()
}

fn components(version: &str) -> Vec<Option<u64>> {
    let trimmed = version
        .strip_prefix('v')
        .or_else(|| version.strip_prefix('V'))
        .unwrap_or(version);
    trimmed.split('.').map(component).collect()
}

/// `Less` when `a` is older, `Greater` when newer, `Equal` when the two name the same version.
#[must_use]
pub fn compare_versions(a: &str, b: &str) -> Ordering {
    let left = components(a);
    let right = components(b);
    for at in 0..left.len().max(right.len()) {
        // A missing component is zero, so 4.5 and 4.5.0 are the same version rather than one being
        // older.
        let (Some(one), Some(other)) = (
            left.get(at).copied().unwrap_or(Some(0)),
            right.get(at).copied().unwrap_or(Some(0)),
        ) else {
            // A component that is not a number is not orderable as one. The TypeScript fell back to
            // `localeCompare` here; this compares bytes instead, because a locale-dependent order
            // would make the same two versions sort differently on different machines.
            return a.cmp(b);
        };
        if one != other {
            return one.cmp(&other);
        }
    }
    Ordering::Equal
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orders_by_each_component_in_turn() {
        assert_eq!(compare_versions("4.4", "4.5"), Ordering::Less);
        assert_eq!(compare_versions("4.5", "4.4"), Ordering::Greater);
        assert_eq!(compare_versions("4.10", "4.9"), Ordering::Greater);
    }

    #[test]
    fn a_missing_component_is_zero() {
        assert_eq!(compare_versions("4.5", "4.5.0"), Ordering::Equal);
        assert_eq!(compare_versions("4.5.1", "4.5"), Ordering::Greater);
    }

    #[test]
    fn a_leading_v_is_ignored() {
        assert_eq!(compare_versions("v4.5", "4.5"), Ordering::Equal);
        assert_eq!(compare_versions("V4.5", "4.6"), Ordering::Less);
    }

    #[test]
    fn a_pre_release_does_not_compare_equal_to_its_release() {
        assert_ne!(compare_versions("4.5-beta", "4.5"), Ordering::Equal);
    }

    #[test]
    fn identical_strings_are_equal_even_when_unparseable() {
        assert_eq!(compare_versions("weird", "weird"), Ordering::Equal);
    }
}

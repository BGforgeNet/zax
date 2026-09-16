//! Merging one INI file into another across a version change.
//!
//! A two-way overlay - write every value the user has over the new file - cannot tell a setting the
//! user chose from one they never touched, so the old default wins even where the new release
//! deliberately changed it, and a key the release retired comes back forever. Knowing what the
//! *previous* release shipped answers both: a value equal to the old default was never chosen, and
//! one the release dropped is only worth keeping if it was.

use crate::ini::IniDocument;

/// A key both sides changed. The user's value is kept; the caller decides whether to say so.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct MergeConflict {
    pub section: String,
    pub key: String,
    pub mine: String,
    pub theirs: String,
}

/// A key the release retired that the user had left at the old default, so it is gone from the
/// result.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RemovedKey {
    pub section: String,
    pub key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergeOutcome {
    /// The release's document, with the user's settings written into it.
    pub document: IniDocument,
    pub conflicts: Vec<MergeConflict>,
    pub removed: Vec<RemovedKey>,
}

/// Writes `mine` into `theirs`, using `base` - what the installed version shipped - to tell a chosen
/// value from an untouched one. `theirs` is consumed and returned, because it is what carries the
/// release's own comments and key order, which is the reason it is the side we build on.
///
/// With no `base` this degrades to the two-way overlay: every value the user has wins. That is the
/// right answer for an install whose previous version was never recorded, and it is not silently
/// worse than doing nothing.
///
/// Values move through their latin1 text form rather than raw bytes. That mapping is one to one, so
/// comparing and rewriting through it is lossless.
#[must_use]
pub fn merge_ini(
    mut theirs: IniDocument,
    mine: &IniDocument,
    base: Option<&IniDocument>,
) -> MergeOutcome {
    let mut conflicts = Vec::new();
    let mut removed = Vec::new();

    for entry in mine.entries() {
        let Some(base) = base else {
            theirs.set_str(&entry.section, &entry.key, &entry.value);
            continue;
        };

        let their_value = theirs.get_str(&entry.section, &entry.key);
        let base_value = base.get_str(&entry.section, &entry.key);

        // Left at what the installed version shipped, so it was never a choice: whatever the release
        // says now stands, including the release having dropped the key.
        if base_value.as_ref() == Some(&entry.value) {
            if their_value.is_none() {
                removed.push(RemovedKey {
                    section: entry.section.clone(),
                    key: entry.key.clone(),
                });
            }
            continue;
        }

        theirs.set_str(&entry.section, &entry.key, &entry.value);

        // A key neither the base nor the release has is the user's own addition, not a disagreement.
        let (Some(their_value), Some(base_value)) = (their_value, base_value) else {
            continue;
        };
        if their_value != base_value {
            conflicts.push(MergeConflict {
                section: entry.section.clone(),
                key: entry.key.clone(),
                mine: entry.value.clone(),
                theirs: their_value,
            });
        }
    }

    MergeOutcome {
        document: theirs,
        conflicts,
        removed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(text: &str) -> IniDocument {
        IniDocument::parse(text.as_bytes())
    }

    fn rendered(doc: &IniDocument) -> String {
        String::from_utf8(doc.to_bytes()).expect("the test inputs are ASCII")
    }

    #[test]
    fn with_no_base_every_value_the_user_has_wins() {
        let theirs = doc("[S]\nA=new\nB=new\n");
        let mine = doc("[S]\nA=mine\n");
        let out = merge_ini(theirs, &mine, None);
        assert_eq!(out.document.get_str("S", "A").as_deref(), Some("mine"));
        assert_eq!(out.document.get_str("S", "B").as_deref(), Some("new"));
        assert!(out.conflicts.is_empty());
        assert!(out.removed.is_empty());
    }

    #[test]
    fn a_value_left_at_the_old_default_yields_to_the_release() {
        let theirs = doc("[S]\nA=2\n");
        let mine = doc("[S]\nA=1\n");
        let base = doc("[S]\nA=1\n");
        let out = merge_ini(theirs, &mine, Some(&base));
        assert_eq!(out.document.get_str("S", "A").as_deref(), Some("2"));
        assert!(out.conflicts.is_empty());
    }

    #[test]
    fn a_value_the_user_chose_is_kept() {
        let theirs = doc("[S]\nA=2\n");
        let mine = doc("[S]\nA=9\n");
        let base = doc("[S]\nA=1\n");
        let out = merge_ini(theirs, &mine, Some(&base));
        assert_eq!(out.document.get_str("S", "A").as_deref(), Some("9"));
    }

    #[test]
    fn a_key_both_sides_changed_is_a_conflict_the_user_wins() {
        let theirs = doc("[S]\nA=2\n");
        let mine = doc("[S]\nA=9\n");
        let base = doc("[S]\nA=1\n");
        let out = merge_ini(theirs, &mine, Some(&base));
        assert_eq!(
            out.conflicts,
            vec![MergeConflict {
                section: "S".to_owned(),
                key: "A".to_owned(),
                mine: "9".to_owned(),
                theirs: "2".to_owned(),
            }]
        );
    }

    #[test]
    fn a_retired_key_at_the_old_default_is_reported_and_dropped() {
        let theirs = doc("[S]\nB=1\n");
        let mine = doc("[S]\nA=1\nB=1\n");
        let base = doc("[S]\nA=1\nB=1\n");
        let out = merge_ini(theirs, &mine, Some(&base));
        assert_eq!(
            out.removed,
            vec![RemovedKey {
                section: "S".to_owned(),
                key: "A".to_owned(),
            }]
        );
        assert_eq!(out.document.get_str("S", "A"), None);
    }

    #[test]
    fn a_retired_key_the_user_had_chosen_is_carried_over() {
        let theirs = doc("[S]\nB=1\n");
        let mine = doc("[S]\nA=9\nB=1\n");
        let base = doc("[S]\nA=1\nB=1\n");
        let out = merge_ini(theirs, &mine, Some(&base));
        assert!(out.removed.is_empty());
        assert_eq!(out.document.get_str("S", "A").as_deref(), Some("9"));
    }

    #[test]
    fn a_key_the_user_added_themselves_is_not_a_conflict() {
        let theirs = doc("[S]\nB=1\n");
        let mine = doc("[S]\nOwn=7\nB=1\n");
        let base = doc("[S]\nB=1\n");
        let out = merge_ini(theirs, &mine, Some(&base));
        assert!(out.conflicts.is_empty());
        assert_eq!(out.document.get_str("S", "Own").as_deref(), Some("7"));
    }

    #[test]
    fn the_release_comments_and_key_order_survive_the_merge() {
        // The release's document is the side built on precisely so its own documentation is kept.
        let theirs = doc("; release notes\n[S]\nA=2 ; explains A\n");
        let mine = doc("[S]\nA=9\n");
        let base = doc("[S]\nA=1\n");
        let out = merge_ini(theirs, &mine, Some(&base));
        let text = rendered(&out.document);
        assert!(text.starts_with("; release notes\n"), "{text}");
        assert!(text.contains("A=9 ; explains A"), "{text}");
    }
}

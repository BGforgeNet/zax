//! Settling a setting several engines carry when their files have come to disagree.
//!
//! ZAX writes one value to every live address at once, so two addresses only ever differ because
//! something else changed one - the engine's own preferences screen, or a hand edit. Which side moved
//! is answered by the base: the value ZAX itself last wrote there, kept in the install's record.
//! Without one the only available rule is to prefer the setting's own address, which is right the first
//! time and wrong afterwards, since it would revert whatever the user had just changed inside the
//! engine.
//!
//! A base is also what accepting a disagreement records. Reverting a carry is the user saying these
//! engines may differ, and nothing on disk changes when they do - so without somewhere to put that
//! answer the next load reads the same files against the same bases and asks again, forever.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use zax_core::catalog::{SettingDef, SettingTarget};
use zax_core::config_io::ConfigFileContents;
use zax_core::ini::IniDocument;
use zax_core::text::latin1;

use crate::engine_config::live_targets;

/// How a base is keyed. Unique across the catalog, which the catalog's own test asserts from the other
/// side.
#[must_use]
pub fn address_of(target: &SettingTarget) -> String {
    address(&target.file, &target.section, &target.key)
}

/// The same key from the three parts alone, for a caller holding an address that is not a target -
/// a config change on its way into the record.
#[must_use]
pub fn address(file: &str, section: &str, key: &str) -> String {
    format!("{file}|{section}|{key}")
}

/// One address taking part, and what it now says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeldTarget {
    pub target: SettingTarget,
    pub value: String,
}

/// One linked setting whose addresses do not agree, and what needs doing about it. At most one of
/// `settle` and `choose` is set: neither, where the disagreement has already been accepted and there is
/// nothing left to do - it is still reported, because a caller has to know these addresses differ
/// whether or not it is being asked to act on them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Divergence {
    pub id: String,
    /// Every address taking part, as it now reads. What accepting the disagreement records as the new
    /// base: the caller holds no other view of which addresses were weighed, and re-deriving them from
    /// the files a second time is a second answer to the same question.
    pub at: Vec<HeldTarget>,
    /// The value that survives and where it came from. It is by definition a value ZAX did not write,
    /// so the interface says where it came from rather than propagating it silently.
    pub settle: Option<HeldTarget>,
    /// Two addresses moved since ZAX wrote, so which value survives is the user's to choose, not ZAX's.
    pub choose: Option<Vec<HeldTarget>>,
}

/// What every linked setting in this install needs, read off the files as they are now.
///
/// An address holding no value at all takes no part. A key a file does not carry means that component's
/// own default rather than a value, so it cannot disagree with anything - and filling it in from a
/// partner would change what the component does, unasked, on a load the user only meant as a load.
#[must_use]
pub fn reconcile_settings(
    settings: &[SettingDef],
    contents: &ConfigFileContents,
    written: &BTreeMap<String, String>,
) -> Vec<Divergence> {
    // Parsed once per file rather than once per address: a config file carries many settings, and every
    // linked one would otherwise re-parse it.
    let mut documents: HashMap<&str, Option<IniDocument>> = HashMap::new();
    let mut out = Vec::new();
    for def in settings {
        if def.targets.len() < 2 {
            continue;
        }
        let stated: Vec<HeldTarget> = live_targets(def, contents)
            .into_iter()
            .filter_map(|target| {
                let document = documents.entry(target.file.as_str()).or_insert_with(|| {
                    contents
                        .get(&target.file)
                        .and_then(Option::as_deref)
                        .map(IniDocument::parse)
                });
                let value = document.as_ref()?.get(&target.section, &target.key)?;
                Some(HeldTarget {
                    target: target.clone(),
                    value: latin1(value),
                })
            })
            .collect();
        if stated.len() < 2 {
            continue;
        }
        let values: BTreeSet<&str> = stated.iter().map(|one| one.value.as_str()).collect();
        if values.len() == 1 {
            continue;
        }

        // An address ZAX has never written cannot have moved: it holds whatever put it there, which is
        // what a newly installed engine's own first run leaves behind.
        let moved: Vec<&HeldTarget> = stated
            .iter()
            .filter(|one| {
                written
                    .get(&address_of(&one.target))
                    .is_some_and(|base| *base != one.value)
            })
            .collect();
        if moved.is_empty() {
            // Every address holding a base holds exactly what ZAX left there. Where that is all of
            // them, the disagreement is one ZAX has already been told about and had accepted -
            // reverting the carry is what records it - so asking again is the loop that acceptance
            // exists to end. Reported all the same: the addresses still differ, and an edit to this
            // setting still has to reach the ones that lag.
            let all_based = stated
                .iter()
                .all(|one| written.contains_key(&address_of(&one.target)));
            // Otherwise nothing here says which side is the newer intention. The setting's own address
            // wins: `ddraw.ini` and `f2_res.ini` hold only what a person put there, while an engine
            // writes a value for every key it knows the first time it runs.
            let settle = (!all_based).then(|| stated[0].clone());
            out.push(Divergence {
                id: def.id.clone(),
                at: stated,
                settle,
                choose: None,
            });
            continue;
        }
        let agreed: BTreeSet<&str> = moved.iter().map(|one| one.value.as_str()).collect();
        let (settle, choose) = if agreed.len() == 1 {
            (Some(moved[0].clone()), None)
        } else {
            (None, Some(moved.into_iter().cloned().collect()))
        };
        out.push(Divergence {
            id: def.id.clone(),
            at: stated,
            settle,
            choose,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One setting at two addresses, the second belonging to an engine that has already run.
    fn linked() -> SettingDef {
        serde_json::from_str(
            r#"{"id":"ddraw.Misc.Foo","label":"Foo","targets":[
                 {"file":"ddraw.ini","section":"Misc","key":"Foo"},
                 {"file":"fission.cfg","section":"Misc","key":"Foo","engine":"fission"}
               ],"kind":{"type":"bool","onValue":"1","offValue":"0"}}"#,
        )
        .expect("a setting the test writes")
    }

    fn contents(pairs: &[(&str, &str)]) -> ConfigFileContents {
        pairs
            .iter()
            .map(|(name, text)| ((*name).to_owned(), Some(text.as_bytes().to_vec())))
            .collect()
    }

    fn files(left: &str, right: &str) -> ConfigFileContents {
        contents(&[
            ("ddraw.ini", &format!("[Misc]\nFoo={left}\n")),
            ("fission.cfg", &format!("[Misc]\nFoo={right}\n")),
        ])
    }

    fn bases(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(at, value)| ((*at).to_owned(), (*value).to_owned()))
            .collect()
    }

    const DDRAW: &str = "ddraw.ini|Misc|Foo";
    const FISSION: &str = "fission.cfg|Misc|Foo";

    #[test]
    fn addresses_that_agree_are_not_reported() {
        let found = reconcile_settings(&[linked()], &files("1", "1"), &bases(&[]));
        assert!(found.is_empty());
    }

    #[test]
    fn an_address_holding_no_value_takes_no_part() {
        // A key the file does not carry is that component's own default, not a value to disagree with.
        let only_one = contents(&[
            ("ddraw.ini", "[Misc]\nFoo=1\n"),
            ("fission.cfg", "[Misc]\n"),
        ]);
        assert!(reconcile_settings(&[linked()], &only_one, &bases(&[])).is_empty());
    }

    #[test]
    fn with_no_base_the_settings_own_address_wins() {
        let found = reconcile_settings(&[linked()], &files("1", "0"), &bases(&[]));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].at.len(), 2);
        let settle = found[0].settle.as_ref().expect("a side to settle on");
        assert_eq!(settle.target.file, "ddraw.ini");
        assert_eq!(settle.value, "1");
    }

    #[test]
    fn the_side_that_moved_off_its_base_is_the_newer_intention() {
        // ZAX wrote 1 to both; the engine's own screen since changed its copy.
        let found = reconcile_settings(
            &[linked()],
            &files("1", "0"),
            &bases(&[(DDRAW, "1"), (FISSION, "1")]),
        );
        let settle = found[0].settle.as_ref().expect("the side that moved");
        assert_eq!(settle.target.file, "fission.cfg");
        assert_eq!(settle.value, "0");
        assert!(found[0].choose.is_none());
    }

    #[test]
    fn two_sides_moving_apart_is_the_users_to_choose() {
        let found = reconcile_settings(
            &[linked()],
            &files("2", "3"),
            &bases(&[(DDRAW, "1"), (FISSION, "1")]),
        );
        let choose = found[0].choose.as_ref().expect("two sides moved");
        assert_eq!(choose.len(), 2);
        assert!(found[0].settle.is_none());
    }

    #[test]
    fn two_sides_moving_to_the_same_value_settle_on_it() {
        // They disagree with a third address, not with each other.
        let def: SettingDef = serde_json::from_str(
            r#"{"id":"x","label":"X","targets":[
                 {"file":"a.ini","section":"S","key":"K"},
                 {"file":"b.ini","section":"S","key":"K"},
                 {"file":"c.ini","section":"S","key":"K"}
               ],"kind":{"type":"bool","onValue":"1","offValue":"0"}}"#,
        )
        .expect("a setting the test writes");
        let held = contents(&[
            ("a.ini", "[S]\nK=9\n"),
            ("b.ini", "[S]\nK=9\n"),
            ("c.ini", "[S]\nK=1\n"),
        ]);
        let found = reconcile_settings(
            &[def],
            &held,
            &bases(&[("a.ini|S|K", "1"), ("b.ini|S|K", "1"), ("c.ini|S|K", "1")]),
        );
        assert_eq!(
            found[0].settle.as_ref().map(|one| one.value.as_str()),
            Some("9")
        );
    }

    #[test]
    fn an_accepted_disagreement_is_reported_with_nothing_left_to_do() {
        // Reverting the carry recorded both bases as they stand; asking again is the loop acceptance
        // exists to end.
        let found = reconcile_settings(
            &[linked()],
            &files("1", "0"),
            &bases(&[(DDRAW, "1"), (FISSION, "0")]),
        );
        assert_eq!(found.len(), 1, "the addresses still differ, so it is said");
        assert!(found[0].settle.is_none());
        assert!(found[0].choose.is_none());
    }

    #[test]
    fn a_setting_at_one_address_can_never_diverge() {
        let alone: SettingDef = serde_json::from_str(
            r#"{"id":"x","label":"X","targets":[{"file":"ddraw.ini","section":"Misc","key":"Foo"}],
               "kind":{"type":"bool","onValue":"1","offValue":"0"}}"#,
        )
        .expect("a setting the test writes");
        assert!(reconcile_settings(&[alone], &files("1", "0"), &bases(&[])).is_empty());
    }

    #[test]
    fn a_dormant_engines_address_takes_no_part() {
        // `live_targets` leaves it out, so what its file happens to hold cannot start a divergence.
        let held = contents(&[("ddraw.ini", "[Misc]\nFoo=1\n")]);
        let mut with_stale = held.clone();
        with_stale.insert("fission.cfg".to_owned(), None);
        assert!(reconcile_settings(&[linked()], &with_stale, &bases(&[])).is_empty());
    }
}

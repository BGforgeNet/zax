//! Every setting ZAX knows about, generated from the format definitions.
//!
//! The data is `data/catalog.json`, written by `scripts/gen/gen-catalog.mjs` from the same tables
//! the TypeScript build reads. Editing that file is lost on the next regeneration; change the
//! generator instead.
//!
//! Deserialized rather than compiled: 227 settings as struct literals would be thousands of lines of
//! generated Rust and a build cost on every touch of this crate, for a parse that happens once.

use std::sync::OnceLock;

use zax_core::catalog::SettingDef;

/// Generated. See the module documentation before reaching for this file.
const CATALOG: &str = include_str!("../data/catalog.json");

/// Every setting the catalog holds, in the order the previous interface laid them out.
///
/// # Panics
///
/// Panics when the generated catalog does not parse, which means the generator and these types have
/// diverged. That is a build-time fault dressed as a runtime one: there is no version of this
/// application that works without its catalog, and the test below is what catches it before a
/// release.
#[must_use]
pub fn settings() -> &'static [SettingDef] {
    static PARSED: OnceLock<Vec<SettingDef>> = OnceLock::new();
    PARSED
        .get_or_init(|| {
            serde_json::from_str(CATALOG)
                .unwrap_or_else(|err| panic!("the generated catalog does not parse: {err}"))
        })
        .as_slice()
}

/// One setting by id, or `None` where nothing carries it.
#[must_use]
pub fn setting(id: &str) -> Option<&'static SettingDef> {
    settings().iter().find(|def| def.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeMap, BTreeSet};
    use zax_core::catalog::SettingKind;

    #[test]
    fn the_generated_catalog_parses() {
        // The guard the panic above describes: a generator change that these types cannot read fails
        // here rather than at a user's first launch.
        assert!(settings().len() > 200, "only {} settings", settings().len());
    }

    #[test]
    fn every_setting_has_an_id_a_label_and_an_address() {
        for def in settings() {
            assert!(!def.id.is_empty(), "a setting has no id");
            assert!(!def.label.is_empty(), "{} has no label", def.id);
            let own = def.targets.own();
            assert!(!own.file.is_empty(), "{} has no file", def.id);
            assert!(!own.key.is_empty(), "{} has no key", def.id);
        }
    }

    #[test]
    fn no_two_settings_share_an_id() {
        let mut seen = BTreeSet::new();
        for def in settings() {
            assert!(seen.insert(&def.id), "{} is defined twice", def.id);
        }
    }

    #[test]
    fn an_address_belongs_to_at_most_one_setting() {
        // Two settings writing one key would each overwrite the other, and neither row would show
        // what the file actually holds.
        let mut owners: BTreeMap<(String, String, String), &str> = BTreeMap::new();
        for def in settings() {
            for target in def.targets.iter() {
                let at = (
                    target.file.clone(),
                    target.section.to_lowercase(),
                    target.key.to_lowercase(),
                );
                if let Some(held) = owners.insert(at.clone(), &def.id) {
                    panic!("{at:?} is claimed by both {held} and {}", def.id);
                }
            }
        }
    }

    #[test]
    fn a_settings_id_is_minted_from_its_own_first_target() {
        // The id is a file prefix plus the setting's section.key verbatim, and the nominated target
        // is the address it came from.
        for def in settings() {
            let own = def.targets.own();
            let tail = format!("{}.{}", own.section, own.key);
            assert!(
                def.id.ends_with(&tail),
                "{} does not end with its own address {tail}",
                def.id
            );
        }
    }

    #[test]
    fn a_gate_and_a_conflict_both_name_a_setting_that_exists() {
        // An id that matches nothing is otherwise invisible.
        let known: BTreeSet<&str> = settings().iter().map(|def| def.id.as_str()).collect();
        for def in settings() {
            for target in def.targets.iter() {
                if let Some(gate) = &target.gated_by {
                    assert!(
                        known.contains(gate.id.as_str()),
                        "{} gates on {}",
                        def.id,
                        gate.id
                    );
                }
            }
            if let Some(conflict) = &def.conflicts_with {
                assert!(
                    known.contains(conflict.id.as_str()),
                    "{} conflicts with {}",
                    def.id,
                    conflict.id
                );
            }
        }
    }

    #[test]
    fn a_choice_offers_options_and_no_two_share_a_value() {
        for def in settings() {
            let SettingKind::Choice { options } = &def.kind else {
                continue;
            };
            assert!(
                !options.is_empty(),
                "{} is a choice with no options",
                def.id
            );
            let mut seen = BTreeSet::new();
            for option in options {
                assert!(
                    seen.insert(&option.value),
                    "{} offers {} twice",
                    def.id,
                    option.value
                );
                assert!(
                    !option.label.is_empty(),
                    "{} has an unlabelled option",
                    def.id
                );
            }
        }
    }

    #[test]
    fn a_bool_has_two_different_spellings() {
        for def in settings() {
            let SettingKind::Bool {
                on_value,
                off_value,
            } = &def.kind
            else {
                continue;
            };
            assert_ne!(on_value, off_value, "{} spells on and off alike", def.id);
        }
    }

    #[test]
    fn a_bounded_number_has_its_bounds_the_right_way_round() {
        for def in settings() {
            let (SettingKind::Int(kind) | SettingKind::Float(kind)) = &def.kind else {
                continue;
            };
            if let (Some(min), Some(max)) = (kind.min, kind.max) {
                assert!(min <= max, "{} has min {min} above max {max}", def.id);
            }
        }
    }

    #[test]
    fn a_scale_carries_a_ceiling_above_zero() {
        for def in settings() {
            if let SettingKind::Scale { max } = &def.kind {
                assert!(*max > 0.0, "{} is a scale with a ceiling of {max}", def.id);
            }
        }
    }

    #[test]
    fn a_setting_can_be_looked_up_by_id() {
        let first = &settings()[0];
        assert_eq!(setting(&first.id).map(|d| &d.id), Some(&first.id));
        assert!(setting("nothing.at.all").is_none());
    }
}

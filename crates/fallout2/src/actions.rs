//! What a user actually comes to ZAX to do.
//!
//! Each action writes several settings at once, across more than one config file, so that an
//! intention is one click rather than a hunt through categories.
//!
//! Target values are the raw strings the config files hold, taken from the same catalog the settings
//! view uses.
//!
//! An action must write more than one setting. A single-key action is just a second path to a
//! control the settings list already offers, and it hides whichever other values that control
//! accepts.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use zax_core::action::{Action, ActionGroup, WineSetting};
use zax_core::install::DEFAULT_WINE_DEBUG;

fn targets(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(id, value)| ((*id).to_owned(), (*value).to_owned()))
        .collect()
}

const DEBUG_KEYS: &[&str] = &[
    "sfall.Debugging.DebugMode",
    "sfall.Debugging.Init",
    "sfall.Debugging.Hook",
    "sfall.Debugging.Script",
    "sfall.Debugging.Criticals",
    "sfall.Debugging.Fixes",
    "game.debug.output_map_data_info",
    "game.debug.show_load_info",
    "game.debug.show_script_messages",
    "game.debug.show_tile_num",
    "game.sound.debug",
    "game.sound.debug_sfxc",
];

/// The debugging switches at one value. `DebugMode` takes the level rather than a flag, so it is the
/// one key whose "on" is not 1.
fn debug_targets(on: bool) -> BTreeMap<String, String> {
    DEBUG_KEYS
        .iter()
        .map(|id| {
            let value = if !on {
                "0"
            } else if *id == "sfall.Debugging.DebugMode" {
                "2"
            } else {
                "1"
            };
            ((*id).to_owned(), value.to_owned())
        })
        .collect()
}

/// Every action, in the order the panels offer them.
#[must_use]
pub fn actions() -> &'static [Action] {
    static ACTIONS: OnceLock<Vec<Action>> = OnceLock::new();
    ACTIONS.get_or_init(|| {
        vec![
            Action {
                id: "debug.enable".to_owned(),
                group: ActionGroup::Report,
                label: "Enable full debugging".to_owned(),
                description: "Turns on every engine and script log and writes them to debug.log, \
                              and lets Wine report as well. Do this before reproducing a bug you \
                              want to report."
                    .to_owned(),
                applied_label: "Debugging is on".to_owned(),
                // Wine says nothing while WINEDEBUG silences it, so a report made with debugging on
                // would be missing the half that explains a crash before the game ever starts.
                wine: Some(WineSetting {
                    debug: String::new(),
                }),
                targets: debug_targets(true),
            },
            Action {
                id: "debug.disable".to_owned(),
                group: ActionGroup::Report,
                label: "Turn debugging off".to_owned(),
                description:
                    "Restores quiet operation. Logging costs performance, so leave it off \
                              for normal play."
                        .to_owned(),
                applied_label: "Debugging is off".to_owned(),
                wine: Some(WineSetting {
                    debug: DEFAULT_WINE_DEBUG.to_owned(),
                }),
                targets: debug_targets(false),
            },
            Action {
                id: "fix.not-responding".to_owned(),
                group: ActionGroup::Fix,
                label: "Fix \"NOT RESPONDING\" freezes".to_owned(),
                description: "Applies the two compatibility fixes for the window going \
                              unresponsive, most often seen in windowed mode on modern Windows."
                    .to_owned(),
                applied_label: "Fix applied".to_owned(),
                wine: None,
                targets: targets(&[
                    ("hires.INPUT.EXTRA_WIN_MSG_CHECKS", "1"),
                    ("hires.OTHER_SETTINGS.CPU_USAGE_FIX", "1"),
                ]),
            },
            Action {
                id: "speed.up".to_owned(),
                group: ActionGroup::Fix,
                label: "Speed up combat and interface".to_owned(),
                description: "Removes the deliberate pauses in combat, panel animations and \
                              floating text. The single biggest quality-of-life change for a \
                              replay."
                    .to_owned(),
                applied_label: "Already sped up".to_owned(),
                wine: None,
                targets: targets(&[
                    ("game.preferences.combat_speed", "50"),
                    ("game.preferences.text_base_delay", "1.000000"),
                    ("game.preferences.text_line_delay", "0.000000"),
                    ("sfall.Misc.CombatPanelAnimDelay", "0"),
                    ("sfall.Misc.DialogPanelAnimDelay", "0"),
                    ("sfall.Misc.PipboyTimeAnimDelay", "0"),
                    ("sfall.Misc.SpeedInterfaceCounterAnims", "2"),
                ]),
            },
        ]
    })
}

/// One offered shortcut for the high-resolution patch's width and height pair.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Resolution {
    pub width: u32,
    pub height: u32,
    pub note: Option<&'static str>,
}

/// Presets offered as a shortcut for the width/height pair. The engine accepts any size in range, so
/// these never constrain the input.
pub const COMMON_RESOLUTIONS: &[Resolution] = &[
    Resolution {
        width: 3840,
        height: 2160,
        note: Some("4K"),
    },
    Resolution {
        width: 2560,
        height: 1440,
        note: None,
    },
    Resolution {
        width: 1920,
        height: 1080,
        note: Some("1080p"),
    },
    Resolution {
        width: 1600,
        height: 900,
        note: None,
    },
    Resolution {
        width: 1366,
        height: 768,
        note: None,
    },
    Resolution {
        width: 1280,
        height: 1024,
        note: None,
    },
    Resolution {
        width: 1280,
        height: 720,
        note: None,
    },
    Resolution {
        width: 1024,
        height: 768,
        note: None,
    },
    Resolution {
        width: 800,
        height: 600,
        note: None,
    },
    Resolution {
        width: 640,
        height: 480,
        note: Some("original"),
    },
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::setting;
    use std::collections::BTreeSet;
    use zax_core::validate::validate;

    #[test]
    fn every_target_names_a_setting_the_catalog_describes() {
        // An id that matches nothing is otherwise invisible: the action would silently write nowhere.
        for action in actions() {
            for id in action.targets.keys() {
                assert!(
                    setting(id).is_some(),
                    "{} writes to {id}, which the catalog does not describe",
                    action.id
                );
            }
        }
    }

    #[test]
    fn every_target_accepts_the_value_the_action_writes() {
        // The other half of the contract: an id that exists but refuses the value would fail at save
        // time, on the user's machine.
        for action in actions() {
            for (id, value) in &action.targets {
                let def = setting(id).unwrap_or_else(|| panic!("{id} is described"));
                let verdict = validate(def, Some(value));
                assert!(
                    verdict.is_ok(),
                    "{} writes {value} to {id}: {:?}",
                    action.id,
                    verdict.reason()
                );
            }
        }
    }

    #[test]
    fn every_action_writes_more_than_one_setting() {
        // A single-key action is just a second path to a control the settings list already offers.
        for action in actions() {
            assert!(
                action.targets.len() > 1,
                "{} writes only {} setting",
                action.id,
                action.targets.len()
            );
        }
    }

    #[test]
    fn no_two_actions_share_an_id_and_each_is_described() {
        let mut seen = BTreeSet::new();
        for action in actions() {
            assert!(seen.insert(&action.id), "{} is defined twice", action.id);
            assert!(!action.label.is_empty(), "{} has no label", action.id);
            assert!(
                !action.description.is_empty(),
                "{} has no description",
                action.id
            );
            assert!(
                !action.applied_label.is_empty(),
                "{} has no applied wording",
                action.id
            );
        }
    }

    #[test]
    fn enabling_and_disabling_debugging_cover_the_same_keys() {
        // A key one turns on and the other does not would leave debugging half on forever.
        let on = actions()
            .iter()
            .find(|a| a.id == "debug.enable")
            .expect("the enable action");
        let off = actions()
            .iter()
            .find(|a| a.id == "debug.disable")
            .expect("the disable action");
        assert_eq!(
            on.targets.keys().collect::<Vec<_>>(),
            off.targets.keys().collect::<Vec<_>>()
        );
    }

    #[test]
    fn debug_mode_takes_a_level_rather_than_a_flag() {
        let on = actions()
            .iter()
            .find(|a| a.id == "debug.enable")
            .expect("the enable action");
        assert_eq!(
            on.targets
                .get("sfall.Debugging.DebugMode")
                .map(String::as_str),
            Some("2")
        );
        assert_eq!(
            on.targets.get("sfall.Debugging.Init").map(String::as_str),
            Some("1")
        );
    }

    #[test]
    fn turning_debugging_off_restores_the_quiet_wine_default() {
        let off = actions()
            .iter()
            .find(|a| a.id == "debug.disable")
            .expect("the disable action");
        assert_eq!(
            off.wine.as_ref().map(|w| w.debug.as_str()),
            Some(DEFAULT_WINE_DEBUG)
        );
    }

    #[test]
    fn the_resolutions_run_largest_first_and_none_is_listed_twice() {
        let mut seen = BTreeSet::new();
        let mut previous: Option<u32> = None;
        for resolution in COMMON_RESOLUTIONS {
            assert!(
                seen.insert((resolution.width, resolution.height)),
                "{}x{} is listed twice",
                resolution.width,
                resolution.height
            );
            if let Some(held) = previous {
                assert!(
                    resolution.width <= held,
                    "{}x{} is wider than the row above it",
                    resolution.width,
                    resolution.height
                );
            }
            previous = Some(resolution.width);
        }
    }
}

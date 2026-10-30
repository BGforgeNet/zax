//! Where each setting is shown: the tab and frame tree the interface renders directly.
//!
//! The data is `data/layout.json`, written by `scripts/gen/gen-layout.mjs`. As with the catalog,
//! editing it is lost on the next regeneration.

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

/// The control the previous interface drew, which a setting's catalog kind alone does not determine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "lowercase")]
pub enum Control {
    Checkbox,
    Slider,
    Spin,
    Dropdown,
    Qinput,
    Radio,
}

/// A control, a titled group of them, or one of the few widgets that is not a single setting.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum LayoutNode {
    Setting {
        id: String,
        control: Control,
        /// Still placed and still in the catalog, so the key round-trips - just not offered as a
        /// choice.
        #[serde(default)]
        hidden: bool,
    },
    Frame {
        title: String,
        items: Vec<LayoutNode>,
    },
    Widget {
        id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
pub struct LayoutTab {
    pub title: String,
    pub items: Vec<LayoutNode>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
pub struct LayoutFile {
    /// What identifies this group of tabs and keys which of them is open: the config file's name for
    /// the game's own three, the engine's id for an engine's. An engine's tabs are not one file's -
    /// fallout2-ce shows both the keys it reads from the game's config and the ones a linked setting
    /// puts in the content patch.
    pub id: String,
    /// What the previous interface called it - the component, not the filename.
    pub label: String,
    /// The engine whose settings these tabs show, absent for the game's own three.
    #[serde(default)]
    pub engine: Option<String>,
    pub tabs: Vec<LayoutTab>,
}

/// Generated. See the module documentation before reaching for this file.
const LAYOUT_JSON: &str = include_str!("../data/layout.json");

/// Every group of tabs, in the order the interface shows them.
///
/// # Panics
///
/// Panics when the generated layout does not parse, for the same reason the catalog does: there is
/// no working application without it, and the tests below catch the divergence first.
#[must_use]
pub fn layout() -> &'static [LayoutFile] {
    static PARSED: OnceLock<Vec<LayoutFile>> = OnceLock::new();
    PARSED
        .get_or_init(|| {
            serde_json::from_str(LAYOUT_JSON)
                .unwrap_or_else(|err| panic!("the generated layout does not parse: {err}"))
        })
        .as_slice()
}

/// Every node under a list, with frames flattened into the controls they hold.
#[must_use]
pub fn flatten(items: &[LayoutNode]) -> Vec<&LayoutNode> {
    let mut out = Vec::new();
    let mut pending: Vec<&LayoutNode> = items.iter().rev().collect();
    while let Some(node) = pending.pop() {
        match node {
            LayoutNode::Frame { items, .. } => pending.extend(items.iter().rev()),
            LayoutNode::Setting { .. } | LayoutNode::Widget { .. } => out.push(node),
        }
    }
    out
}

/// The group that shows a given address: the engine's, or the one named for the file it sits in.
#[must_use]
pub fn group_for(target: &zax_core::catalog::SettingTarget) -> &str {
    target.engine.as_deref().unwrap_or(&target.file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::settings;
    use std::collections::{BTreeMap, BTreeSet};
    use zax_core::catalog::SettingKind;

    /// Which tab of which group each setting has a row on, keyed by group.
    fn rows() -> BTreeMap<String, BTreeMap<String, String>> {
        let mut out: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
        for group in layout() {
            let here = out.entry(group.id.clone()).or_default();
            for tab in &group.tabs {
                for node in flatten(&tab.items) {
                    if let LayoutNode::Setting { id, .. } = node {
                        here.insert(id.clone(), tab.title.clone());
                    }
                }
            }
        }
        out
    }

    fn placed() -> Vec<&'static LayoutNode> {
        layout()
            .iter()
            .flat_map(|group| group.tabs.iter().flat_map(|tab| flatten(&tab.items)))
            .collect()
    }

    fn placed_settings() -> Vec<(&'static str, Control, bool)> {
        placed()
            .into_iter()
            .filter_map(|node| match node {
                LayoutNode::Setting {
                    id,
                    control,
                    hidden,
                } => Some((id.as_str(), *control, *hidden)),
                LayoutNode::Frame { .. } | LayoutNode::Widget { .. } => None,
            })
            .collect()
    }

    #[test]
    fn the_generated_layout_parses() {
        assert!(!layout().is_empty());
    }

    #[test]
    fn the_three_original_groups_come_first_and_one_per_engine_follows() {
        assert_eq!(
            layout()
                .iter()
                .map(|f| f.label.as_str())
                .collect::<Vec<_>>(),
            vec!["Game", "HiRes", "Sfall", "CE", "Fission"]
        );
        assert_eq!(
            layout().iter().map(|f| f.id.as_str()).collect::<Vec<_>>(),
            vec![
                "fallout2.cfg",
                "f2_res.ini",
                "ddraw.ini",
                "fallout2-ce",
                "fission"
            ]
        );
        // A group is a file's or an engine's, never both and never neither.
        for group in layout() {
            if let Some(engine) = &group.engine {
                assert_eq!(
                    engine, &group.id,
                    "{} names a different engine",
                    group.label
                );
            }
        }
    }

    #[test]
    fn every_address_has_a_row_in_the_group_that_shows_it() {
        // A target with no row is a live value the user cannot reach.
        let rows = rows();
        let mut unreachable = Vec::new();
        for def in settings() {
            for target in def.targets.iter() {
                let group = group_for(target);
                if !rows
                    .get(group)
                    .is_some_and(|here| here.contains_key(&def.id))
                {
                    unreachable.push(format!(
                        "{} -> {} [{}]",
                        def.id, target.file, target.section
                    ));
                }
            }
        }
        assert_eq!(unreachable, Vec::<String>::new());
    }

    #[test]
    fn a_setting_is_never_placed_twice_in_one_group() {
        // Two rows editing one value would be one setting editing itself from two places.
        for group in layout() {
            let mut seen = BTreeSet::new();
            for tab in &group.tabs {
                for node in flatten(&tab.items) {
                    if let LayoutNode::Setting { id, .. } = node {
                        assert!(seen.insert(id), "{id} is placed twice on {}", group.label);
                    }
                }
            }
        }
    }

    #[test]
    fn a_linked_setting_gets_a_row_on_each_sides_own_group() {
        // The point of the two-target shape: this is what would silently regress to a single row if
        // a generator change started placing a setting by its own address alone.
        let rows = rows();
        let shared: Vec<_> = settings().iter().filter(|s| s.targets.len() > 1).collect();
        assert!(
            !shared.is_empty(),
            "no setting is linked, so this proves nothing"
        );
        for def in shared {
            let groups: BTreeSet<&str> = def.targets.iter().map(group_for).collect();
            assert!(
                groups.len() > 1,
                "{} links two addresses in one group",
                def.id
            );
            for group in groups {
                assert!(
                    rows.get(group)
                        .is_some_and(|here| here.contains_key(&def.id)),
                    "{} has no row on {group}",
                    def.id
                );
            }
        }
    }

    #[test]
    fn nothing_is_placed_that_the_catalog_does_not_describe() {
        let known: BTreeSet<&str> = settings().iter().map(|def| def.id.as_str()).collect();
        let unknown: Vec<&str> = placed_settings()
            .into_iter()
            .map(|(id, _, _)| id)
            .filter(|id| !known.contains(id))
            .collect();
        assert_eq!(unknown, Vec::<&str>::new());
    }

    #[test]
    fn every_setting_sits_under_a_group_that_actually_writes_it() {
        // A setting shown on the Sfall tab but written to fallout2.cfg would save somewhere the user
        // is not looking; one on an engine's tab the engine does not read would do nothing at all.
        let by_id: BTreeMap<&str, _> = settings()
            .iter()
            .map(|def| (def.id.as_str(), def))
            .collect();
        for group in layout() {
            for tab in &group.tabs {
                for node in flatten(&tab.items) {
                    let LayoutNode::Setting { id, .. } = node else {
                        continue;
                    };
                    let writes: Vec<&str> = by_id
                        .get(id.as_str())
                        .map(|def| def.targets.iter().map(group_for).collect())
                        .unwrap_or_default();
                    assert!(
                        writes.contains(&group.id.as_str()),
                        "{id} on the {} tab is written to {writes:?}",
                        group.label
                    );
                }
            }
        }
    }

    #[test]
    fn a_gated_setting_shares_a_tab_with_the_control_that_opens_its_gate() {
        // Otherwise the setting sits greyed out with the reason on a screen the user cannot see from
        // here. Per target, since a gate rides on one address.
        let rows = rows();
        for def in settings() {
            for target in def.targets.iter() {
                let Some(gate) = &target.gated_by else {
                    continue;
                };
                let here = rows.get(group_for(target));
                assert_eq!(
                    here.and_then(|h| h.get(&gate.id)),
                    here.and_then(|h| h.get(&def.id)),
                    "{} is gated from another tab of {}",
                    def.id,
                    group_for(target)
                );
            }
        }
    }

    #[test]
    fn the_nine_sliders_are_still_sliders() {
        let sliders: Vec<&str> = placed_settings()
            .into_iter()
            .filter(|(_, control, _)| *control == Control::Slider)
            .map(|(id, _, _)| id)
            .collect();
        for wanted in [
            "game.preferences.brightness",
            "game.preferences.mouse_sensitivity",
            "game.sound.master_volume",
        ] {
            assert!(sliders.contains(&wanted), "{wanted} is no longer a slider");
        }
        assert_eq!(sliders.len(), 9);
    }

    #[test]
    fn every_slider_has_a_range_to_draw() {
        // A slider with the wrong ceiling passes an existence check, which is how an upstream splash
        // range of 5 survived one. These are fallout2-ce's own preference-table bounds.
        let ranges: BTreeMap<&str, (f64, f64)> = BTreeMap::from([
            ("game.preferences.combat_speed", (0.0, 50.0)),
            ("game.preferences.text_base_delay", (1.0, 6.0)),
            ("game.preferences.text_line_delay", (0.0, 2.0)),
            ("game.preferences.brightness", (1.0, 1.179_992_675_781_25)),
            ("game.preferences.mouse_sensitivity", (1.0, 2.5)),
        ]);
        let by_id: BTreeMap<&str, _> = settings()
            .iter()
            .map(|def| (def.id.as_str(), def))
            .collect();

        for (id, control, _) in placed_settings() {
            if control != Control::Slider {
                continue;
            }
            let kind = &by_id
                .get(id)
                .expect("a placed setting is in the catalog")
                .kind;
            // A scale's own max is the engine's raw range.
            if matches!(kind, SettingKind::Scale { .. }) {
                continue;
            }
            let (SettingKind::Int(numeric) | SettingKind::Float(numeric)) = kind else {
                panic!("{id} is a slider over {kind:?}");
            };
            let want = ranges
                .get(id)
                .unwrap_or_else(|| panic!("{id} has no recorded range"));
            assert_eq!(
                (numeric.min, numeric.max),
                (Some(want.0), Some(want.1)),
                "{id} range"
            );
        }
    }

    #[test]
    fn the_settings_whose_value_goes_nowhere_are_hidden() {
        // Asserted by name: a check that merely counted hidden settings would pass on the wrong ones.
        let mut hidden: Vec<&str> = placed_settings()
            .into_iter()
            .filter(|(_, _, hidden)| *hidden)
            .map(|(id, _, _)| id)
            .collect();
        hidden.sort_unstable();
        assert_eq!(
            hidden,
            vec![
                // the previous interface hid it
                "game.preferences.text_line_delay",
                // fallout2-ce reads it and never uses it
                "game.system.free_space",
                // the previous interface hid it; ZAX pins the value
                "hires.MAIN.UAC_AWARE",
            ]
        );
    }

    #[test]
    fn no_two_labels_are_alike_inside_one_frame() {
        // The frame states the noun and the tab states the component, so a label carries neither -
        // which makes the frame the scope in which one still has to be unique.
        let by_id: BTreeMap<&str, _> = settings()
            .iter()
            .map(|def| (def.id.as_str(), def))
            .collect();
        let mut clashes: Vec<String> = Vec::new();

        fn check(
            items: &[LayoutNode],
            where_at: &str,
            by_id: &BTreeMap<&str, &zax_core::catalog::SettingDef>,
            clashes: &mut Vec<String>,
        ) {
            let mut seen: BTreeMap<String, &str> = BTreeMap::new();
            for node in items {
                match node {
                    LayoutNode::Frame { title, items } => {
                        check(items, &format!("{where_at} / {title}"), by_id, clashes);
                    }
                    LayoutNode::Setting { id, .. } => {
                        let Some(def) = by_id.get(id.as_str()) else {
                            continue;
                        };
                        let label = def.label.to_lowercase();
                        if let Some(held) = seen.get(&label) {
                            clashes.push(format!("{where_at}: \"{label}\" ({held} and {id})"));
                        } else {
                            seen.insert(label, id.as_str());
                        }
                    }
                    LayoutNode::Widget { .. } => {}
                }
            }
        }

        for group in layout() {
            for tab in &group.tabs {
                check(
                    &tab.items,
                    &format!("{} / {}", group.label, tab.title),
                    &by_id,
                    &mut clashes,
                );
            }
        }
        assert_eq!(clashes, Vec::<String>::new());
    }

    #[test]
    fn every_tab_and_frame_has_a_title() {
        fn titles(items: &[LayoutNode]) -> Vec<&str> {
            let mut out = Vec::new();
            for node in items {
                if let LayoutNode::Frame { title, items } = node {
                    out.push(title.as_str());
                    out.extend(titles(items));
                }
            }
            out
        }
        for group in layout() {
            assert!(!group.tabs.is_empty(), "{} has no tabs", group.label);
            for tab in &group.tabs {
                assert!(!tab.title.is_empty(), "{} has an untitled tab", group.label);
                for title in titles(&tab.items) {
                    assert!(!title.is_empty(), "{} has an untitled frame", group.label);
                }
            }
        }
    }
}

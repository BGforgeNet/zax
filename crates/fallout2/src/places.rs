//! Where a setting sits in the interface.
//!
//! Search lifts a row out of the tab that would otherwise locate it, so the result has to carry its
//! own address or the user cannot tell two similarly-named settings apart.

use std::collections::{BTreeMap, BTreeSet};

use crate::layout::{LayoutNode, layout};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Place {
    /// The group of tabs it is shown under: a config file's name, or an engine's id.
    pub group: String,
    /// The engine whose tabs those are, absent where the group is one of the game's own files.
    pub engine: Option<String>,
    /// What the component is called, rather than the filename.
    pub label: String,
    /// The settings tab.
    pub tab: String,
    /// Enclosing frame titles, outermost first. Empty when the setting sits directly on the tab.
    pub frames: Vec<String>,
}

/// Derived from the layout rather than stored on the setting: where it is shown is the layout's
/// business.
///
/// First place wins, and the game's own groups come first: a linked setting is reachable from the
/// component it belongs to whether or not the engine that shares it is installed, so that is where
/// search sends you. Only a setting no other component has - an engine's own key - is located on an
/// engine's tab.
#[must_use]
pub fn places_by_id() -> BTreeMap<String, Place> {
    let mut out: BTreeMap<String, Place> = BTreeMap::new();

    fn walk(
        items: &[LayoutNode],
        base: &Place,
        frames: &[String],
        out: &mut BTreeMap<String, Place>,
    ) {
        for node in items {
            match node {
                LayoutNode::Frame { title, items } => {
                    let mut deeper = frames.to_vec();
                    deeper.push(title.clone());
                    walk(items, base, &deeper, out);
                }
                LayoutNode::Setting { id, .. } => {
                    out.entry(id.clone()).or_insert_with(|| Place {
                        frames: frames.to_vec(),
                        ..base.clone()
                    });
                }
                LayoutNode::Widget { .. } => {}
            }
        }
    }

    for group in layout() {
        for tab in &group.tabs {
            let base = Place {
                group: group.id.clone(),
                engine: group.engine.clone(),
                label: group.label.clone(),
                tab: tab.title.clone(),
                frames: Vec::new(),
            };
            walk(&tab.items, &base, &[], &mut out);
        }
    }
    out
}

/// Settings the layout places but does not draw.
///
/// Search applies the same rule the tab does - offering a result that its own tab will not show is a
/// dead end, and the "go to" on it lands nowhere.
#[must_use]
pub fn hidden_ids() -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for group in layout() {
        for tab in &group.tabs {
            for node in crate::layout::flatten(&tab.items) {
                if let LayoutNode::Setting {
                    id, hidden: true, ..
                } = node
                {
                    out.insert(id.clone());
                }
            }
        }
    }
    out
}

/// "Sfall / Main / Graphics", for a one-line address under a search result.
#[must_use]
pub fn describe_place(place: &Place) -> String {
    let mut parts = vec![place.label.clone(), place.tab.clone()];
    parts.extend(place.frames.iter().cloned());
    parts.join(" / ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::settings;

    #[test]
    fn every_setting_in_the_catalog_has_somewhere_to_be_found() {
        let places = places_by_id();
        for def in settings() {
            assert!(places.contains_key(&def.id), "{} is placed nowhere", def.id);
        }
    }

    #[test]
    fn a_place_names_a_real_group_and_tab() {
        for (id, place) in places_by_id() {
            assert!(!place.group.is_empty(), "{id} has no group");
            assert!(!place.label.is_empty(), "{id} has no label");
            assert!(!place.tab.is_empty(), "{id} has no tab");
        }
    }

    #[test]
    fn a_linked_setting_is_located_on_the_component_it_belongs_to() {
        // A linked setting is reachable whether or not the engine that shares it is installed.
        let places = places_by_id();
        let engines: BTreeSet<&str> = layout()
            .iter()
            .filter_map(|group| group.engine.as_deref())
            .collect();

        for def in settings() {
            if def.targets.len() < 2 {
                continue;
            }
            // Its own address is the one the id was minted from; if that address is not an engine's,
            // search must send the user there rather than to an engine tab.
            let own = def.targets.own();
            if own.engine.is_some() {
                continue;
            }
            let place = places.get(&def.id).expect("a linked setting is placed");
            assert!(
                !engines.contains(place.group.as_str()),
                "{} is located on the engine tab {}",
                def.id,
                place.group
            );
        }
    }

    #[test]
    fn an_engines_own_key_is_located_on_that_engines_tab() {
        let places = places_by_id();
        for def in settings() {
            if def.targets.len() != 1 {
                continue;
            }
            let Some(engine) = def.targets.own().engine.as_deref() else {
                continue;
            };
            let place = places.get(&def.id).expect("placed");
            assert_eq!(place.group, engine, "{} is located elsewhere", def.id);
            assert_eq!(place.engine.as_deref(), Some(engine));
        }
    }

    #[test]
    fn the_hidden_settings_are_the_ones_the_layout_does_not_draw() {
        let hidden = hidden_ids();
        assert_eq!(hidden.len(), 3, "{hidden:?}");
        assert!(hidden.contains("game.system.free_space"));
    }

    #[test]
    fn a_place_reads_as_a_one_line_address() {
        let place = Place {
            group: "ddraw.ini".to_owned(),
            engine: None,
            label: "Sfall".to_owned(),
            tab: "Main".to_owned(),
            frames: vec!["Graphics".to_owned()],
        };
        assert_eq!(describe_place(&place), "Sfall / Main / Graphics");
    }

    #[test]
    fn a_setting_directly_on_a_tab_has_no_frames_in_its_address() {
        let place = Place {
            group: "ddraw.ini".to_owned(),
            engine: None,
            label: "Sfall".to_owned(),
            tab: "Main".to_owned(),
            frames: Vec::new(),
        };
        assert_eq!(describe_place(&place), "Sfall / Main");
    }

    #[test]
    fn frames_are_recorded_outermost_first() {
        // The address reads from the outside in, which is how the tab draws it.
        let places = places_by_id();
        let nested = places
            .values()
            .find(|place| place.frames.len() > 1)
            .expect("some setting sits inside nested frames");
        assert!(nested.frames.iter().all(|title| !title.is_empty()));
    }
}

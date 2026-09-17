//! What the interface needs that never changes while it runs: the catalog, the layout, the fixes, and
//! the tables a control draws from. Asked for once, at startup.
//!
//! Search lives here too. It runs over the catalog and the layout alone, so it answers the same for
//! every install and needs nothing held.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use zax_core::action::Action;
use zax_core::catalog::{SettingDef, search_text};
use zax_core::install::GameType;
use zax_core::keys::KEYS;

use crate::actions::{COMMON_RESOLUTIONS, actions};
use crate::catalog::settings;
use crate::layout::{LayoutFile, layout};
use crate::places::{describe_place, hidden_ids, places_by_id};
use crate::trouble::DEBUG_PACKAGE_CONTENTS;

/// What one kind of install is called.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct GameTypeView {
    pub name: String,
    /// The same said in full, for a tooltip.
    pub label: String,
    pub badge: String,
}

/// One offered shortcut for the high-resolution patch's width and height pair.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct ResolutionView {
    pub width: u32,
    pub height: u32,
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct CatalogView {
    pub settings: Vec<SettingDef>,
    pub layout: Vec<LayoutFile>,
    pub actions: Vec<Action>,
    pub resolutions: Vec<ResolutionView>,
    pub debug_package_contents: Vec<String>,
    /// Keyed by the name a type is stored under.
    pub game_types: BTreeMap<String, GameTypeView>,
    /// The scancode a captured keypress writes, keyed by the browser's `KeyboardEvent.code`.
    pub scancodes: BTreeMap<String, String>,
}

/// # Panics
///
/// Never in practice: the catalog and layout it reads panic first, at their own parse.
#[must_use]
pub fn catalog_view() -> &'static CatalogView {
    static BUILT: OnceLock<CatalogView> = OnceLock::new();
    BUILT.get_or_init(|| CatalogView {
        settings: settings().to_vec(),
        layout: layout().to_vec(),
        actions: actions().to_vec(),
        resolutions: COMMON_RESOLUTIONS
            .iter()
            .map(|one| ResolutionView {
                width: one.width,
                height: one.height,
                note: one.note.map(str::to_owned),
            })
            .collect(),
        debug_package_contents: DEBUG_PACKAGE_CONTENTS
            .iter()
            .map(|line| (*line).to_owned())
            .collect(),
        game_types: GameType::ALL
            .into_iter()
            .map(|one| {
                (
                    one.as_str().to_owned(),
                    GameTypeView {
                        name: one.name().to_owned(),
                        label: one.label().to_owned(),
                        badge: one.badge().to_owned(),
                    },
                )
            })
            .collect(),
        scancodes: KEYS
            .iter()
            .filter_map(|(code, _, dom)| dom.map(|dom| (dom.to_owned(), code.to_string())))
            .collect(),
    })
}

/// Where a search result lives, which is where going to it lands.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub id: String,
    pub group: String,
    pub tab: String,
    /// "Sfall / Main / Graphics": the address, since the row has left the tab that located it.
    pub place: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub results: Vec<SearchResult>,
    /// Whether the install tab answers the query. It holds nothing from the catalog, so without this a
    /// search for "wine" would report nothing while the tab sits in plain view.
    pub install_matches: bool,
}

struct Searchable {
    result: SearchResult,
    hay: String,
}

/// Every setting search can reach, with the text matched against, built once: none of it depends on
/// anything that changes at runtime.
fn searchable() -> &'static [Searchable] {
    static BUILT: OnceLock<Vec<Searchable>> = OnceLock::new();
    BUILT.get_or_init(|| {
        let places = places_by_id();
        let hidden = hidden_ids();
        settings()
            .iter()
            .filter_map(|def| {
                let place = places.get(&def.id)?;
                // A pinned value is drawn even where the layout hides it, so it stays findable.
                if hidden.contains(&def.id) && def.managed.is_none() {
                    return None;
                }
                let described = describe_place(place);
                Some(Searchable {
                    hay: format!("{} {}", search_text(def), described.to_lowercase()),
                    result: SearchResult {
                        id: def.id.clone(),
                        group: place.group.clone(),
                        tab: place.tab.clone(),
                        place: described,
                    },
                })
            })
            .collect()
    })
}

/// Settings matching every word of the query, across every tab. No query lists everything: the tab
/// this feeds is the whole catalog in one place, and searching narrows it.
///
/// `wine` is whether this machine has Wine, which decides whether its words reach the install tab.
#[must_use]
pub fn search_settings(query: &str, wine: bool) -> SearchResults {
    let lowered = query.trim().to_lowercase();
    // Every word somewhere, not the phrase in one field: a label carries no frame or tab words, so a
    // query spanning the address and the label matches neither alone.
    let terms: Vec<&str> = lowered.split_whitespace().collect();
    let results = searchable()
        .iter()
        .filter(|one| terms.iter().all(|term| one.hay.contains(term)))
        .map(|one| one.result.clone())
        .collect();
    let install_hay = if wine {
        "install alias name folder path wine wineprefix winedebug prefix launch"
    } else {
        "install alias name folder path"
    };
    SearchResults {
        results,
        install_matches: !terms.is_empty() && terms.iter().all(|term| install_hay.contains(term)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_query_lists_everything_search_can_reach_and_a_query_narrows_it() {
        let all = search_settings("", true).results;
        assert!(!all.is_empty());
        let narrowed = search_settings("combat speed", true).results;
        assert!(!narrowed.is_empty());
        assert!(narrowed.len() < all.len());
        assert!(
            narrowed
                .iter()
                .any(|one| one.id == "game.preferences.combat_speed")
        );
    }

    #[test]
    fn every_result_carries_the_address_its_tab_would_have_given_it() {
        for one in search_settings("", true).results {
            assert!(!one.place.is_empty(), "{} has no address", one.id);
            assert!(!one.tab.is_empty(), "{} has no tab", one.id);
        }
    }

    #[test]
    fn a_result_the_tab_will_not_show_is_not_offered() {
        let hidden = hidden_ids();
        let managed: Vec<&str> = settings()
            .iter()
            .filter(|def| def.managed.is_some())
            .map(|def| def.id.as_str())
            .collect();
        for one in search_settings("", true).results {
            assert!(
                !hidden.contains(&one.id) || managed.contains(&one.id.as_str()),
                "{} is hidden on its tab",
                one.id
            );
        }
    }

    #[test]
    fn the_install_tab_answers_its_own_words_and_wine_only_where_there_is_wine() {
        assert!(search_settings("alias", false).install_matches);
        assert!(search_settings("wine", true).install_matches);
        assert!(!search_settings("wine", false).install_matches);
        assert!(!search_settings("", true).install_matches);
    }

    #[test]
    fn a_captured_key_writes_the_scancode_its_physical_key_carries() {
        assert_eq!(
            catalog_view().scancodes.get("Escape").map(String::as_str),
            Some("1")
        );
    }
}

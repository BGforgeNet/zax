//! One install's mod order as the interface edits it: the list as read, and the list as it now stands.
//!
//! The order file is written whole, so "changed" is a comparison of the two lists rather than a flag to
//! keep in step, and it counts as one unsaved change however much of it moved.

use zax_core::install::GameType;

use crate::fission::fission_mounts;
use crate::mods::{Mod, ModKind, ModsSnapshot, OrderClaim, OrderFormat, list_mods};
use crate::recommended_order::{
    against_recommendation, order_with, recommendation_for, recommended_order,
};

/// The order as the Mods tab draws it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct OrderView {
    pub format: OrderFormat,
    /// Why the tab is closed, or `None` while it is open. One sentence naming the way out: a disabled
    /// tab with no reason is a defect rather than a state.
    pub closed: Option<String>,
    pub mods: Vec<Mod>,
    pub changed: bool,
    /// The entries loading against the recommendation - the warning, and what sorting moves.
    pub against: Vec<String>,
    /// Entries whose files are gone, which is what Forget is offered for.
    pub missing: Vec<String>,
    /// The folder split by whether Fission would load each entry.
    pub fission_mods: Vec<String>,
    /// Present and invisible to Fission. An entry whose file is gone is not among them: the order list
    /// is where a dead entry is dealt with.
    pub fission_missed: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OrderSession {
    /// The order file as read, which a save refuses to write over when it has changed since.
    pub text: Option<String>,
    pub format: OrderFormat,
    claims: Vec<OrderClaim>,
    pub mods: Vec<Mod>,
    baseline: Vec<Mod>,
}

impl OrderSession {
    #[must_use]
    pub fn new(snapshot: &ModsSnapshot) -> Self {
        let mods = list_mods(snapshot);
        Self {
            text: snapshot.text.clone(),
            format: snapshot.format.unwrap_or(OrderFormat::Sfall),
            claims: snapshot.claims.clone(),
            baseline: mods.clone(),
            mods,
        }
    }

    #[must_use]
    pub fn changed(&self) -> bool {
        self.mods.len() != self.baseline.len()
            || self
                .mods
                .iter()
                .zip(&self.baseline)
                .any(|(now, was)| now.name != was.name || now.enabled != was.enabled)
    }

    /// Turns a mod on or off, which is its line being written or commented out in place.
    pub fn toggle(&mut self, name: &str) {
        for one in &mut self.mods {
            if one.name == name {
                one.enabled = !one.enabled;
            }
        }
    }

    /// Moves a mod `by` places, negative to load it earlier. Refuses to move one off either end.
    pub fn shift(&mut self, name: &str, by: i64) {
        let Some(from) = self.mods.iter().position(|one| one.name == name) else {
            return;
        };
        let Some(to) = i64::try_from(from)
            .ok()
            .and_then(|at| at.checked_add(by))
            .and_then(|at| usize::try_from(at).ok())
            .filter(|at| *at < self.mods.len())
        else {
            return;
        };
        let moved = self.mods.remove(from);
        self.mods.insert(to, moved);
    }

    /// The order this install is judged against: its own project's, or the shared fallback, with the
    /// places the installed mods state for themselves folded in.
    fn recommendation(&self, game_type: GameType) -> Vec<String> {
        order_with(recommendation_for(game_type), &self.claims)
    }

    /// Puts the mods the recommendation names in its order; everything else keeps its place.
    pub fn sort(&mut self, game_type: GameType) {
        let order = self.recommendation(game_type);
        let named: Vec<&str> = order.iter().map(String::as_str).collect();
        self.mods = recommended_order(&self.mods, &named);
    }

    /// Drops an entry naming something no longer in the folder - the one edit that deletes a line.
    pub fn forget(&mut self, name: &str) {
        self.mods.retain(|one| one.name != name);
    }

    pub fn forget_missing(&mut self) {
        self.mods.retain(|one| one.kind != ModKind::Missing);
    }

    pub fn revert(&mut self) {
        self.mods.clone_from(&self.baseline);
    }

    #[must_use]
    pub fn view(&self, game_type: GameType) -> OrderView {
        let order = self.recommendation(game_type);
        let named: Vec<&str> = order.iter().map(String::as_str).collect();
        let names = |keep: &dyn Fn(&Mod) -> bool| {
            self.mods
                .iter()
                .filter(|one| keep(one))
                .map(|one| one.name.clone())
                .collect::<Vec<_>>()
        };
        OrderView {
            format: self.format,
            closed: (self.format != OrderFormat::Sfall).then(|| {
                "This folder's mod order is in Fission's format, which ZAX cannot edit. Run the game or \
                 another engine and ZAX puts the sfall list back, and this opens again."
                    .to_owned()
            }),
            mods: self.mods.clone(),
            changed: self.changed(),
            against: against_recommendation(&self.mods, &named),
            missing: names(&|one| one.kind == ModKind::Missing),
            fission_mods: names(&|one| fission_mounts(&one.name)),
            fission_missed: names(&|one| one.kind != ModKind::Missing && !fission_mounts(&one.name)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mods::ModsDirEntry;

    fn session(text: &str, present: &[&str]) -> OrderSession {
        OrderSession::new(&ModsSnapshot {
            text: Some(text.to_owned()),
            format: None,
            present: present
                .iter()
                .map(|name| ModsDirEntry {
                    name: (*name).to_owned(),
                    kind: ModKind::Dat,
                })
                .collect(),
            owners: Vec::new(),
            claims: Vec::new(),
        })
    }

    fn shown(held: &OrderSession) -> Vec<&str> {
        held.mods.iter().map(|one| one.name.as_str()).collect()
    }

    #[test]
    fn moving_refuses_to_run_off_either_end_rather_than_wrapping_around() {
        let mut held = session("a.dat\nb.dat\n", &["a.dat", "b.dat"]);
        held.shift("a.dat", -1);
        held.shift("b.dat", 1);
        assert!(!held.changed());
        held.shift("b.dat", -1);
        assert_eq!(shown(&held), ["b.dat", "a.dat"]);
    }

    #[test]
    fn the_whole_order_is_one_change_and_reverting_restores_it_as_read() {
        let mut held = session("a.dat\nb.dat\nc.dat\n", &["a.dat", "b.dat", "c.dat"]);
        held.shift("c.dat", -2);
        held.toggle("a.dat");
        assert!(held.changed());
        held.revert();
        assert!(!held.changed());
        assert_eq!(shown(&held), ["a.dat", "b.dat", "c.dat"]);
    }

    #[test]
    fn forgetting_the_missing_drops_only_what_is_gone() {
        let mut held = session("a.dat\ngone.dat\n", &["a.dat"]);
        assert_eq!(held.view(GameType::Fallout2).missing, ["gone.dat"]);
        held.forget_missing();
        assert_eq!(shown(&held), ["a.dat"]);
    }

    #[test]
    fn an_order_in_another_engines_format_closes_the_tab_with_the_way_out() {
        let held = OrderSession::new(&ModsSnapshot {
            format: Some(OrderFormat::Fission),
            ..ModsSnapshot::default()
        });
        let closed = held.view(GameType::Fallout2).closed.expect("a closed tab");
        assert!(closed.contains("Fission's format"));
        assert!(closed.contains("Run the game or another engine"));
    }
}

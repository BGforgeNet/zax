//! Where mods belong in `mods_order.txt`, as far as ZAX is prepared to say.
//!
//! The orders ship in code for the same reason the feed list does: they are a judgement ZAX makes on
//! the user's behalf, so they are reviewable and change only with a release. A mod earns a line when
//! where it belongs is actually stated somewhere - not inferred from what it looks like. Everything
//! else stays unranked, which is the honest answer for most of a mods folder and keeps the interface
//! from telling someone their working order is wrong.
//!
//! Nothing here moves a file on its own. The advice is shown, the sort is a button, and both land in
//! the same unsaved-then-save flow a manual reorder does.

use std::sync::LazyLock;

use zax_core::install::GameType;

use crate::mods::{Mod, OrderClaim};

/// The Restoration Project Updated's own shipped order (`release/mods_order.txt` in
/// BGforgeNet/Fallout2_Restoration_Project), earliest-loading first - a mod further down overrides one
/// above it, so the last line wins.
///
/// It is not a list of RPU's own files: `rpu.dat` is RPU and the `rpu_*` lines are its components, but
/// the rest name separate mods whose place RPU states rather than owns.
pub const RPU_ORDER: &[&str] = &[
    "rpu.dat",
    "party_orders.dat",
    "npc_armor.dat",
    "rpu_czech.dat",
    "rpu_french.dat",
    "rpu_german.dat",
    "rpu_hungarian.dat",
    "rpu_italian.dat",
    "rpu_polish.dat",
    "rpu_portuguese.dat",
    "rpu_russian.dat",
    "upu_russian_sound.dat",
    "rpu_spanish.dat",
    "rpu_enhanced_worldmap.dat",
    "rpu_extended_flamer.dat",
    "rpu_rifle_animations.dat",
    "rpu_wakizashi_animations.dat",
    "cassidy_head.dat",
    "cassidy_voice_joey_bracken_hq.dat",
    "rpu_improved_mysterious_stranger.dat",
    "walk_speed_fix_low_fps.dat",
    "goris_fast_derobing_low_fps.dat",
    "fo2tweaks.dat",
    "InventoryFilter.dat",
];

/// The Unofficial Patch Updated's own (`release/mods_order.txt` in
/// BGforgeNet/Fallout2_Unofficial_Patch): the same list with `upu.dat` and the `upu_*` translations
/// where RPU carries its own. The two installs are exclusive, so no folder is ever judged against both.
pub const UPU_ORDER: &[&str] = &[
    "upu.dat",
    "party_orders.dat",
    "npc_armor.dat",
    "upu_czech.dat",
    "upu_french.dat",
    "upu_german.dat",
    "upu_hungarian.dat",
    "upu_italian.dat",
    "upu_polish.dat",
    "upu_portuguese.dat",
    "upu_russian.dat",
    "upu_spanish.dat",
    "upu_russian_sound.dat",
    "rpu_enhanced_worldmap.dat",
    "rpu_extended_flamer.dat",
    "rpu_rifle_animations.dat",
    "rpu_wakizashi_animations.dat",
    "cassidy_head.dat",
    "cassidy_voice_joey_bracken_hq.dat",
    "rpu_improved_mysterious_stranger.dat",
    "walk_speed_fix_low_fps.dat",
    "goris_fast_derobing_low_fps.dat",
    "fo2tweaks.dat",
    "InventoryFilter.dat",
];

fn fold(name: &str) -> String {
    name.to_lowercase()
}

/// What an install neither project speaks for gets: the mods both of them place, in the order both give
/// them. Neither file was written for a vanilla or a killap-patched install, but where two
/// independently maintained orders agree about a third party's mod, that agreement is as good a
/// statement of its place as exists.
///
/// Computed rather than written out, so it shrinks by itself the day one project moves an entry - which
/// the order's own test asserts, since a disagreement would otherwise be settled silently in RPU's
/// favour.
pub static SHARED_ORDER: LazyLock<Vec<&'static str>> = LazyLock::new(|| {
    RPU_ORDER
        .iter()
        .copied()
        .filter(|name| UPU_ORDER.iter().any(|other| fold(other) == fold(name)))
        .collect()
});

/// The order an install is judged against. The two Updated projects each state their own; every other
/// type falls back to what they agree on, and no type is judged against a project it is not.
#[must_use]
pub fn recommendation_for(game_type: GameType) -> &'static [&'static str] {
    match game_type {
        GameType::Fallout2Rpu => RPU_ORDER,
        GameType::Fallout2Upu => UPU_ORDER,
        GameType::Fallout2 | GameType::Fallout2Up | GameType::Fallout2Rp | GameType::Fo1In2 => {
            &SHARED_ORDER
        }
    }
}

/// Where the order puts an entry, or nothing for one it does not name.
#[must_use]
pub fn rank_of(name: &str, order: &[&str]) -> Option<usize> {
    let name = fold(name);
    order.iter().position(|named| fold(named) == name)
}

/// Where a claim's entry belongs in an order, or nothing while the order names nothing it hangs off.
///
/// As late as the claim allows, for the reason `place_for` puts a new line as late as the order allows:
/// the entries either side of it are the whole of what has been stated, and the space between them is
/// not something to have an opinion about. A claim whose two sides cross - overriding something the
/// order already puts below what overrides it - states a place that does not exist, and goes back to
/// having no place rather than being resolved in one side's favour.
fn placement_in(order: &[&str], claim: &OrderClaim) -> Option<usize> {
    let ranks = |names: &[String]| -> Vec<usize> {
        names
            .iter()
            .filter_map(|name| rank_of(name, order))
            .collect()
    };
    let overridden = ranks(&claim.overrides);
    let overriding = ranks(&claim.overridden_by);
    if overridden.is_empty() && overriding.is_empty() {
        return None;
    }
    let earliest = overridden.iter().max().map_or(0, |at| at + 1);
    let latest = overriding.iter().min().copied().unwrap_or(order.len());
    (earliest <= latest).then_some(latest)
}

/// The order with the mods that state their own place put into it - what the recommendation becomes for
/// an install whose mods describe themselves.
///
/// The shipped order wins where it names the entry already: RPU's own file is a statement about an RPU
/// install, made by the project the install is, and a third party's claim about where it sits does not
/// override that. Everything else is placed against what the order names, repeatedly, so a mod may
/// state its place beside another mod that stated its own - and a claim that never resolves, because
/// what it names is absent or because two of them wait on each other, leaves its entry unranked, which
/// is what every entry nobody has spoken for already gets.
#[must_use]
pub fn order_with(base: &[&str], claims: &[OrderClaim]) -> Vec<String> {
    let mut out: Vec<String> = base.iter().map(|name| (*name).to_owned()).collect();
    // One placement per entry, carrying the claim its two sides come from.
    let mut pending: Vec<(&OrderClaim, &String)> = claims
        .iter()
        .flat_map(|claim| claim.entries.iter().map(move |entry| (claim, entry)))
        .collect();
    while !pending.is_empty() {
        let mut unresolved = Vec::new();
        for (claim, entry) in &pending {
            let borrowed: Vec<&str> = out.iter().map(String::as_str).collect();
            if rank_of(entry, &borrowed).is_some() {
                continue;
            }
            match placement_in(&borrowed, claim) {
                Some(at) => out.insert(at, (*entry).clone()),
                None => unresolved.push((*claim, *entry)),
            }
        }
        if unresolved.len() == pending.len() {
            break;
        }
        pending = unresolved;
    }
    out
}

/// The same list with the mods the order names put in its order, and every other entry left exactly
/// where it was. Only the known ones move, and only into the places they already occupied between them:
/// ZAX has no opinion about where an unranked mod sits, and shuffling one to make room would be acting
/// on an opinion it does not have.
#[must_use]
pub fn recommended_order(mods: &[Mod], order: &[&str]) -> Vec<Mod> {
    let mut known: Vec<(usize, usize)> = mods
        .iter()
        .enumerate()
        .filter_map(|(at, one)| rank_of(&one.name, order).map(|rank| (at, rank)))
        .collect();
    let places: Vec<usize> = known.iter().map(|(at, _)| *at).collect();
    // A stable sort, so two entries the order ranks the same keep the order the file has them in.
    known.sort_by_key(|(_, rank)| *rank);
    let mut out = mods.to_vec();
    for (place, (from, _)) in places.iter().zip(&known) {
        out[*place] = mods[*from].clone();
    }
    out
}

/// The entries a sort would move, in the order they sit now. Empty when the file already follows the
/// order.
#[must_use]
pub fn against_recommendation(mods: &[Mod], order: &[&str]) -> Vec<String> {
    let sorted = recommended_order(mods, order);
    mods.iter()
        .zip(&sorted)
        .filter(|(one, would)| one != would)
        .map(|(one, _)| one.name.clone())
        .collect()
}

/// Where a newly installed entry goes: as late as the order allows, which is just above the first mod
/// loaded after this one, and the end of the file when it names none of them.
///
/// As late as possible rather than as early: the end is where an install has always put a new dat, and
/// every entry the order says nothing about is one ZAX has no grounds to load a new mod under. So the
/// placement only ever pulls a mod up off the end, and only past a mod the recommendation actually
/// names.
#[must_use]
pub fn place_for(mods: &[Mod], name: &str, order: &[&str]) -> usize {
    let Some(rank) = rank_of(name, order) else {
        return mods.len();
    };
    mods.iter()
        .position(|one| rank_of(&one.name, order).is_some_and(|other| other > rank))
        .unwrap_or(mods.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mods::ModKind;

    fn one(name: &str) -> Mod {
        Mod {
            name: name.to_owned(),
            enabled: true,
            kind: ModKind::Dat,
            owner: None,
        }
    }

    fn names(mods: &[Mod]) -> Vec<&str> {
        mods.iter().map(|one| one.name.as_str()).collect()
    }

    fn claim(entry: &str, overrides: &[&str], overridden_by: &[&str]) -> OrderClaim {
        OrderClaim {
            entries: vec![entry.to_owned()],
            overrides: overrides.iter().map(|s| (*s).to_owned()).collect(),
            overridden_by: overridden_by.iter().map(|s| (*s).to_owned()).collect(),
        }
    }

    #[test]
    fn the_two_projects_agree_about_where_the_shared_mods_go() {
        // A disagreement would otherwise be settled silently in RPU's favour.
        let in_upu: Vec<usize> = SHARED_ORDER
            .iter()
            .map(|name| rank_of(name, UPU_ORDER).expect("shared means UPU names it"))
            .collect();
        assert!(
            in_upu.windows(2).all(|pair| pair[0] < pair[1]),
            "the shared entries sit in a different order in UPU: {in_upu:?}"
        );
        assert!(!SHARED_ORDER.is_empty());
    }

    #[test]
    fn neither_projects_own_files_survive_into_the_shared_order() {
        // `rpu.dat` and the `rpu_*` translations are RPU's own, so UPU names none of them.
        assert_eq!(rank_of("rpu.dat", &SHARED_ORDER), None);
        assert_eq!(rank_of("rpu_czech.dat", &SHARED_ORDER), None);
        assert!(rank_of("party_orders.dat", &SHARED_ORDER).is_some());
    }

    #[test]
    fn an_install_is_judged_against_its_own_project_only() {
        assert_eq!(recommendation_for(GameType::Fallout2Rpu), RPU_ORDER);
        assert_eq!(recommendation_for(GameType::Fallout2Upu), UPU_ORDER);
        for other in [
            GameType::Fallout2,
            GameType::Fallout2Up,
            GameType::Fallout2Rp,
            GameType::Fo1In2,
        ] {
            assert_eq!(recommendation_for(other), SHARED_ORDER.as_slice());
        }
    }

    #[test]
    fn a_rank_is_found_however_the_file_spells_it() {
        assert_eq!(rank_of("RPU.DAT", RPU_ORDER), Some(0));
        assert_eq!(rank_of("inventoryfilter.dat", RPU_ORDER), Some(23));
        assert_eq!(rank_of("nothing.dat", RPU_ORDER), None);
    }

    #[test]
    fn a_claim_lands_as_late_as_both_its_sides_allow() {
        let base = ["a.dat", "b.dat", "c.dat"];
        let placed = order_with(&base, &[claim("new.dat", &["a.dat"], &["c.dat"])]);
        assert_eq!(placed, ["a.dat", "b.dat", "new.dat", "c.dat"]);
    }

    #[test]
    fn a_claim_naming_nothing_the_order_holds_leaves_its_entry_unranked() {
        let base = ["a.dat"];
        let placed = order_with(&base, &[claim("new.dat", &["absent.dat"], &[])]);
        assert_eq!(placed, ["a.dat"]);
    }

    #[test]
    fn a_claim_whose_sides_cross_states_a_place_that_does_not_exist() {
        // `c.dat` already loads after `a.dat`, so nothing can override one and be overridden by the
        // other.
        let base = ["c.dat", "a.dat"];
        let placed = order_with(&base, &[claim("new.dat", &["a.dat"], &["c.dat"])]);
        assert_eq!(placed, ["c.dat", "a.dat"]);
    }

    #[test]
    fn a_claim_may_hang_off_an_entry_another_claim_placed() {
        let base = ["a.dat"];
        let placed = order_with(
            &base,
            &[
                claim("second.dat", &["first.dat"], &[]),
                claim("first.dat", &["a.dat"], &[]),
            ],
        );
        assert_eq!(placed, ["a.dat", "first.dat", "second.dat"]);
    }

    #[test]
    fn two_claims_waiting_on_each_other_both_stay_unranked() {
        let base = ["a.dat"];
        let placed = order_with(
            &base,
            &[
                claim("x.dat", &["y.dat"], &[]),
                claim("y.dat", &["x.dat"], &[]),
            ],
        );
        assert_eq!(placed, ["a.dat"]);
    }

    #[test]
    fn the_shipped_order_wins_where_it_names_the_entry_already() {
        let base = ["a.dat", "rpu.dat"];
        let placed = order_with(&base, &[claim("rpu.dat", &[], &["a.dat"])]);
        assert_eq!(placed, ["a.dat", "rpu.dat"]);
    }

    #[test]
    fn only_the_ranked_mods_move_and_only_among_their_own_places() {
        let order = ["first.dat", "second.dat"];
        let mods = [
            one("second.dat"),
            one("unranked.dat"),
            one("first.dat"),
            one("other.dat"),
        ];
        let sorted = recommended_order(&mods, &order);
        assert_eq!(
            names(&sorted),
            ["first.dat", "unranked.dat", "second.dat", "other.dat"]
        );
    }

    #[test]
    fn a_file_already_following_the_order_has_nothing_against_it() {
        let order = ["first.dat", "second.dat"];
        let mods = [one("first.dat"), one("x.dat"), one("second.dat")];
        assert!(against_recommendation(&mods, &order).is_empty());
    }

    #[test]
    fn what_a_sort_would_move_is_named_in_the_order_it_sits_now() {
        let order = ["first.dat", "second.dat"];
        let mods = [one("second.dat"), one("first.dat")];
        assert_eq!(
            against_recommendation(&mods, &order),
            ["second.dat", "first.dat"]
        );
    }

    #[test]
    fn a_new_entry_goes_just_above_the_first_mod_loaded_after_it() {
        let order = ["a.dat", "b.dat", "c.dat"];
        let mods = [one("a.dat"), one("hand_made.dat"), one("c.dat")];
        assert_eq!(place_for(&mods, "b.dat", &order), 2);
    }

    #[test]
    fn an_entry_the_order_says_nothing_about_goes_at_the_end() {
        let order = ["a.dat"];
        let mods = [one("a.dat"), one("x.dat")];
        assert_eq!(place_for(&mods, "new.dat", &order), 2);
        // And so does one the order ranks last, since no mod present loads after it.
        assert_eq!(place_for(&mods, "a.dat", &order), 2);
    }
}

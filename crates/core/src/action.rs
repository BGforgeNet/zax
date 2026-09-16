//! An action is a user intention expressed as one click - "enable full debugging" rather than eleven
//! toggles across two files. Its targets are the substrate it writes to.

use std::collections::BTreeMap;

/// Where an action is offered.
///
/// Declared on the action rather than listed by the panel that shows it: a panel holding its own
/// list of ids silently drops any action added afterwards, which is how one of these came to exist
/// in the catalog and appear nowhere in the interface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ActionGroup {
    Report,
    Fix,
}

/// What an action leaves in the install's `WINEDEBUG`, for the two that are about logging.
///
/// It belongs to the install's own record rather than to a config file, so it is written at once
/// where the targets stay pending.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WineSetting {
    pub debug: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Action {
    pub id: String,
    pub label: String,
    pub group: ActionGroup,
    /// What the user gets, in their language. Not a list of the keys involved.
    pub description: String,
    /// Setting id to the value this action writes.
    pub targets: BTreeMap<String, String>,
    /// Button wording once every target already matches.
    pub applied_label: String,
    pub wine: Option<WineSetting>,
}

/// One target an action would change, and what it would change it from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingTarget {
    pub id: String,
    pub from: Option<String>,
    pub to: String,
}

/// The id used for the Wine variable in a pending list.
///
/// Named for the variable rather than a catalog id, because that is what it is: nothing looks this
/// one up.
pub const WINE_DEBUG_ID: &str = "WINEDEBUG";

/// `wine_debug` is the install's current value, or `None` on a machine with no Wine - where the
/// field is not shown and so must not decide whether an action counts as applied.
fn wine_matches(action: &Action, wine_debug: Option<&str>) -> bool {
    match (&action.wine, wine_debug) {
        (None, _) | (Some(_), None) => true,
        (Some(wine), Some(held)) => held == wine.debug,
    }
}

/// Whether every value an action would write is already in place.
///
/// The same comparison drives both the button state and the "already done" wording; deriving it from
/// `targets` keeps the two from drifting.
pub fn is_applied<F>(action: &Action, value_of: F, wine_debug: Option<&str>) -> bool
where
    F: Fn(&str) -> Option<String>,
{
    wine_matches(action, wine_debug)
        && action
            .targets
            .iter()
            .all(|(id, want)| value_of(id).as_ref() == Some(want))
}

/// Targets that do not yet match, so the interface can say how much an action will change.
pub fn pending_targets<F>(
    action: &Action,
    value_of: F,
    wine_debug: Option<&str>,
) -> Vec<PendingTarget>
where
    F: Fn(&str) -> Option<String>,
{
    let mut pending: Vec<PendingTarget> = action
        .targets
        .iter()
        .filter(|(id, want)| value_of(id).as_ref() != Some(*want))
        .map(|(id, want)| PendingTarget {
            id: id.clone(),
            from: value_of(id),
            to: want.clone(),
        })
        .collect();
    if let Some(wine) = &action.wine
        && !wine_matches(action, wine_debug)
    {
        pending.push(PendingTarget {
            id: WINE_DEBUG_ID.to_owned(),
            from: wine_debug.map(ToOwned::to_owned),
            to: wine.debug.clone(),
        });
    }
    pending
}

#[cfg(test)]
mod tests {
    use super::*;

    fn action() -> Action {
        Action {
            id: "debug.full".to_owned(),
            label: "Enable full debugging".to_owned(),
            group: ActionGroup::Report,
            description: "Writes everything the engine can report".to_owned(),
            targets: BTreeMap::from([
                ("sfall.Debugging.Mode".to_owned(), "1".to_owned()),
                ("sfall.Debugging.Level".to_owned(), "3".to_owned()),
            ]),
            applied_label: "Full debugging is on".to_owned(),
            wine: None,
        }
    }

    fn holding(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let held: BTreeMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        move |id: &str| held.get(id).cloned()
    }

    #[test]
    fn an_action_is_applied_once_every_target_matches() {
        let action = action();
        let all = holding(&[
            ("sfall.Debugging.Mode", "1"),
            ("sfall.Debugging.Level", "3"),
        ]);
        assert!(is_applied(&action, &all, None));
        assert!(pending_targets(&action, &all, None).is_empty());
    }

    #[test]
    fn one_target_out_of_place_leaves_the_action_pending() {
        let action = action();
        let partial = holding(&[
            ("sfall.Debugging.Mode", "1"),
            ("sfall.Debugging.Level", "0"),
        ]);
        assert!(!is_applied(&action, &partial, None));
        assert_eq!(
            pending_targets(&action, &partial, None),
            vec![PendingTarget {
                id: "sfall.Debugging.Level".to_owned(),
                from: Some("0".to_owned()),
                to: "3".to_owned(),
            }]
        );
    }

    #[test]
    fn a_target_with_no_value_yet_is_pending_from_nothing() {
        let action = action();
        let partial = holding(&[("sfall.Debugging.Mode", "1")]);
        assert_eq!(
            pending_targets(&action, &partial, None),
            vec![PendingTarget {
                id: "sfall.Debugging.Level".to_owned(),
                from: None,
                to: "3".to_owned(),
            }]
        );
    }

    #[test]
    fn a_machine_with_no_wine_is_not_held_back_by_the_wine_value() {
        // The field is not shown there, so it must not decide whether the action counts as applied.
        let mut action = action();
        action.wine = Some(WineSetting {
            debug: "+relay".to_owned(),
        });
        let all = holding(&[
            ("sfall.Debugging.Mode", "1"),
            ("sfall.Debugging.Level", "3"),
        ]);
        assert!(is_applied(&action, &all, None));
        assert!(pending_targets(&action, &all, None).is_empty());
    }

    #[test]
    fn a_wine_value_that_differs_is_pending_under_its_own_name() {
        let mut action = action();
        action.wine = Some(WineSetting {
            debug: "+relay".to_owned(),
        });
        let all = holding(&[
            ("sfall.Debugging.Mode", "1"),
            ("sfall.Debugging.Level", "3"),
        ]);
        assert!(!is_applied(&action, &all, Some("")));
        assert_eq!(
            pending_targets(&action, &all, Some("")),
            vec![PendingTarget {
                id: WINE_DEBUG_ID.to_owned(),
                from: Some(String::new()),
                to: "+relay".to_owned(),
            }]
        );
    }

    #[test]
    fn a_wine_value_already_in_place_leaves_nothing_pending() {
        let mut action = action();
        action.wine = Some(WineSetting {
            debug: "+relay".to_owned(),
        });
        let all = holding(&[
            ("sfall.Debugging.Mode", "1"),
            ("sfall.Debugging.Level", "3"),
        ]);
        assert!(is_applied(&action, &all, Some("+relay")));
    }
}

//! A grouped choice made before an install, and the rules a selection has to satisfy - a group that
//! takes at most one, an option that needs another, an id nothing offers.
//!
//! Held apart from the manifest so the interface draws the choice from a shape of its own rather
//! than from a parsed manifest: the renderer reads no manifest, and what it needs to draw a group of
//! options is less than what a part declares.

use std::collections::BTreeMap;

/// The least an option has to be for the rules below to judge it, and for the interface to draw it.
pub trait ChoiceOption {
    fn id(&self) -> &str;
    fn label(&self) -> &str;
    /// Another option in the same choice that this one is meaningless without.
    fn needs(&self) -> Option<&str>;
}

/// How many of a group's options may be taken.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "lowercase")]
pub enum Pick {
    One,
    Any,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct ChoiceGroup<T> {
    pub label: String,
    pub pick: Pick,
    pub options: Vec<T>,
}

/// What a selection is called in a refusal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Naming<'a> {
    /// What one option is, in the user's words: "part", "component".
    pub thing: &'a str,
    /// Whose release is being installed.
    pub of: &'a str,
}

/// The options a selection names, in the order the groups declare them, or a refusal saying why the
/// selection could not be installed.
///
/// Every refusal names the option in the words the manifest gave it, because the person reading it
/// chose from those words and not from ids.
///
/// # Errors
///
/// Answers with wording for the user when an id is not offered, when a one-of group has two taken,
/// or when a taken option needs one that is not.
pub fn choose_from<'a, T: ChoiceOption>(
    groups: &'a [ChoiceGroup<T>],
    selection: &[String],
    naming: Naming<'_>,
) -> Result<Vec<&'a T>, String> {
    let offered: BTreeMap<&str, &T> = groups
        .iter()
        .flat_map(|group| &group.options)
        .map(|option| (option.id(), option))
        .collect();

    let mut picked: Vec<&str> = Vec::new();
    for id in selection {
        if !offered.contains_key(id.as_str()) {
            return Err(format!(
                "The {} release does not offer a {} called \"{id}\".",
                naming.of, naming.thing
            ));
        }
        if !picked.contains(&id.as_str()) {
            picked.push(id.as_str());
        }
    }

    for group in groups {
        if group.pick != Pick::One {
            continue;
        }
        let chosen: Vec<&str> = group
            .options
            .iter()
            .filter(|option| picked.contains(&option.id()))
            .map(ChoiceOption::label)
            .collect();
        if chosen.len() > 1 {
            return Err(format!(
                "Only one {} can be installed, and {} are both selected.",
                group.label,
                chosen.join(" and ")
            ));
        }
    }

    for option in offered.values() {
        if !picked.contains(&option.id()) {
            continue;
        }
        let Some(needed) = option.needs() else {
            continue;
        };
        if picked.contains(&needed) {
            continue;
        }
        let name = offered.get(needed).map_or(needed, |held| held.label());
        return Err(format!(
            "{} needs {name}, which is not selected.",
            option.label()
        ));
    }

    Ok(groups
        .iter()
        .flat_map(|group| &group.options)
        .filter(|option| picked.contains(&option.id()))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct Option_ {
        id: String,
        label: String,
        needs: Option<String>,
    }

    impl ChoiceOption for Option_ {
        fn id(&self) -> &str {
            &self.id
        }
        fn label(&self) -> &str {
            &self.label
        }
        fn needs(&self) -> Option<&str> {
            self.needs.as_deref()
        }
    }

    fn option(id: &str, label: &str, needs: Option<&str>) -> Option_ {
        Option_ {
            id: id.to_owned(),
            label: label.to_owned(),
            needs: needs.map(ToOwned::to_owned),
        }
    }

    fn naming() -> Naming<'static> {
        Naming {
            thing: "part",
            of: "EcCo",
        }
    }

    fn ids(chosen: &[&Option_]) -> Vec<String> {
        chosen.iter().map(|o| o.id.clone()).collect()
    }

    fn one_of(options: Vec<Option_>) -> Vec<ChoiceGroup<Option_>> {
        vec![ChoiceGroup {
            label: "look".to_owned(),
            pick: Pick::One,
            options,
        }]
    }

    #[test]
    fn an_empty_selection_takes_nothing() {
        let groups = one_of(vec![option("a", "A", None)]);
        assert!(
            choose_from(&groups, &[], naming())
                .expect("nothing selected is not a refusal")
                .is_empty()
        );
    }

    #[test]
    fn the_options_come_back_in_the_order_the_groups_declare_them() {
        let groups = vec![ChoiceGroup {
            label: "extras".to_owned(),
            pick: Pick::Any,
            options: vec![option("a", "A", None), option("b", "B", None)],
        }];
        let chosen = choose_from(&groups, &["b".to_owned(), "a".to_owned()], naming()).expect("ok");
        assert_eq!(ids(&chosen), vec!["a".to_owned(), "b".to_owned()]);
    }

    #[test]
    fn an_id_nothing_offers_is_refused_by_name() {
        let groups = one_of(vec![option("a", "A", None)]);
        let err = choose_from(&groups, &["nope".to_owned()], naming()).expect_err("refused");
        assert_eq!(
            err,
            "The EcCo release does not offer a part called \"nope\"."
        );
    }

    #[test]
    fn a_group_that_takes_one_refuses_two_and_names_both_in_the_manifests_words() {
        // The person reading it chose from those words and not from ids.
        let groups = one_of(vec![
            option("a", "Widescreen", None),
            option("b", "Classic", None),
        ]);
        let err =
            choose_from(&groups, &["a".to_owned(), "b".to_owned()], naming()).expect_err("refused");
        assert_eq!(
            err,
            "Only one look can be installed, and Widescreen and Classic are both selected."
        );
    }

    #[test]
    fn a_group_that_takes_any_allows_several() {
        let groups = vec![ChoiceGroup {
            label: "extras".to_owned(),
            pick: Pick::Any,
            options: vec![option("a", "A", None), option("b", "B", None)],
        }];
        let chosen = choose_from(&groups, &["a".to_owned(), "b".to_owned()], naming()).expect("ok");
        assert_eq!(chosen.len(), 2);
    }

    #[test]
    fn an_option_that_needs_another_is_refused_without_it() {
        let groups = vec![ChoiceGroup {
            label: "extras".to_owned(),
            pick: Pick::Any,
            options: vec![
                option("base", "The base files", None),
                option("extra", "The extra pack", Some("base")),
            ],
        }];
        let err = choose_from(&groups, &["extra".to_owned()], naming()).expect_err("refused");
        assert_eq!(
            err,
            "The extra pack needs The base files, which is not selected."
        );
    }

    #[test]
    fn an_option_that_needs_another_passes_with_it() {
        let groups = vec![ChoiceGroup {
            label: "extras".to_owned(),
            pick: Pick::Any,
            options: vec![
                option("base", "The base files", None),
                option("extra", "The extra pack", Some("base")),
            ],
        }];
        let chosen =
            choose_from(&groups, &["base".to_owned(), "extra".to_owned()], naming()).expect("ok");
        assert_eq!(chosen.len(), 2);
    }

    #[test]
    fn an_unselected_option_with_a_requirement_is_not_judged() {
        let groups = vec![ChoiceGroup {
            label: "extras".to_owned(),
            pick: Pick::Any,
            options: vec![
                option("base", "The base files", None),
                option("extra", "The extra pack", Some("base")),
            ],
        }];
        let chosen = choose_from(&groups, &["base".to_owned()], naming()).expect("ok");
        assert_eq!(ids(&chosen), vec!["base".to_owned()]);
    }

    #[test]
    fn the_same_id_twice_is_taken_once() {
        let groups = one_of(vec![option("a", "A", None)]);
        let chosen = choose_from(&groups, &["a".to_owned(), "a".to_owned()], naming()).expect("ok");
        assert_eq!(chosen.len(), 1);
    }
}

//! Which parts of a release an install is made of.
//!
//! A selection reaches here from the interface, from a record written by an earlier install, or from a
//! journal a retry resumes - three routes, one set of rules, so what a dialog offers and what an
//! install carries out cannot drift. Every refusal names the part in the words the manifest gave it,
//! because the person reading it chose from those words and not from ids.

use std::collections::BTreeSet;

use crate::manifest::{ModPart, Pick as ManifestPick, part_options};
use crate::mod_choice::{ChoiceGroup, ChoiceOption, Naming, Pick, choose_from};
use crate::mod_feed::ModRelease;

impl ChoiceOption for ModPart {
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

/// The groups this release can offer: options whose asset it published, and no group left empty by
/// that.
///
/// The drop repeats until it settles, as the settings gates do, because a part is unselectable when
/// what it `needs` is gone - offering Cassidy's voice without its head would be offering something no
/// install could ever carry out.
#[must_use]
pub fn offered_parts(release: &ModRelease) -> Vec<ChoiceGroup<ModPart>> {
    let mut published: BTreeSet<&str> = release.parts.keys().map(String::as_str).collect();
    loop {
        let gone: Vec<&str> = part_options(&release.manifest)
            .into_iter()
            .filter(|part| {
                published.contains(part.id.as_str())
                    && part
                        .needs
                        .as_deref()
                        .is_some_and(|needed| !published.contains(needed))
            })
            .map(|part| part.id.as_str())
            .collect();
        if gone.is_empty() {
            break;
        }
        for id in gone {
            published.remove(id);
        }
    }
    release
        .manifest
        .parts
        .as_deref()
        .unwrap_or_default()
        .iter()
        .filter_map(|group| {
            let options: Vec<ModPart> = group
                .options
                .iter()
                .filter(|part| published.contains(part.id.as_str()))
                .cloned()
                .collect();
            (!options.is_empty()).then(|| ChoiceGroup {
                label: group.label.clone(),
                pick: match group.pick {
                    ManifestPick::One => Pick::One,
                    ManifestPick::Any => Pick::Any,
                },
                options,
            })
        })
        .collect()
}

/// The parts a selection names, in the order the manifest declares them, or a refusal saying why the
/// selection could not be installed. Judged against what the release actually publishes rather than
/// against what the manifest declares: a part whose asset is missing is not something an install could
/// carry out.
///
/// # Errors
///
/// Answers with wording for the user when the selection is empty, names a part this release does not
/// offer, or breaks one of the shared rules.
pub fn chosen_parts(release: &ModRelease, selection: &[String]) -> Result<Vec<ModPart>, String> {
    let name = &release.manifest.name;
    // A mod installing none of its own parts installs nothing, so an empty selection is a refusal
    // rather than a choice - said here rather than in the shared rules, which judge a selection and not
    // its size.
    if selection.is_empty() {
        return Err(format!(
            "Nothing of {name} is selected, so there is nothing to install."
        ));
    }
    let groups = offered_parts(release);
    let chosen = choose_from(
        &groups,
        selection,
        Naming {
            thing: "part",
            of: name,
        },
    )?;
    Ok(chosen.into_iter().cloned().collect())
}

/// Where an install stands in a release's choices: what to install, what went, and whether to ask.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CarriedSelection {
    /// The parts to install, in declared order - the recorded choice re-matched against this release.
    pub selection: Vec<String>,
    /// Recorded parts this release no longer offers. Named before the upgrade runs, never silently.
    pub dropped: Vec<String>,
    /// Whether the choice has to be put to the user rather than carried over.
    pub ask: bool,
}

/// The recorded selection against the release now on offer, matched by id - which is what makes a part
/// id permanent: renamed, it reads here as one part removed and another added, and the user loses the
/// choice they made.
///
/// A part the release no longer offers is dropped; one it newly offers starts off, so a mod adding a
/// fifth voice does not stop the other four upgrading quietly. The question goes back to the user when
/// a `one` group has nothing selected and something was dropped - which over-asks where the empty group
/// was the user's own doing, and asking is the safe side of that: picking for them is picking wrong as
/// often as not.
#[must_use]
pub fn carry_over(release: &ModRelease, recorded: Option<&[String]>) -> CarriedSelection {
    if release.manifest.parts.is_none() {
        return CarriedSelection::default();
    }
    let Some(recorded) = recorded else {
        return CarriedSelection {
            ask: true,
            ..CarriedSelection::default()
        };
    };

    let groups = offered_parts(release);
    let offered: BTreeSet<&str> = groups
        .iter()
        .flat_map(|group| &group.options)
        .map(|part| part.id.as_str())
        .collect();
    let kept: BTreeSet<&str> = recorded
        .iter()
        .map(String::as_str)
        .filter(|id| offered.contains(id))
        .collect();
    let dropped: Vec<String> = recorded
        .iter()
        .filter(|id| !kept.contains(id.as_str()))
        .cloned()
        .collect();
    let selection: Vec<String> = part_options(&release.manifest)
        .into_iter()
        .filter(|part| kept.contains(part.id.as_str()))
        .map(|part| part.id.clone())
        .collect();

    let emptied = groups.iter().any(|group| {
        group.pick == Pick::One
            && !group
                .options
                .iter()
                .any(|option| kept.contains(option.id.as_str()))
    });
    CarriedSelection {
        ask: selection.is_empty() || (!dropped.is_empty() && emptied),
        selection,
        dropped,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::{ManifestDefaults, parse_manifest};
    use crate::mod_feed::ReleaseAsset;
    use std::collections::BTreeMap;

    /// Two groups: a one-of look, and an any-of pair whose second needs the first.
    const PARTS: &str = "spec: 1
id: ecco
name: EcCo
version: 1.0
game: fallout2
type: pluggable
part-groups:
  - id: look
    label: look
    pick: one
  - id: extras
    label: extras
    pick: any
parts:
  - id: wide
    group: look
    label: Widescreen
    archive: wide.zip
  - id: classic
    group: look
    label: Classic
    archive: classic.zip
  - id: head
    group: extras
    label: Cassidy's head
    archive: head.zip
  - id: voice
    group: extras
    label: Cassidy's voice
    archive: voice.zip
    needs: head
";

    fn asset(name: &str) -> ReleaseAsset {
        ReleaseAsset {
            name: name.to_owned(),
            url: format!("https://example/{name}"),
            digest: None,
            size: None,
        }
    }

    fn release(published: &[&str]) -> ModRelease {
        let manifest = parse_manifest(PARTS.as_bytes(), &ManifestDefaults::default())
            .expect("a manifest the test writes");
        let by_id: BTreeMap<String, ReleaseAsset> = published
            .iter()
            .map(|id| ((*id).to_owned(), asset(&format!("{id}.zip"))))
            .collect();
        ModRelease {
            manifest,
            manifest_text: PARTS.to_owned(),
            archive: None,
            parts: by_id,
            installer: None,
            installer_route: None,
            line: None,
        }
    }

    fn ids(groups: &[ChoiceGroup<ModPart>]) -> Vec<&str> {
        groups
            .iter()
            .flat_map(|group| &group.options)
            .map(|part| part.id.as_str())
            .collect()
    }

    #[test]
    fn only_the_parts_the_release_published_are_offered() {
        let offered = offered_parts(&release(&["wide", "head"]));
        assert_eq!(ids(&offered), ["wide", "head"]);
    }

    #[test]
    fn a_group_the_release_emptied_is_not_offered_at_all() {
        let offered = offered_parts(&release(&["head"]));
        assert_eq!(offered.len(), 1);
        assert_eq!(offered[0].label, "extras");
    }

    #[test]
    fn a_part_whose_requirement_is_unpublished_goes_with_it() {
        // Offering Cassidy's voice without its head would be offering something no install could
        // ever carry out.
        let offered = offered_parts(&release(&["wide", "voice"]));
        assert_eq!(ids(&offered), ["wide"]);
    }

    #[test]
    fn a_release_publishing_nothing_offers_nothing() {
        assert!(offered_parts(&release(&[])).is_empty());
    }

    #[test]
    fn an_empty_selection_is_a_refusal_rather_than_a_choice() {
        let err = chosen_parts(&release(&["wide"]), &[]).expect_err("nothing to install");
        assert_eq!(
            err,
            "Nothing of EcCo is selected, so there is nothing to install."
        );
    }

    #[test]
    fn a_part_the_release_did_not_publish_cannot_be_chosen() {
        // Judged against what the release publishes, not against what the manifest declares.
        let err =
            chosen_parts(&release(&["wide"]), &["classic".to_owned()]).expect_err("not published");
        assert!(err.contains("\"classic\""), "{err}");
    }

    #[test]
    fn the_chosen_parts_come_back_in_declared_order() {
        let chosen = chosen_parts(
            &release(&["wide", "head", "voice"]),
            &["voice".to_owned(), "head".to_owned(), "wide".to_owned()],
        )
        .expect("a selection");
        let names: Vec<&str> = chosen.iter().map(|part| part.id.as_str()).collect();
        assert_eq!(names, ["wide", "head", "voice"]);
    }

    #[test]
    fn a_mod_with_no_parts_carries_nothing_and_asks_nothing() {
        let plain =
            "spec: 1\nid: ecco\nname: EcCo\nversion: 1.0\ngame: fallout2\ntype: pluggable\n";
        let manifest = parse_manifest(plain.as_bytes(), &ManifestDefaults::default())
            .expect("a manifest the test writes");
        let release = ModRelease {
            manifest,
            manifest_text: plain.to_owned(),
            archive: None,
            parts: BTreeMap::new(),
            installer: None,
            installer_route: None,
            line: None,
        };
        assert_eq!(carry_over(&release, None), CarriedSelection::default());
    }

    #[test]
    fn a_mod_with_parts_and_no_record_is_asked_about() {
        let carried = carry_over(&release(&["wide", "head"]), None);
        assert!(carried.ask);
        assert!(carried.selection.is_empty());
    }

    #[test]
    fn a_recorded_selection_this_release_still_offers_is_carried_over() {
        let carried = carry_over(
            &release(&["wide", "classic", "head"]),
            Some(&["head".to_owned(), "wide".to_owned()]),
        );
        assert_eq!(carried.selection, ["wide", "head"]);
        assert!(carried.dropped.is_empty());
        assert!(!carried.ask);
    }

    #[test]
    fn a_part_the_release_no_longer_offers_is_named_rather_than_dropped_silently() {
        let carried = carry_over(
            &release(&["wide", "head"]),
            Some(&["wide".to_owned(), "voice".to_owned()]),
        );
        assert_eq!(carried.selection, ["wide"]);
        assert_eq!(carried.dropped, ["voice"]);
        // The one-of group still holds its choice, so there is nothing to put back to the user.
        assert!(!carried.ask);
    }

    #[test]
    fn a_one_of_group_emptied_by_a_drop_goes_back_to_the_user() {
        // Picking for them is picking wrong as often as not.
        let carried = carry_over(&release(&["classic", "head"]), Some(&["wide".to_owned()]));
        assert_eq!(carried.dropped, ["wide"]);
        assert!(carried.ask);
    }

    #[test]
    fn a_newly_offered_part_starts_off_and_does_not_stop_the_upgrade() {
        // The record predates `voice`, which this release publishes.
        let carried = carry_over(
            &release(&["wide", "head", "voice"]),
            Some(&["wide".to_owned(), "head".to_owned()]),
        );
        assert_eq!(carried.selection, ["wide", "head"]);
        assert!(!carried.ask);
    }
}

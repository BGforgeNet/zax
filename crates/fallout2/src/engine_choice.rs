//! Which build of an engine a game folder should run.
//!
//! Pure, and kept apart from the deployment it decides for: a folder holds at most one build, so
//! choosing is the whole of what a version list does, and every arm of the rule is assertable without a
//! filesystem.

use crate::engine_release::CachedEngine;
use crate::records::InstalledEngine;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BuildChoice {
    /// What the folder holds is what should run. `pin` is what the record should say afterwards.
    Here { pin: bool },
    /// Put this build in place first, then run it.
    Deploy { build: CachedEngine, pin: bool },
    /// Nothing to run: the folder holds none, and none the machine holds answers.
    Nothing,
}

/// What a user picked for a folder: one build by its publication instant, or `Latest` to clear a pin
/// and follow the newest build the machine holds. Two variants rather than two strings, since a tag
/// could be spelled `latest` and an instant cannot be told from one by type.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(tag = "pick", rename_all = "lowercase")]
pub enum BuildPick {
    Published(String),
    Latest,
}

/// `cached` is newest first, as `cached_engines` returns it. `asked` is what the user picked, or
/// nothing to follow the folder's rule - what a plain run does, and the one answer that leaves a pin
/// standing.
///
/// An unpinned folder follows the newest cached build, so fetching a newer one moves it forward on the
/// next run. That is what makes latest the default, and the pin is how a user opts out of it.
#[must_use]
pub fn choose_build(
    deployed: Option<&InstalledEngine>,
    cached: &[CachedEngine],
    asked: Option<&BuildPick>,
) -> BuildChoice {
    if let Some(BuildPick::Published(at)) = asked {
        let Some(wanted) = cached.iter().find(|one| one.release.published == *at) else {
            // The cache moved since the list was drawn. Refusing beats silently running a different
            // build.
            return BuildChoice::Nothing;
        };
        return if deployed.is_some_and(|one| one.published == *at) {
            BuildChoice::Here { pin: true }
        } else {
            BuildChoice::Deploy {
                build: wanted.clone(),
                pin: true,
            }
        };
    }

    let newest = cached.first();
    let Some(deployed) = deployed else {
        return newest.map_or(BuildChoice::Nothing, |build| BuildChoice::Deploy {
            build: build.clone(),
            pin: false,
        });
    };
    if deployed.pinned && asked.is_none() {
        return BuildChoice::Here { pin: true };
    }
    // The instants are ISO 8601, so a lexical comparison is chronological.
    if let Some(newest) = newest
        && newest.release.published > deployed.published
    {
        return BuildChoice::Deploy {
            build: newest.clone(),
            pin: false,
        };
    }
    BuildChoice::Here { pin: false }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine_release::EngineRelease;
    use std::path::PathBuf;

    fn build(published: &str) -> CachedEngine {
        CachedEngine {
            release: EngineRelease {
                release: "continious".to_owned(),
                published: published.to_owned(),
                asset: None,
                commit: None,
            },
            archive: PathBuf::from(format!("/cache/{published}.zip")),
        }
    }

    fn deployed(published: &str, pinned: bool) -> InstalledEngine {
        InstalledEngine {
            id: "fallout2-ce".to_owned(),
            release: "continious".to_owned(),
            published: published.to_owned(),
            complete: true,
            files: Vec::new(),
            backup: None,
            commit: None,
            pinned,
        }
    }

    const OLD: &str = "2024-01-01T00:00:00Z";
    const NEW: &str = "2025-01-01T00:00:00Z";

    #[test]
    fn an_empty_folder_with_an_empty_cache_has_nothing_to_run() {
        assert_eq!(choose_build(None, &[], None), BuildChoice::Nothing);
    }

    #[test]
    fn an_empty_folder_takes_the_newest_the_machine_holds_unpinned() {
        assert_eq!(
            choose_build(None, &[build(NEW), build(OLD)], None),
            BuildChoice::Deploy {
                build: build(NEW),
                pin: false
            }
        );
    }

    #[test]
    fn an_unpinned_folder_moves_forward_when_a_newer_build_is_cached() {
        // That is what makes latest the default.
        assert_eq!(
            choose_build(Some(&deployed(OLD, false)), &[build(NEW)], None),
            BuildChoice::Deploy {
                build: build(NEW),
                pin: false
            }
        );
    }

    #[test]
    fn an_unpinned_folder_already_holding_the_newest_runs_what_it_has() {
        assert_eq!(
            choose_build(Some(&deployed(NEW, false)), &[build(NEW), build(OLD)], None),
            BuildChoice::Here { pin: false }
        );
    }

    #[test]
    fn a_pinned_folder_stays_where_it_is_on_a_plain_run() {
        // The pin is how a user opts out of following the newest.
        assert_eq!(
            choose_build(Some(&deployed(OLD, true)), &[build(NEW)], None),
            BuildChoice::Here { pin: true }
        );
    }

    #[test]
    fn asking_for_latest_clears_a_pin() {
        assert_eq!(
            choose_build(
                Some(&deployed(OLD, true)),
                &[build(NEW)],
                Some(&BuildPick::Latest)
            ),
            BuildChoice::Deploy {
                build: build(NEW),
                pin: false
            }
        );
    }

    #[test]
    fn asking_for_latest_with_nothing_newer_leaves_the_folder_unpinned() {
        assert_eq!(
            choose_build(
                Some(&deployed(NEW, true)),
                &[build(NEW)],
                Some(&BuildPick::Latest)
            ),
            BuildChoice::Here { pin: false }
        );
    }

    #[test]
    fn asking_for_one_build_pins_the_folder_to_it() {
        assert_eq!(
            choose_build(
                Some(&deployed(NEW, false)),
                &[build(NEW), build(OLD)],
                Some(&BuildPick::Published(OLD.to_owned()))
            ),
            BuildChoice::Deploy {
                build: build(OLD),
                pin: true
            }
        );
    }

    #[test]
    fn asking_for_the_build_already_there_pins_without_deploying() {
        assert_eq!(
            choose_build(
                Some(&deployed(OLD, false)),
                &[build(OLD)],
                Some(&BuildPick::Published(OLD.to_owned()))
            ),
            BuildChoice::Here { pin: true }
        );
    }

    #[test]
    fn a_build_the_cache_no_longer_holds_is_refused() {
        // Refusing beats silently running a different build.
        assert_eq!(
            choose_build(
                Some(&deployed(NEW, false)),
                &[build(NEW)],
                Some(&BuildPick::Published(OLD.to_owned()))
            ),
            BuildChoice::Nothing
        );
    }
}

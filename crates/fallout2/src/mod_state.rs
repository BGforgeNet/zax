//! The user's own files across an install that rewrites them.
//!
//! Both kinds of base install need this and neither owns it: a delegated one hands the directory to
//! an installer that writes `ddraw.ini` from its own copy, and a created one unpacks a payload
//! carrying the same files. Without it, installing either would silently reset two of ZAX's own
//! settings tabs.
//!
//! The order is hold, let the install write, merge back - the user's values winning over the
//! release's new defaults, with the previous release's copy as the base where a record holds one.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use zax_core::ini::IniDocument;
use zax_core::ini_merge::{MergeConflict, merge_ini};
use zax_platform::fs::FileKind;
use zax_platform::{Platform, Result};

fn inside(root: &Path, relative: &str) -> PathBuf {
    let mut at = root.to_path_buf();
    for part in relative.split('/').filter(|part| !part.is_empty()) {
        at.push(part);
    }
    at
}

/// The declared files that are actually there, read into memory and copied to the timestamped
/// backup.
///
/// # Errors
///
/// Fails when a file that is there cannot be read or copied.
pub fn hold_user_files(
    platform: &dyn Platform,
    root: &Path,
    declared: &[String],
    backup: &Path,
) -> Result<BTreeMap<String, Vec<u8>>> {
    let mut held = BTreeMap::new();
    for path in declared {
        let at = inside(root, path);
        if platform.fs().stat(&at)?.map(|s| s.kind) != Some(FileKind::File) {
            continue;
        }
        held.insert(path.clone(), platform.fs().read(&at)?);
        platform.fs().copy(&at, &inside(backup, path))?;
    }
    Ok(held)
}

/// Puts held copies back exactly as they were, for a file the merge cannot carry.
///
/// `mods_order.txt` is a list of names rather than keys, so an ini merge would find nothing of the
/// user's in it and keep the release's copy - dropping a load order the user built. Paired with
/// [`hold_user_files`] and kept beside it, since a hold whose restore lives somewhere else is a pair
/// nobody can check.
///
/// Files that were not there are not created: what was held is what comes back.
///
/// # Errors
///
/// Fails when a file cannot be written.
pub fn restore_user_files(
    platform: &dyn Platform,
    root: &Path,
    held: &BTreeMap<String, Vec<u8>>,
) -> Result<()> {
    for (path, bytes) in held {
        platform.fs().write(&inside(root, path), bytes)?;
    }
    Ok(())
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MergedState {
    /// What the release shipped, as bytes - the base the next upgrade's merge compares against.
    pub shipped: BTreeMap<String, Vec<u8>>,
    /// Settings both the user and the release changed; the user's won.
    pub conflicts: Vec<MergeConflict>,
}

/// Merges the held copies back into what the install has just written, and records what it wrote.
///
/// Every declared file that is there now is recorded, including one this install introduced: it is
/// the base the next upgrade needs, and there is nothing else that could supply it later.
///
/// # Errors
///
/// Fails when a file cannot be read or written.
pub fn merge_user_files(
    platform: &dyn Platform,
    root: &Path,
    declared: &[String],
    held: &BTreeMap<String, Vec<u8>>,
    previous: Option<&BTreeMap<String, Vec<u8>>>,
) -> Result<MergedState> {
    let mut out = MergedState::default();
    for path in declared {
        let target = inside(root, path);
        if platform.fs().stat(&target)?.map(|s| s.kind) != Some(FileKind::File) {
            continue;
        }
        let shipped = platform.fs().read(&target)?;
        out.shipped.insert(path.clone(), shipped.clone());

        let Some(mine) = held.get(path) else {
            continue;
        };
        let base = previous
            .and_then(|held| held.get(path))
            .map(|bytes| IniDocument::parse(bytes));
        let merged = merge_ini(
            IniDocument::parse(&shipped),
            &IniDocument::parse(mine),
            base.as_ref(),
        );
        platform.fs().write(&target, &merged.document.to_bytes())?;
        out.conflicts.extend(merged.conflicts);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use zax_platform::memory::{Content, MemoryOptions, MemoryPlatform};

    fn platform_with(files: &[(&str, &str)]) -> MemoryPlatform {
        MemoryPlatform::new(MemoryOptions {
            files: files
                .iter()
                .map(|(p, c)| ((*p).to_owned(), Content::from(*c)))
                .collect(),
            ..MemoryOptions::default()
        })
    }

    fn declared() -> Vec<String> {
        vec!["ddraw.ini".to_owned(), "mods/mods_order.txt".to_owned()]
    }

    #[test]
    fn only_the_declared_files_that_are_there_are_held() {
        let platform = platform_with(&[("/game/ddraw.ini", "[Misc]\nA=1\n")]);
        let held = hold_user_files(
            &platform,
            Path::new("/game"),
            &declared(),
            Path::new("/backup"),
        )
        .expect("hold");
        assert_eq!(held.keys().collect::<Vec<_>>(), vec!["ddraw.ini"]);
        assert_eq!(
            platform.text_at("/backup/ddraw.ini").as_deref(),
            Some("[Misc]\nA=1\n")
        );
    }

    #[test]
    fn a_restore_puts_a_held_file_back_exactly() {
        // mods_order.txt is a list of names, so a merge would keep the release's copy instead.
        let platform = platform_with(&[("/game/mods/mods_order.txt", "ecco\nrpu\n")]);
        let held = hold_user_files(
            &platform,
            Path::new("/game"),
            &declared(),
            Path::new("/backup"),
        )
        .expect("hold");

        platform
            .fs()
            .write(
                Path::new("/game/mods/mods_order.txt"),
                b"the release's own\n",
            )
            .expect("the install writes");
        restore_user_files(&platform, Path::new("/game"), &held).expect("restore");

        assert_eq!(
            platform.text_at("/game/mods/mods_order.txt").as_deref(),
            Some("ecco\nrpu\n")
        );
    }

    #[test]
    fn a_file_that_was_not_there_is_not_created_by_a_restore() {
        let platform = MemoryPlatform::default();
        let held = BTreeMap::new();
        restore_user_files(&platform, Path::new("/game"), &held).expect("restore");
        assert_eq!(platform.all_files(), Vec::<String>::new());
    }

    #[test]
    fn the_users_value_wins_over_the_releases_new_default() {
        let platform = platform_with(&[("/game/ddraw.ini", "[Misc]\nA=9\n")]);
        let held = hold_user_files(
            &platform,
            Path::new("/game"),
            &declared(),
            Path::new("/backup"),
        )
        .expect("hold");

        // The install rewrites the file from its own copy.
        platform
            .fs()
            .write(Path::new("/game/ddraw.ini"), b"[Misc]\nA=2\nB=5\n")
            .expect("the install writes");

        let merged = merge_user_files(&platform, Path::new("/game"), &declared(), &held, None)
            .expect("merge");

        assert_eq!(
            platform.text_at("/game/ddraw.ini").as_deref(),
            Some("[Misc]\nA=9\nB=5\n"),
            "the user's A must win and the release's new B must arrive"
        );
        assert!(merged.shipped.contains_key("ddraw.ini"));
    }

    #[test]
    fn what_the_release_shipped_is_recorded_before_the_merge_rewrites_it() {
        // It is the base the next upgrade compares against, and nothing else could supply it later.
        let platform = platform_with(&[("/game/ddraw.ini", "[Misc]\nA=9\n")]);
        let held = hold_user_files(
            &platform,
            Path::new("/game"),
            &declared(),
            Path::new("/backup"),
        )
        .expect("hold");
        platform
            .fs()
            .write(Path::new("/game/ddraw.ini"), b"[Misc]\nA=2\n")
            .expect("the install writes");

        let merged = merge_user_files(&platform, Path::new("/game"), &declared(), &held, None)
            .expect("merge");
        assert_eq!(
            merged.shipped.get("ddraw.ini").map(|b| b.as_slice()),
            Some(b"[Misc]\nA=2\n".as_slice())
        );
    }

    #[test]
    fn a_previous_release_lets_an_untouched_value_yield_to_the_new_default() {
        let platform = platform_with(&[("/game/ddraw.ini", "[Misc]\nA=1\n")]);
        let held = hold_user_files(
            &platform,
            Path::new("/game"),
            &declared(),
            Path::new("/backup"),
        )
        .expect("hold");
        platform
            .fs()
            .write(Path::new("/game/ddraw.ini"), b"[Misc]\nA=2\n")
            .expect("the install writes");

        // The previous release also shipped A=1, so the user never chose it.
        let previous = BTreeMap::from([("ddraw.ini".to_owned(), b"[Misc]\nA=1\n".to_vec())]);
        merge_user_files(
            &platform,
            Path::new("/game"),
            &declared(),
            &held,
            Some(&previous),
        )
        .expect("merge");

        assert_eq!(
            platform.text_at("/game/ddraw.ini").as_deref(),
            Some("[Misc]\nA=2\n"),
            "an untouched value must take the release's new default"
        );
    }

    #[test]
    fn a_setting_both_sides_changed_is_reported_as_a_conflict() {
        let platform = platform_with(&[("/game/ddraw.ini", "[Misc]\nA=9\n")]);
        let held = hold_user_files(
            &platform,
            Path::new("/game"),
            &declared(),
            Path::new("/backup"),
        )
        .expect("hold");
        platform
            .fs()
            .write(Path::new("/game/ddraw.ini"), b"[Misc]\nA=2\n")
            .expect("the install writes");

        let previous = BTreeMap::from([("ddraw.ini".to_owned(), b"[Misc]\nA=1\n".to_vec())]);
        let merged = merge_user_files(
            &platform,
            Path::new("/game"),
            &declared(),
            &held,
            Some(&previous),
        )
        .expect("merge");

        assert_eq!(merged.conflicts.len(), 1, "{:?}", merged.conflicts);
        assert_eq!(merged.conflicts[0].key, "A");
        assert_eq!(
            platform.text_at("/game/ddraw.ini").as_deref(),
            Some("[Misc]\nA=9\n")
        );
    }
}

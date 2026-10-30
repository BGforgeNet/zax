//! Lowercasing a game directory, which is what makes a base mod's install work on a case-sensitive
//! filesystem at all.
//!
//! Upstream's shell installer refuses over an uppercase filename and tells the user to lowercase the
//! tree by hand; the Windows route never meets the problem and carries no such check. So this is
//! ZAX's to do, and it is the widest-reaching rename in the application - hence the guards. It runs
//! only where the filesystem actually distinguishes case, only on entries that actually differ from
//! their lowercase form, never inside `backup/` or a `.git/`, and not at all if two entries would
//! collide, which is the one outcome that loses a file.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use zax_platform::fs::FileKind;
use zax_platform::{Platform, Result};

/// Where the install's own way back lives. Renaming inside it would rewrite the history it exists to
/// keep.
const BACKUP: &str = "backup";

/// A repository's own bookkeeping.
///
/// `HEAD`, `ORIG_HEAD` and a branch named with a capital are all uppercase by design, so lowercasing
/// inside one leaves a repository git can no longer open - and the game never reads it. Matched
/// case-insensitively like `backup`: on a case-sensitive filesystem `.GIT` is not a repository, and
/// renaming it to `.git` would hand git a directory it then believes is one.
const GIT: &str = ".git";

fn inside(root: &Path, relative: &str) -> PathBuf {
    let mut at = root.to_path_buf();
    for part in relative.split('/').filter(|part| !part.is_empty()) {
        at.push(part);
    }
    at
}

/// Whether a name has anything for case to apply to - `12.dat` reads the same either way.
fn has_letters(name: &str) -> bool {
    name.to_lowercase() != name.to_uppercase()
}

/// Whether this filesystem tells `Foo.dat` from `foo.dat`, asked by looking rather than by writing.
///
/// An entry that is already there is requested under a name that differs only in case, and a
/// filesystem that answers folds case. The shell installer writes two probe files to learn the same
/// thing; nothing is written here.
///
/// False where the directory holds nothing to ask about, which is the same outcome: a pass with
/// nothing to rename changes nothing whichever kind of filesystem it is on.
///
/// # Errors
///
/// Fails only where the probe itself cannot be made.
pub fn case_sensitive_at(platform: &dyn Platform, root: &Path) -> Result<bool> {
    let entries = platform.fs().list(root).unwrap_or_default();
    let Some(probe) = entries.iter().find(|entry| has_letters(&entry.name)) else {
        return Ok(false);
    };
    let flipped = if probe.name == probe.name.to_lowercase() {
        probe.name.to_uppercase()
    } else {
        probe.name.to_lowercase()
    };
    Ok(platform.fs().stat(&root.join(flipped))?.is_none())
}

/// Every entry under `root` whose name is not already lowercase, deepest first - so a directory is
/// renamed only once nothing below it still has to be found under the old name.
///
/// # Errors
///
/// Fails when two entries in one directory differ only by case: legal here and impossible
/// afterwards, so renaming one onto the other would lose it. The refusal names both and the pass
/// does not start.
pub fn mixed_case_paths(platform: &dyn Platform, root: &Path) -> Result<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    let mut pending: Vec<String> = vec![String::new()];

    while let Some(prefix) = pending.pop() {
        let at = if prefix.is_empty() {
            root.to_path_buf()
        } else {
            inside(root, &prefix)
        };
        let entries = platform.fs().list(&at).unwrap_or_default();

        let mut folded: BTreeMap<String, String> = BTreeMap::new();
        for entry in &entries {
            let path = if prefix.is_empty() {
                entry.name.clone()
            } else {
                format!("{prefix}/{}", entry.name)
            };
            if let Some(held) = folded.insert(entry.name.to_lowercase(), path.clone()) {
                return Err(zax_platform::Error::Unsupported(case_collision(
                    &held, &path,
                )));
            }
        }

        for entry in &entries {
            let path = if prefix.is_empty() {
                entry.name.clone()
            } else {
                format!("{prefix}/{}", entry.name)
            };
            let lowered = entry.name.to_lowercase();
            // The two exclusions, and they are the whole of them: everything else in the tree is the
            // game's.
            if prefix.is_empty() && entry.kind == FileKind::Dir && lowered == BACKUP {
                continue;
            }
            // At any depth, where backup is the root's alone: a repository around a mods directory,
            // or one a mod was unpacked from, breaks exactly as thoroughly as one at the top.
            if entry.kind == FileKind::Dir && lowered == GIT {
                continue;
            }
            if entry.kind == FileKind::Dir {
                pending.push(path.clone());
            }
            if entry.name != lowered {
                out.push(path);
            }
        }
    }

    // Deepest first. The walk is iterative, so the order it finds them in is the queue's rather than
    // the tree's; sorting by depth is what keeps a directory from being renamed before its contents.
    out.sort_by(|a, b| {
        b.matches('/')
            .count()
            .cmp(&a.matches('/').count())
            .then_with(|| a.cmp(b))
    });
    Ok(out)
}

fn case_collision(one: &str, other: &str) -> String {
    format!(
        "This game folder holds both \"{one}\" and \"{other}\", which differ only in case. \
         Lowercasing it would leave one of them on top of the other, so nothing was renamed - \
         remove or rename one of the two by hand first."
    )
}

/// Lowercases the tree, deepest first, and answers with what it renamed.
///
/// Every path is resolved before the first rename, so a collision anywhere refuses before anything
/// moves.
///
/// # Errors
///
/// Fails on a case collision, or when a rename fails.
pub fn lowercase_tree(platform: &dyn Platform, root: &Path) -> Result<Vec<String>> {
    let paths = mixed_case_paths(platform, root)?;
    for path in &paths {
        let mut pieces: Vec<&str> = path.split('/').collect();
        let name = pieces.pop().unwrap_or_default().to_lowercase();
        let mut lowered = pieces.join("/");
        if !lowered.is_empty() {
            lowered.push('/');
        }
        lowered.push_str(&name);
        platform
            .fs()
            .rename(&inside(root, path), &inside(root, &lowered))?;
    }
    Ok(paths)
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

    #[test]
    fn a_directory_holding_nothing_to_ask_about_reads_as_folding() {
        // A pass with nothing to rename changes nothing whichever filesystem it is on.
        let platform = MemoryPlatform::default();
        assert!(!case_sensitive_at(&platform, Path::new("/games/f2")).expect("probe"));
    }

    #[test]
    fn a_filesystem_that_answers_under_the_flipped_name_folds_case() {
        // The memory platform is case-sensitive, so the probe should report that.
        let platform = platform_with(&[("/games/f2/Master.dat", "x")]);
        assert!(case_sensitive_at(&platform, Path::new("/games/f2")).expect("probe"));
    }

    #[test]
    fn nothing_uppercase_means_nothing_to_rename() {
        let platform = platform_with(&[("/games/f2/master.dat", "x")]);
        assert!(
            mixed_case_paths(&platform, Path::new("/games/f2"))
                .expect("walk")
                .is_empty()
        );
    }

    #[test]
    fn an_uppercase_name_is_listed() {
        let platform = platform_with(&[("/games/f2/MASTER.DAT", "x"), ("/games/f2/ok.dat", "y")]);
        assert_eq!(
            mixed_case_paths(&platform, Path::new("/games/f2")).expect("walk"),
            vec!["MASTER.DAT".to_owned()]
        );
    }

    #[test]
    fn deeper_entries_come_before_the_directories_holding_them() {
        // A directory is renamed only once nothing below it still has to be found under the old name.
        let platform = platform_with(&[("/games/f2/Data/Art/FRM.dat", "x")]);
        let paths = mixed_case_paths(&platform, Path::new("/games/f2")).expect("walk");
        let depth_of = |needle: &str| {
            paths
                .iter()
                .position(|p| p == needle)
                .unwrap_or_else(|| panic!("{needle} was not listed"))
        };
        assert!(depth_of("Data/Art/FRM.dat") < depth_of("Data/Art"));
        assert!(depth_of("Data/Art") < depth_of("Data"));
    }

    #[test]
    fn the_backup_directory_is_left_alone() {
        // Renaming inside it would rewrite the history it exists to keep.
        let platform = platform_with(&[("/games/f2/backup/Saved.cfg", "x")]);
        assert!(
            mixed_case_paths(&platform, Path::new("/games/f2"))
                .expect("walk")
                .is_empty()
        );
    }

    #[test]
    fn a_git_directory_is_left_alone_at_any_depth() {
        // Lowercasing inside one leaves a repository git can no longer open.
        let platform = platform_with(&[
            ("/games/f2/.git/HEAD", "ref"),
            ("/games/f2/mods/.git/HEAD", "ref"),
        ]);
        assert!(
            mixed_case_paths(&platform, Path::new("/games/f2"))
                .expect("walk")
                .is_empty()
        );
    }

    #[test]
    fn two_entries_differing_only_in_case_refuse_the_whole_pass() {
        // The one outcome that loses a file.
        let platform =
            platform_with(&[("/games/f2/Master.dat", "x"), ("/games/f2/master.dat", "y")]);
        let err = mixed_case_paths(&platform, Path::new("/games/f2")).expect_err("refused");
        let said = err.to_string();
        assert!(said.contains("differ only in case"), "{said}");
        assert!(said.contains("Master.dat"), "{said}");
    }

    #[test]
    fn a_collision_anywhere_refuses_before_anything_moves() {
        let platform = platform_with(&[
            ("/games/f2/Ok.dat", "a"),
            ("/games/f2/data/Art.frm", "b"),
            ("/games/f2/data/art.frm", "c"),
        ]);
        assert!(lowercase_tree(&platform, Path::new("/games/f2")).is_err());
        assert!(
            platform.text_at("/games/f2/Ok.dat").is_some(),
            "nothing should have been renamed"
        );
    }

    #[test]
    fn the_tree_is_lowercased_and_its_contents_survive() {
        let platform = platform_with(&[
            ("/games/f2/Data/Art/FRM.dat", "art"),
            ("/games/f2/Master.dat", "master"),
        ]);
        let renamed = lowercase_tree(&platform, Path::new("/games/f2")).expect("rename");
        assert!(!renamed.is_empty());
        assert_eq!(
            platform.text_at("/games/f2/master.dat").as_deref(),
            Some("master")
        );
        assert_eq!(
            platform.text_at("/games/f2/data/art/frm.dat").as_deref(),
            Some("art")
        );
        assert_eq!(platform.text_at("/games/f2/Master.dat"), None);
    }

    #[test]
    fn a_name_with_no_letters_is_left_alone() {
        let platform = platform_with(&[("/games/f2/12.dat", "x")]);
        assert!(
            mixed_case_paths(&platform, Path::new("/games/f2"))
                .expect("walk")
                .is_empty()
        );
    }
}

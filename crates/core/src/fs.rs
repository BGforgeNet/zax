//! Directory walking, built on the platform seam rather than in it: the seam stays the set of things
//! only a host can do, and anything expressible in terms of those belongs above it where it is
//! testable.

use std::path::Path;

use zax_platform::fs::FileKind;
use zax_platform::{Platform, Result};

/// How deep the walk descends.
///
/// The TypeScript recursed without a bound. Two reasons to have one here: a directory that contains
/// itself - a junction point on Windows, a symlink anywhere - walks forever, and the recursive shape
/// would overflow the stack rather than merely spin. No game install approaches this depth.
const MAX_DEPTH: usize = 64;

/// Every file under a directory, as `/`-separated paths relative to it, in sorted order.
///
/// The TypeScript yielded them deepest-last, in whatever order the host listed each directory. The
/// walk here is iterative, so that order is an artifact of the queue rather than anything a caller
/// could rely on; sorting makes it the same on every host instead.
///
/// An absent directory yields nothing rather than failing - callers ask about directories that may
/// not exist (`mods`, a save folder).
///
/// # Errors
///
/// Fails when a directory below the root cannot be listed.
pub fn list_files_recursively(platform: &dyn Platform, root: &Path) -> Result<Vec<String>> {
    if platform.fs().stat(root)?.map(|s| s.kind) != Some(FileKind::Dir) {
        return Ok(Vec::new());
    }

    let mut out = Vec::new();
    // Iterative rather than recursive: the depth bound alone would not stop a deep tree from
    // exhausting the stack, and a queue costs nothing here.
    let mut pending: Vec<(String, usize)> = vec![(String::new(), 0)];
    while let Some((relative, depth)) = pending.pop() {
        let here = if relative.is_empty() {
            root.to_path_buf()
        } else {
            join_relative(root, &relative)
        };
        for entry in platform.fs().list(&here)? {
            let next = if relative.is_empty() {
                entry.name.clone()
            } else {
                format!("{relative}/{}", entry.name)
            };
            match entry.kind {
                FileKind::Dir if depth < MAX_DEPTH => pending.push((next, depth + 1)),
                FileKind::File => out.push(next),
                FileKind::Dir | FileKind::Other => {}
            }
        }
    }
    out.sort();
    Ok(out)
}

/// Copies every file from one tree into another, overwriting.
///
/// Answers the relative paths copied, which is what a caller needs to report or to have backed up
/// first.
///
/// # Errors
///
/// Fails when a file cannot be read or written.
pub fn copy_tree(platform: &dyn Platform, from: &Path, to: &Path) -> Result<Vec<String>> {
    let files = list_files_recursively(platform, from)?;
    for file in &files {
        platform
            .fs()
            .copy(&join_relative(from, file), &join_relative(to, file))?;
    }
    Ok(files)
}

/// Joins a `/`-separated relative path onto a base, one component at a time, so the host's own
/// separator is used.
fn join_relative(base: &Path, relative: &str) -> std::path::PathBuf {
    let mut at = base.to_path_buf();
    for part in relative.split('/').filter(|part| !part.is_empty()) {
        at.push(part);
    }
    at
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
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
    fn an_absent_directory_yields_nothing_rather_than_failing() {
        // Callers ask about directories that may not exist.
        let platform = MemoryPlatform::default();
        let found = list_files_recursively(&platform, Path::new("/nowhere")).expect("walk");
        assert_eq!(found, Vec::<String>::new());
    }

    #[test]
    fn a_file_rather_than_a_directory_yields_nothing() {
        let platform = platform_with(&[("/a/one.txt", "one")]);
        let found = list_files_recursively(&platform, Path::new("/a/one.txt")).expect("walk");
        assert_eq!(found, Vec::<String>::new());
    }

    #[test]
    fn lists_every_file_relative_to_the_root() {
        let platform = platform_with(&[
            ("/game/one.txt", "one"),
            ("/game/data/two.txt", "two"),
            ("/game/data/deep/three.txt", "three"),
        ]);
        let found = list_files_recursively(&platform, Path::new("/game")).expect("walk");
        assert_eq!(
            found,
            vec![
                "data/deep/three.txt".to_owned(),
                "data/two.txt".to_owned(),
                "one.txt".to_owned(),
            ]
        );
    }

    #[test]
    fn an_empty_directory_contributes_nothing() {
        let platform = MemoryPlatform::new(MemoryOptions {
            dirs: vec!["/game/mods".to_owned()],
            files: BTreeMap::from([("/game/one.txt".to_owned(), Content::from("one"))]),
            ..MemoryOptions::default()
        });
        let found = list_files_recursively(&platform, Path::new("/game")).expect("walk");
        assert_eq!(found, vec!["one.txt".to_owned()]);
    }

    #[test]
    fn copy_tree_reproduces_the_structure_and_reports_what_it_copied() {
        let platform = platform_with(&[("/from/one.txt", "one"), ("/from/data/two.txt", "two")]);
        let copied = copy_tree(&platform, Path::new("/from"), Path::new("/to")).expect("copy");
        assert_eq!(
            copied,
            vec!["data/two.txt".to_owned(), "one.txt".to_owned()]
        );
        assert_eq!(platform.text_at("/to/one.txt").as_deref(), Some("one"));
        assert_eq!(platform.text_at("/to/data/two.txt").as_deref(), Some("two"));
    }

    #[test]
    fn copying_an_absent_tree_copies_nothing() {
        let platform = MemoryPlatform::default();
        let copied = copy_tree(&platform, Path::new("/nowhere"), Path::new("/to")).expect("copy");
        assert!(copied.is_empty());
        assert_eq!(platform.all_files(), Vec::<String>::new());
    }

    #[test]
    fn the_walk_stops_at_its_depth_bound() {
        // A directory that contains itself would otherwise walk forever. The bound is far past any
        // real install, so this builds a tree deep enough to reach it.
        let deep: String = (0..MAX_DEPTH + 10)
            .map(|n| format!("d{n}"))
            .collect::<Vec<_>>()
            .join("/");
        let platform = platform_with(&[(&format!("/root/{deep}/leaf.txt"), "leaf")]);
        let found = list_files_recursively(&platform, Path::new("/root")).expect("walk");
        assert!(
            found.is_empty(),
            "the bound should have stopped the descent"
        );
    }
}

//! What an archive is allowed to contain, judged from its directory before anything is extracted.
//!
//! Shared by every path that unpacks a downloaded archive over a game folder - a mod payload and an
//! sfall release alike. The two differ in where the archive comes from and in what integrity the
//! publisher offers, not in what an archive can do once an extractor is pointed at it: a symlink
//! entry writes wherever it points, an entry named ".." writes above the folder it was aimed at, and
//! a declaration nobody read is how a few hundred kilobytes become a full disk. Extraction is too
//! late to find any of them out.

use std::path::Path;

use zax_platform::archive::{ArchiveEntryInfo, ArchiveEntryKind};
use zax_platform::{Error, Platform, Result};

/// Ceilings, measured against the published corpus.
///
/// Everything ZAX installs declares under 100 entries and a gigabyte except Fallout et tu, which
/// ships Fallout 1's asset tree unpacked rather than in a `.dat`: 10,985 entries at v1.16.3771, up
/// from 9,591 at v1.8, which is why this ceiling sits so far above the rest.
const MAX_ENTRIES: usize = 65_536;
const MAX_PATH_DEPTH: usize = 16;
const MAX_TOTAL_BYTES: u64 = 8 * 1024 * 1024 * 1024;

fn segments(name: &str) -> impl Iterator<Item = &str> {
    name.split(['/', '\\'])
}

/// Whether an entry names somewhere other than inside the folder it is unpacked into - an absolute
/// path, a drive or share root, or a climb through "..".
///
/// An extractor usually declines these itself, but that is its behaviour rather than a guarantee
/// this code holds, and extraction here is one implementation of the platform seam among others.
/// Judged on the name as declared, splitting on either separator, since a Windows archive writes the
/// other one.
fn escapes_directory(name: &str) -> bool {
    let bytes = name.as_bytes();
    if matches!(bytes.first(), Some(b'/' | b'\\')) {
        return true;
    }
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return true;
    }
    segments(name).any(|segment| segment == "..")
}

/// The device names Windows reserves at every level of a path, whatever extension follows them.
fn reserved_device(segment: &str) -> bool {
    let lowered = segment.to_lowercase();
    let stem = lowered.split('.').next().unwrap_or(&lowered);
    if matches!(stem, "con" | "prn" | "aux" | "nul") {
        return true;
    }
    let is_numbered = |prefix: &str| {
        stem.strip_prefix(prefix)
            .is_some_and(|rest| rest.len() == 1 && rest.as_bytes()[0].is_ascii_digit())
    };
    is_numbered("com") || is_numbered("lpt")
}

/// What the Windows filesystem API refuses in a name, control characters included.
///
/// The separators are absent from it: they are what splits a name into the segments this is applied
/// to.
fn illegal_character(segment: &str) -> bool {
    segment
        .chars()
        .any(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') || c.is_control())
}

/// A segment of the name Windows cannot create, or `None` when every one of them can be.
///
/// Judged on every host rather than only where extraction would fail. An archive packed on Linux can
/// carry a name Windows has no way to write, and the failure that produces there lands inside the
/// extraction, part way through a deployment - so the same refusal everywhere is what gets the author
/// told rather than one user.
fn unwritable_segment(name: &str) -> Option<&str> {
    segments(name).find(|segment| {
        if segment.is_empty() {
            return false;
        }
        // A trailing dot or space is dropped by the Windows API rather than refused, so what arrives
        // is not the file the archive named - the same class of unwritable name as a reserved device
        // or a refused character.
        illegal_character(segment)
            || reserved_device(segment)
            || segment.ends_with('.')
            || segment.ends_with(' ')
    })
}

/// Names the archiving machine generates. Matched on the last segment, since that is where the file
/// sits.
const CLUTTER: &[&str] = &[".ds_store", "thumbs.db", "desktop.ini"];

/// Whether an entry is the archiving machine's own clutter rather than anything the mod means to
/// ship.
///
/// A payload zipped on macOS carries `__MACOSX/`, and one zipped from Explorer carries `Thumbs.db`;
/// deploying either puts files in the game folder no author wrote, which uninstall then has to own
/// and the overwrite preview has to show. Only names an operating system generates are here: nothing
/// an author could have written is dropped on their behalf.
#[must_use]
pub fn is_archiving_clutter(name: &str) -> bool {
    let pieces: Vec<&str> = segments(name).filter(|piece| !piece.is_empty()).collect();
    if pieces
        .iter()
        .any(|piece| piece.to_lowercase() == "__macosx")
    {
        return true;
    }
    pieces
        .last()
        .is_some_and(|last| CLUTTER.contains(&last.to_lowercase().as_str()))
}

fn refused(message: String) -> Error {
    Error::Archive(message)
}

/// The archive's directory, once it has been judged.
///
/// Answered rather than discarded because the caller needs the same listing to plan from, and reading
/// it twice would let the two disagree.
///
/// `label` names the archive in every refusal, since the message reaches the user and "the archive"
/// does not say which one.
///
/// # Errors
///
/// Fails when the archive cannot be listed, or when its directory declares anything the ceilings or
/// the name rules refuse.
pub fn preflight_archive(
    platform: &dyn Platform,
    archive: &Path,
    label: &str,
) -> Result<Vec<ArchiveEntryInfo>> {
    let entries = platform.archive().list(archive)?;
    if entries.len() > MAX_ENTRIES {
        return Err(refused(format!(
            "{label} declares {} entries - refused.",
            entries.len()
        )));
    }

    let mut total: u64 = 0;
    for entry in &entries {
        if entry.kind == ArchiveEntryKind::Link {
            return Err(refused(format!(
                "{label} contains a symbolic link or hard link ({}) - refused, nothing was extracted.",
                entry.name
            )));
        }
        if escapes_directory(&entry.name) {
            return Err(refused(format!(
                "{label} names a path outside the folder it unpacks into ({}) - refused.",
                entry.name
            )));
        }
        if segments(&entry.name).count() > MAX_PATH_DEPTH {
            return Err(refused(format!(
                "{label} nests paths deeper than any release does ({}) - refused.",
                entry.name
            )));
        }
        if let Some(unwritable) = unwritable_segment(&entry.name) {
            return Err(refused(format!(
                "{label} names \"{unwritable}\" (in {}), which Windows cannot create - refused, \
                 since the same payload has to install on every machine.",
                entry.name
            )));
        }
        total = total.saturating_add(entry.size);
    }

    if total > MAX_TOTAL_BYTES {
        return Err(refused(format!(
            "{label} declares {total} bytes unpacked, past what any release needs - refused."
        )));
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use zax_platform::memory::{MemoryOptions, MemoryPlatform};

    fn entry(name: &str, kind: ArchiveEntryKind, size: u64) -> ArchiveEntryInfo {
        ArchiveEntryInfo {
            name: name.to_owned(),
            kind,
            size,
        }
    }

    fn platform_listing(entries: Vec<ArchiveEntryInfo>) -> MemoryPlatform {
        MemoryPlatform::new(MemoryOptions {
            listings: BTreeMap::from([("/cache/mod.zip".to_owned(), entries)]),
            ..MemoryOptions::default()
        })
    }

    fn preflight(entries: Vec<ArchiveEntryInfo>) -> Result<Vec<ArchiveEntryInfo>> {
        let platform = platform_listing(entries);
        preflight_archive(&platform, Path::new("/cache/mod.zip"), "EcCo 1.0")
    }

    fn refusal(entries: Vec<ArchiveEntryInfo>) -> String {
        preflight(entries)
            .expect_err("this archive must be refused")
            .to_string()
    }

    #[test]
    fn an_ordinary_payload_passes_and_its_listing_comes_back() {
        let entries = vec![
            entry("mods/ecco.dat", ArchiveEntryKind::File, 1024),
            entry("readme.txt", ArchiveEntryKind::File, 10),
        ];
        let out = preflight(entries.clone()).expect("an ordinary payload");
        assert_eq!(out, entries, "the caller plans from this same listing");
    }

    #[test]
    fn a_link_entry_is_refused_by_name() {
        // It writes wherever it points, and extraction is too late to find out.
        let said = refusal(vec![entry("escape", ArchiveEntryKind::Link, 0)]);
        assert!(said.contains("symbolic link"), "{said}");
        assert!(
            said.contains("EcCo 1.0"),
            "the refusal must name the archive"
        );
    }

    #[test]
    fn a_path_climbing_out_of_the_folder_is_refused() {
        for name in ["../outside.txt", "mods/../../outside.txt", "a\\..\\b"] {
            let said = refusal(vec![entry(name, ArchiveEntryKind::File, 1)]);
            assert!(said.contains("outside the folder"), "{name}: {said}");
        }
    }

    #[test]
    fn an_absolute_path_or_a_drive_root_is_refused() {
        for name in ["/etc/passwd", "\\windows\\system32", "C:/Windows", "d:\\x"] {
            let said = refusal(vec![entry(name, ArchiveEntryKind::File, 1)]);
            assert!(said.contains("outside the folder"), "{name}: {said}");
        }
    }

    #[test]
    fn a_name_windows_cannot_create_is_refused_on_every_host() {
        // The failure would otherwise land part way through a deployment, on one user's machine.
        for name in [
            "a<b.txt",
            "a\"b.txt",
            "a|b.txt",
            "data/con.txt",
            "data/LPT1",
            "a./b.txt",
        ] {
            let said = refusal(vec![entry(name, ArchiveEntryKind::File, 1)]);
            assert!(said.contains("Windows cannot create"), "{name}: {said}");
        }
    }

    #[test]
    fn a_name_that_merely_starts_with_a_device_name_is_allowed() {
        // `console.txt` is not `con`.
        let entries = vec![
            entry("console.txt", ArchiveEntryKind::File, 1),
            entry("com10.txt", ArchiveEntryKind::File, 1),
            entry("aux2/file.txt", ArchiveEntryKind::File, 1),
        ];
        assert!(preflight(entries).is_ok());
    }

    #[test]
    fn a_deeply_nested_path_is_refused() {
        let deep = (0..MAX_PATH_DEPTH + 2)
            .map(|n| format!("d{n}"))
            .collect::<Vec<_>>()
            .join("/");
        let said = refusal(vec![entry(&deep, ArchiveEntryKind::File, 1)]);
        assert!(said.contains("nests paths deeper"), "{said}");
    }

    #[test]
    fn a_bombed_size_declaration_is_refused() {
        // A few hundred kilobytes becoming a full disk.
        let said = refusal(vec![entry("big.dat", ArchiveEntryKind::File, u64::MAX / 2)]);
        assert!(said.contains("past what any release needs"), "{said}");
    }

    #[test]
    fn too_many_entries_are_refused() {
        let entries: Vec<ArchiveEntryInfo> = (0..=MAX_ENTRIES)
            .map(|n| entry(&format!("f{n}.txt"), ArchiveEntryKind::File, 1))
            .collect();
        let said = refusal(entries);
        assert!(said.contains("entries - refused"), "{said}");
    }

    #[test]
    fn fallout_et_tus_own_entry_count_still_passes() {
        // 10,985 entries at v1.16.3771 is why the ceiling sits so far above the rest.
        let entries: Vec<ArchiveEntryInfo> = (0..11_000)
            .map(|n| entry(&format!("data/f{n}.frm"), ArchiveEntryKind::File, 1024))
            .collect();
        assert!(preflight(entries).is_ok());
    }

    #[test]
    fn the_archiving_machines_own_clutter_is_recognised() {
        for name in [
            "__MACOSX/mods/._ecco.dat",
            "mods/.DS_Store",
            "Thumbs.db",
            "data/desktop.ini",
        ] {
            assert!(is_archiving_clutter(name), "{name}");
        }
    }

    #[test]
    fn nothing_an_author_could_have_written_counts_as_clutter() {
        for name in ["mods/ecco.dat", "readme.txt", "data/art/thumbs.frm"] {
            assert!(!is_archiving_clutter(name), "{name}");
        }
    }
}

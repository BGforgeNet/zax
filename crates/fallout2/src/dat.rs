//! Unpacking a Fallout archive the user owns, which is the one step of a created install that ZAX
//! cannot do with what it already has: Fallout 1's `master.dat` is a DAT1 archive, and this is what
//! the `extract-dat` manifest field reaches.
//!
//! The TypeScript ran upstream's `dat3` as a child process - an asset fetched per platform, pinned
//! by digest, with a WebAssembly build for the pairs upstream published no binary for. This links
//! upstream's own library instead, so there is no asset to fetch, no digest to re-pin per release,
//! no process to launch, and no host left without a build.
//!
//! Reads and writes still go through the platform seam. `dat3-core`'s path-based operations open
//! files themselves and print progress to stdout, so only its in-memory surface is used here.

use std::path::{Path, PathBuf};

use dat3_core::DatArchive;
use dat3_core::common::{CaseMode, NameView, utils};
use zax_platform::{Error, Platform, Result};

/// Names are compared and written the way upstream's command line does by default: the archives come
/// from DOS and Windows tooling, where case carries no meaning.
const CASE: CaseMode = CaseMode::Insensitive;

/// One entry name in the form used for matching: separators as `/`, folded for case.
fn matchable(name: &str) -> String {
    CASE.fold(&name.replace('\\', "/")).into_owned()
}

/// An archive the user owns, parsed and held in memory.
///
/// Parsing it is also the check that the folder holds a readable archive at all - the one upstream's
/// own script makes before extracting, and the one worth making before a large download rather than
/// after it. A failure carries upstream's own wording, which is written for a person to read.
pub struct DatSource {
    archive: DatArchive,
    /// Every stored name, in archive order.
    names: Vec<String>,
    /// Indices into `names`, keyed by matchable form. A key holds more than one only where the
    /// archive stores names differing just in case, which stay distinct entries.
    index: std::collections::BTreeMap<String, Vec<usize>>,
}

impl std::fmt::Debug for DatSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DatSource")
            .field("format", &self.archive.format())
            .field("entries", &self.names.len())
            .finish()
    }
}

impl DatSource {
    /// Reads the archive through the seam and parses it, detecting the format from its bytes.
    ///
    /// # Errors
    ///
    /// Fails when the file cannot be read, or when nothing in it looks like an archive this
    /// understands.
    pub fn open(platform: &dyn Platform, at: &Path) -> Result<Self> {
        let bytes = platform.fs().read(at)?;
        Self::from_bytes(bytes)
    }

    /// Parses an archive already in hand.
    ///
    /// # Errors
    ///
    /// Fails when the bytes are not an archive this understands.
    pub fn from_bytes(bytes: Vec<u8>) -> Result<Self> {
        let archive =
            DatArchive::from_bytes(bytes).map_err(|err| Error::Archive(err.to_string()))?;
        let names = archive.entry_names();
        let mut index: std::collections::BTreeMap<String, Vec<usize>> =
            std::collections::BTreeMap::new();
        for (at, name) in names.iter().enumerate() {
            index.entry(matchable(name)).or_default().push(at);
        }
        Ok(Self {
            archive,
            names,
            index,
        })
    }

    /// How many entries the archive holds.
    #[must_use]
    pub fn len(&self) -> usize {
        self.names.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.names.is_empty()
    }

    /// Extracts the paths `list` names into `into`, structure preserved, answering the ones this
    /// archive did not hold.
    ///
    /// A missing name is reported rather than refused, because a list is written against one edition
    /// of the archive and run against whichever the user owns. Nothing here judges how many are
    /// absent either: the 8.3 collision suffixes (`LI3ACD~5.TXT`) are assigned in archive order, so
    /// another edition renumbers hundreds of them at once and no count separates that from a user
    /// who pointed at Fallout 2's `master.dat`. Parsing the archive at all is what refuses that.
    ///
    /// # Errors
    ///
    /// Fails when an entry cannot be decompressed, when a name would escape `into`, or when a write
    /// through the seam fails. A name the archive does not hold is not a failure.
    pub fn extract_listed(
        &self,
        platform: &dyn Platform,
        list: &[u8],
        into: &Path,
    ) -> Result<Vec<String>> {
        // Built over every stored name, because a name with a case-only twin anywhere in the archive
        // keeps its stored case rather than being written in lowercase - otherwise the two entries
        // would land on one path.
        let shown = NameView::new(CASE, self.names.iter().map(String::as_str));
        let mut missing = Vec::new();

        for line in String::from_utf8_lossy(list).lines() {
            let wanted = line.trim();
            if wanted.is_empty() {
                continue;
            }
            let Some(matches) = self.index.get(&matchable(wanted)) else {
                missing.push(wanted.to_owned());
                continue;
            };

            // Normally one. A name matches more than one entry only where the archive stores
            // spellings differing just in case, and those are distinct files: each is written, at
            // the stored spelling `shown` keeps for exactly that reason.
            for &at in matches {
                let stored = &self.names[at];

                // A malicious archive could store an entry as `..\..\etc\passwd`, or with a drive
                // prefix, which joining would resolve outside the destination entirely. Upstream's
                // own extraction makes this check; doing the writing here means making it here.
                // No test reaches it: `insert` refuses to store such a name, so the library cannot
                // build the archive that would trip it, and the guard exists for the archives that
                // did not come from it - which is every archive this reads.
                utils::validate_archive_path(stored)
                    .map_err(|err| Error::Archive(err.to_string()))?;

                let data = self
                    .archive
                    .read(stored, CaseMode::Sensitive)
                    .map_err(|err| Error::Archive(err.to_string()))?;
                platform
                    .fs()
                    .write(&destination(into, &shown.shown(stored)), &data)?;
            }
        }

        Ok(missing)
    }
}

/// Where one entry lands, with its own separators translated to the host's.
fn destination(into: &Path, shown: &str) -> PathBuf {
    let mut at = into.to_path_buf();
    for part in shown.split(['\\', '/']).filter(|part| !part.is_empty()) {
        at.push(part);
    }
    at
}

#[cfg(test)]
mod tests {
    use super::*;
    use dat3_core::ArchiveFormat;
    use dat3_core::common::CompressionLevel;
    use zax_platform::memory::{MemoryOptions, MemoryPlatform};

    /// A real archive, built by the same library that reads it, rather than a hand-typed fixture.
    ///
    /// Entries go in case-sensitively so the name lands exactly as written. Inserting insensitively
    /// stores it lowercased and replaces any entry equal to it ignoring case, which would silently
    /// collapse a fixture meant to hold two spellings into one.
    fn archive_of(entries: &[(&str, &str)]) -> Vec<u8> {
        archive_in(ArchiveFormat::Dat2, entries)
    }

    fn archive_in(format: ArchiveFormat, entries: &[(&str, &str)]) -> Vec<u8> {
        let mut archive = DatArchive::new(format);
        let level = CompressionLevel::new(0).expect("0 is a valid compression level");
        for (name, body) in entries {
            archive
                .insert(name, body.as_bytes().to_vec(), level, CaseMode::Sensitive)
                .expect("the test names are all storable");
        }
        archive.to_bytes().expect("a built archive serializes")
    }

    fn source_of(entries: &[(&str, &str)]) -> DatSource {
        DatSource::from_bytes(archive_of(entries)).expect("the archive was just built")
    }

    #[test]
    fn bytes_that_are_not_an_archive_are_refused() {
        // The check that answers before a large download rather than after it.
        let err = DatSource::from_bytes(b"not a dat at all".to_vec())
            .expect_err("arbitrary bytes are not an archive");
        assert!(matches!(err, Error::Archive(_)), "got {err:?}");
    }

    #[test]
    fn an_archive_reports_what_it_holds() {
        let source = source_of(&[("MASTER\\ONE.TXT", "one"), ("TWO.TXT", "two")]);
        assert_eq!(source.len(), 2);
        assert!(!source.is_empty());
    }

    #[test]
    fn extracts_the_listed_paths_preserving_structure() {
        let source = source_of(&[("DATA\\ART\\ONE.FRM", "one"), ("DATA\\TWO.FRM", "two")]);
        let platform = MemoryPlatform::default();
        let missing = source
            .extract_listed(
                &platform,
                b"DATA\\ART\\ONE.FRM\nDATA\\TWO.FRM\n",
                Path::new("/out"),
            )
            .expect("extraction");

        assert!(missing.is_empty(), "nothing should be missing: {missing:?}");
        assert_eq!(
            platform.text_at("/out/data/art/one.frm").as_deref(),
            Some("one")
        );
        assert_eq!(
            platform.text_at("/out/data/two.frm").as_deref(),
            Some("two")
        );
    }

    #[test]
    fn a_name_the_archive_does_not_hold_is_reported_not_refused() {
        // A list is written against one edition of the archive and run against whichever the user
        // owns, so a name their copy spells differently must not fail the whole extraction.
        let source = source_of(&[("HELD.TXT", "held")]);
        let platform = MemoryPlatform::default();
        let missing = source
            .extract_listed(&platform, b"HELD.TXT\nABSENT.TXT\n", Path::new("/out"))
            .expect("extraction continues past a missing name");

        assert_eq!(missing, vec!["ABSENT.TXT".to_owned()]);
        assert_eq!(platform.text_at("/out/held.txt").as_deref(), Some("held"));
    }

    #[test]
    fn a_list_matches_regardless_of_case_or_separator() {
        let source = source_of(&[("DATA\\ART\\ONE.FRM", "one")]);
        let platform = MemoryPlatform::default();
        let missing = source
            .extract_listed(&platform, b"data/art/one.frm\n", Path::new("/out"))
            .expect("extraction");

        assert!(missing.is_empty(), "{missing:?}");
        assert_eq!(
            platform.text_at("/out/data/art/one.frm").as_deref(),
            Some("one")
        );
    }

    #[test]
    fn blank_lines_in_the_list_are_skipped() {
        let source = source_of(&[("ONE.TXT", "one")]);
        let platform = MemoryPlatform::default();
        let missing = source
            .extract_listed(&platform, b"\n  \nONE.TXT\n\n", Path::new("/out"))
            .expect("extraction");

        assert!(
            missing.is_empty(),
            "a blank line is not a missing entry: {missing:?}"
        );
        assert_eq!(platform.all_files(), vec!["/out/one.txt".to_owned()]);
    }

    #[test]
    fn entries_differing_only_in_case_keep_their_stored_spelling() {
        // Lowercasing both would land them on one path and lose an entry, so both spellings are
        // written as stored and both files survive.
        let source = source_of(&[("Read.Me", "upper"), ("read.me", "lower")]);
        assert_eq!(
            source.len(),
            2,
            "the fixture must hold two distinct entries"
        );

        let platform = MemoryPlatform::default();
        let missing = source
            .extract_listed(&platform, b"Read.Me\n", Path::new("/out"))
            .expect("extraction");

        assert!(missing.is_empty(), "{missing:?}");
        assert_eq!(platform.text_at("/out/Read.Me").as_deref(), Some("upper"));
        assert_eq!(platform.text_at("/out/read.me").as_deref(), Some("lower"));
    }

    #[test]
    fn the_archive_is_read_through_the_seam() {
        let platform = MemoryPlatform::new(MemoryOptions {
            files: std::collections::BTreeMap::from([(
                "/games/f1/master.dat".to_owned(),
                archive_of(&[("ONE.TXT", "one")]).into(),
            )]),
            ..MemoryOptions::default()
        });
        let source = DatSource::open(&platform, Path::new("/games/f1/master.dat"))
            .expect("open through seam");
        assert_eq!(source.len(), 1);
    }

    #[test]
    fn reads_dat1_which_is_the_format_this_exists_for() {
        // Fallout 1's master.dat is DAT1, and it is the only archive `extract-dat` is ever pointed
        // at. The format is detected from the bytes, so nothing names it on the way in.
        let bytes = archive_in(ArchiveFormat::Dat1, &[("MASTER\\ONE.TXT", "one")]);
        let source = DatSource::from_bytes(bytes).expect("a DAT1 archive was just built");
        assert_eq!(source.len(), 1);

        let platform = MemoryPlatform::default();
        let missing = source
            .extract_listed(&platform, b"MASTER\\ONE.TXT\n", Path::new("/out"))
            .expect("extraction");
        assert!(missing.is_empty(), "{missing:?}");
        assert_eq!(
            platform.text_at("/out/master/one.txt").as_deref(),
            Some("one")
        );
    }

    #[test]
    fn opening_a_path_that_is_not_there_fails() {
        let platform = MemoryPlatform::default();
        assert!(DatSource::open(&platform, Path::new("/nowhere.dat")).is_err());
    }
}

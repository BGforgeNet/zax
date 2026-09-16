//! Which release of a base mod an install is carrying, read from what the mod itself wrote.
//!
//! Base mods stamp their version into `ddraw.ini` as `[Misc] VersionString`, which is what the game
//! shows and what sfall reads. ZAX parses it rather than requiring a record, because the common
//! state is an install ZAX never performed: upstream's Windows route is an exe installer, and
//! nothing of ZAX was there when it ran. Without this, such an install is a game type with no
//! version, and no update could be offered for it.
//!
//! The strings seen in the wild - the four the shipped releases carry, and what a nightly writes
//! instead:
//!
//! ```text
//! FALLOUT II 1.02.34              UPU v34
//! FALLOUT II 1.02d  RP 2.4.34     RPU v2.4.34
//! FALLOUT II 1.02d  RP 2.3.34     RPU v2.3.34
//! FALLOUT II 1.02d  RP 2.3.3u30   RPU v30, from before the lines split
//! FALLOUT II 1.02.gitfc706658     a UPU nightly, naming the commit rather than a release
//! ```
//!
//! Another release spelling is coming - RPU's current `sfall.sh` writes `RPU` where every shipped
//! release writes `RP` - so the parser finds the trailing version and does not match on the prefix.

use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;
use zax_core::ini::IniDocument;
use zax_platform::fs::FileKind;
use zax_platform::{Platform, Result};

/// What an install says about itself.
///
/// A release names a version, and which line it belongs to is the feed list's to declare rather than
/// this parser's - a version says its own numbering and nothing about branches. A nightly names the
/// commit it was built from instead, which orders against nothing: the two are separate cases so
/// that a commit cannot reach a comparison meant for versions and come out of it as older or newer
/// than a release.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BaseVersion {
    Release { version: String },
    Nightly { commit: String },
}

struct Shapes {
    /// The post-split shape: `2.4.34`, a line and a patch.
    line_and_patch: Regex,
    /// The pre-split shape: `2.3.3u30` is patch 30 of RP 2.3.3, and names no line at all.
    pre_split: Regex,
    /// UPU's, which carries no marker of its own: the engine version with the patch number after it.
    upu: Regex,
    /// A nightly, which stamps the commit it was built from where a release stamps its number -
    /// `1.02.gitfc706658`. The dot is required so this cannot claim a string that merely ends in
    /// something hex-shaped.
    nightly: Regex,
    /// A marker before the version is what tells the RPU family from anything else.
    marker: Regex,
}

fn shapes() -> &'static Shapes {
    static SHAPES: OnceLock<Shapes> = OnceLock::new();
    SHAPES.get_or_init(|| {
        // Every pattern here is a literal in this file, so a failure to compile one is a fault in
        // this module rather than in anything it was handed.
        let compile = |pattern: &str| {
            Regex::new(pattern).unwrap_or_else(|err| panic!("{pattern} does not compile: {err}"))
        };
        Shapes {
            line_and_patch: compile(r"^\d+\.\d+\.\d+$"),
            pre_split: compile(r"^\d+(\.\d+)*u\d+$"),
            upu: compile(r"^1\.02\.(\d+)$"),
            nightly: compile(r"(?i)\.git([0-9a-f]{6,})$"),
            marker: compile(r"^[A-Za-z]+$"),
        }
    })
}

/// The release a `VersionString` names, or `None` where it names none - a vanilla install with sfall
/// has the field too, and it says nothing about a base mod.
#[must_use]
pub fn base_version_of(text: &str) -> Option<BaseVersion> {
    let shapes = shapes();
    let tokens: Vec<&str> = text.split_whitespace().collect();
    let last = tokens.last()?;

    // Ahead of the release shapes, and whatever family wrote it: a nightly stamps a commit where a
    // release stamps its number, so none of the shapes below would match it anyway.
    if let Some(found) = shapes.nightly.captures(last) {
        return Some(BaseVersion::Nightly {
            commit: found[1].to_owned(),
        });
    }

    // UPU's shape next, because it is the one that is only the engine's version with a patch number
    // after it: asked later, `FALLOUT II 1.02.34` would read as a marked version whose line is the
    // engine's `1.02`.
    if let Some(found) = shapes.upu.captures(last) {
        return Some(BaseVersion::Release {
            version: found[1].to_owned(),
        });
    }

    // Otherwise a marker before the version is what tells the RPU family from anything else. Which
    // marker it is does not matter, and deliberately: `RP` today, `RPU` in the next release.
    let before = tokens.len().checked_sub(2).and_then(|at| tokens.get(at))?;
    if !shapes.marker.is_match(before) {
        return None;
    }
    // Dropped rather than kept: Fallout et tu writes `v1.16.3771`, the same spelling as its tag, and
    // the version compared against a release is the number rather than the way that release wrote it.
    let version = last
        .strip_prefix('v')
        .or_else(|| last.strip_prefix('V'))
        .unwrap_or(last);
    if shapes.pre_split.is_match(version) || shapes.line_and_patch.is_match(version) {
        return Some(BaseVersion::Release {
            version: version.to_owned(),
        });
    }
    None
}

/// The same, read from an install's own `ddraw.ini`.
///
/// Takes the directory rather than an install because a mod that creates one writes its stamp inside
/// the directory it made, which is no install of its own yet.
///
/// # Errors
///
/// Fails when the file is there but cannot be read.
pub fn installed_base_version(platform: &dyn Platform, root: &Path) -> Result<Option<BaseVersion>> {
    let at = root.join("ddraw.ini");
    if platform.fs().stat(&at)?.map(|s| s.kind) != Some(FileKind::File) {
        return Ok(None);
    }
    let document = IniDocument::parse(&platform.fs().read(&at)?);
    Ok(document
        .get_str("Misc", "VersionString")
        .as_deref()
        .and_then(base_version_of))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use zax_platform::memory::{Content, MemoryOptions, MemoryPlatform};

    fn release(version: &str) -> Option<BaseVersion> {
        Some(BaseVersion::Release {
            version: version.to_owned(),
        })
    }

    #[test]
    fn the_four_shipped_release_strings_read_as_their_versions() {
        assert_eq!(base_version_of("FALLOUT II 1.02.34"), release("34"));
        assert_eq!(
            base_version_of("FALLOUT II 1.02d  RP 2.4.34"),
            release("2.4.34")
        );
        assert_eq!(
            base_version_of("FALLOUT II 1.02d  RP 2.3.34"),
            release("2.3.34")
        );
        assert_eq!(
            base_version_of("FALLOUT II 1.02d  RP 2.3.3u30"),
            release("2.3.3u30")
        );
    }

    #[test]
    fn a_nightly_names_its_commit_rather_than_a_version() {
        // A commit orders against nothing, so it must not reach a comparison meant for versions.
        assert_eq!(
            base_version_of("FALLOUT II 1.02.gitfc706658"),
            Some(BaseVersion::Nightly {
                commit: "fc706658".to_owned()
            })
        );
    }

    #[test]
    fn a_string_merely_ending_in_something_hex_shaped_is_not_a_nightly() {
        // The dot before `git` is what makes it one.
        assert_eq!(base_version_of("FALLOUT II gitabcdef"), None);
    }

    #[test]
    fn a_vanilla_install_with_sfall_names_no_base_mod() {
        // It has the field too, and it says nothing about a base mod.
        assert_eq!(base_version_of("FALLOUT II 1.02d"), None);
        assert_eq!(base_version_of(""), None);
        assert_eq!(base_version_of("   "), None);
    }

    #[test]
    fn the_marker_before_the_version_is_not_matched_on_its_spelling() {
        // `RP` today, `RPU` in the next release.
        assert_eq!(base_version_of("FALLOUT II RPU 2.4.34"), release("2.4.34"));
        assert_eq!(
            base_version_of("FALLOUT II WHATEVER 2.4.34"),
            release("2.4.34")
        );
        // But something that is not a bare word is not a marker.
        assert_eq!(base_version_of("FALLOUT 1.02d 2.4.34"), None);
    }

    #[test]
    fn a_leading_v_is_dropped_from_the_version() {
        // Fallout et tu writes `v1.16.3771`, the same spelling as its tag.
        assert_eq!(
            base_version_of("Fallout et tu v1.16.3771"),
            release("1.16.3771")
        );
    }

    #[test]
    fn upu_is_read_before_the_marked_shape() {
        // Asked later, `1.02.34` would read as a marked version whose line is the engine's `1.02`.
        assert_eq!(base_version_of("FALLOUT II 1.02.34"), release("34"));
    }

    #[test]
    fn an_install_with_no_ddraw_ini_has_no_base_version() {
        let platform = MemoryPlatform::default();
        assert_eq!(
            installed_base_version(&platform, Path::new("/games/f2")).expect("read"),
            None
        );
    }

    #[test]
    fn the_version_string_is_read_out_of_the_installs_own_file() {
        let platform = MemoryPlatform::new(MemoryOptions {
            files: BTreeMap::from([(
                "/games/f2/ddraw.ini".to_owned(),
                Content::from("[Misc]\nVersionString=FALLOUT II 1.02d  RP 2.4.34\n"),
            )]),
            ..MemoryOptions::default()
        });
        assert_eq!(
            installed_base_version(&platform, Path::new("/games/f2")).expect("read"),
            release("2.4.34")
        );
    }

    #[test]
    fn a_ddraw_ini_with_no_version_string_answers_none() {
        let platform = MemoryPlatform::new(MemoryOptions {
            files: BTreeMap::from([(
                "/games/f2/ddraw.ini".to_owned(),
                Content::from("[Misc]\nOther=1\n"),
            )]),
            ..MemoryOptions::default()
        });
        assert_eq!(
            installed_base_version(&platform, Path::new("/games/f2")).expect("read"),
            None
        );
    }
}

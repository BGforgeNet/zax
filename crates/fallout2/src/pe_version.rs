//! The version a Windows library records in its own resources.
//!
//! Both components ZAX reports on - sfall and the High Resolution Patch - ship as a DLL whose
//! version appears nowhere in its filename, so the image itself is the only thing that knows which
//! one an install has.

use std::path::Path;

use zax_core::install::Install;
use zax_platform::fs::FileKind;
use zax_platform::{Platform, Result};

/// The version resource holds free text, formatted by whoever built the library: sfall writes "4.5",
/// the hi-res patch writes "4, 1, 8, 0". Separators become dots and a trailing zero build field is
/// dropped, so both read as the version their project publishes and compare against the versions
/// their feeds name.
fn normalize(version: &str) -> String {
    let mut parts: Vec<String> = version
        .trim()
        .split([',', '.'])
        .map(|part| part.trim().to_owned())
        .collect();
    while parts.len() > 2
        && parts
            .last()
            .is_some_and(|last| !last.is_empty() && last.bytes().all(|b| b == b'0'))
    {
        parts.pop();
    }
    parts.join(".")
}

/// The version recorded in a library's own resources, or `None` when the file is not a PE image with
/// one. The caller reports "unknown" rather than guessing.
#[must_use]
pub fn read_file_version(image: &[u8]) -> Option<String> {
    let file = pelite::PeFile::from_bytes(image).ok()?;
    let info = file.resources().ok()?.version_info().ok()?.file_info();
    // Every language is tried rather than one: which the resource declares is the builder's choice,
    // and a library that records only a language ZAX did not think of would read as having none.
    info.strings
        .values()
        .find_map(|strings| strings.get("FileVersion"))
        .map(|version| normalize(version))
        .filter(|version| !version.is_empty())
}

/// The version of one of the install's libraries, or `None` when the install does not have it.
///
/// # Errors
///
/// Fails when the file is there but cannot be read.
pub fn installed_library_version(
    platform: &dyn Platform,
    install: &Install,
    library: &str,
) -> Result<Option<String>> {
    let at = Path::new(&install.path).join(library);
    if platform.fs().stat(&at)?.map(|s| s.kind) != Some(FileKind::File) {
        return Ok(None);
    }
    Ok(read_file_version(&platform.fs().read(&at)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use zax_core::install::GameType;
    use zax_platform::memory::{Content, MemoryOptions, MemoryPlatform};

    #[test]
    fn separators_become_dots() {
        // sfall writes "4.5", the hi-res patch writes "4, 1, 8, 0".
        assert_eq!(normalize("4.5"), "4.5");
        assert_eq!(normalize("4, 1, 8, 0"), "4.1.8");
        assert_eq!(normalize(" 4 , 1 "), "4.1");
    }

    #[test]
    fn only_trailing_zero_fields_past_the_second_are_dropped() {
        // "4.1.8.0" is the hi-res patch's 4.1.8; "1.0" must stay two fields.
        assert_eq!(normalize("4.1.8.0"), "4.1.8");
        assert_eq!(normalize("4.1.0.0"), "4.1");
        assert_eq!(normalize("1.0"), "1.0");
        assert_eq!(normalize("0.0"), "0.0");
    }

    #[test]
    fn a_zero_in_the_middle_is_kept() {
        assert_eq!(normalize("4.0.1"), "4.0.1");
    }

    #[test]
    fn something_that_is_not_a_pe_image_has_no_version() {
        assert_eq!(read_file_version(b"not a library at all"), None);
        assert_eq!(read_file_version(&[]), None);
    }

    #[test]
    fn a_library_the_install_does_not_have_answers_none() {
        let platform = MemoryPlatform::default();
        let install = Install::new("/games/f2", GameType::Fallout2);
        assert_eq!(
            installed_library_version(&platform, &install, "ddraw.dll").expect("read"),
            None
        );
    }

    #[test]
    fn a_file_that_is_there_but_is_not_a_library_answers_none() {
        let platform = MemoryPlatform::new(MemoryOptions {
            files: BTreeMap::from([(
                "/games/f2/ddraw.dll".to_owned(),
                Content::from("not a library"),
            )]),
            ..MemoryOptions::default()
        });
        let install = Install::new("/games/f2", GameType::Fallout2);
        assert_eq!(
            installed_library_version(&platform, &install, "ddraw.dll").expect("read"),
            None
        );
    }
}

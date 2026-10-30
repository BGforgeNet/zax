//! Where the install a base mod creates actually is, and why a release is never laid over one.
//!
//! An installation that already reports what the mod creates IS that install: a Fallout et tu folder
//! added to the list is the same game as the `Fallout1in2/` folder inside its host, seen from the
//! other side. Reading it as a host with no install in it is what would offer to build a second copy
//! of the game inside the first.
//!
//! A leaf on purpose: the feed decides what a row says and the install decides what it writes, and
//! the two have to agree about which directory the mod is in and about what the answer is when one is
//! there already.

use std::path::{Path, PathBuf};

use zax_core::install::GameType;

use crate::manifest::ModManifest;

/// Whether this mod's install is the installation itself rather than a folder of it.
///
/// Keyed on the type the directory reports, which is how a hand-installed one answers too - and most
/// are, since upstream's own route is a zip the user unpacks.
///
/// `creates` is read for presence alone, so a caller holding the directory name answers as well as a
/// manifest.
#[must_use]
pub fn creates_in_place(installed: GameType, becomes: Option<GameType>, creates: bool) -> bool {
    creates && becomes == Some(installed)
}

/// The install this mod's release belongs to, inside the installation it is offered on.
#[must_use]
pub fn created_install_path(
    install_path: &Path,
    installed: GameType,
    becomes: Option<GameType>,
    directory: &str,
) -> PathBuf {
    if creates_in_place(installed, becomes, true) {
        install_path.to_path_buf()
    } else {
        install_path.join(directory)
    }
}

/// Why an install this mod made takes no release over it.
///
/// One sentence, here rather than at either site: the row that declines to offer the release and the
/// install that refuses to perform it are the same refusal, and two wordings would let a user read one
/// and then be told the other. Its subject is what differs - a folder inside this installation, or
/// this installation itself - and naming the wrong one sends the user looking for a folder they do
/// not have.
#[must_use]
pub fn no_upgrade_here(manifest: &ModManifest, installed: GameType) -> String {
    let what = if creates_in_place(installed, manifest.becomes, manifest.creates.is_some()) {
        format!("This installation is {}", manifest.name)
    } else {
        format!(
            "{} holds {}",
            manifest
                .creates
                .as_ref()
                .map_or("", |creates| creates.directory.as_str()),
            manifest.name
        )
    };
    format!(
        "{what} already, and it publishes no way to update one - only an unpack into a folder that \
         has none. {} would have to go into a fresh folder.",
        manifest.version
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::{ManifestDefaults, parse_manifest};

    fn fo1in2() -> ModManifest {
        let text = "spec: 1\ngame: fallout2\nid: fo1in2\nname: Fallout et tu\nversion: 1.16\n\
                    type: base\nbecomes: fo1in2\ncreates.directory: Fallout1in2\n";
        parse_manifest(text.as_bytes(), &ManifestDefaults::default()).expect("a vendored shape")
    }

    #[test]
    fn a_host_holds_the_created_install_in_a_folder() {
        assert!(!creates_in_place(
            GameType::Fallout2,
            Some(GameType::Fo1In2),
            true
        ));
        assert_eq!(
            created_install_path(
                Path::new("/games/f2"),
                GameType::Fallout2,
                Some(GameType::Fo1In2),
                "Fallout1in2"
            ),
            PathBuf::from("/games/f2/Fallout1in2")
        );
    }

    #[test]
    fn an_installation_already_reporting_that_type_is_the_install() {
        // Reading it as a host with no install in it would offer to build a second copy inside it.
        assert!(creates_in_place(
            GameType::Fo1In2,
            Some(GameType::Fo1In2),
            true
        ));
        assert_eq!(
            created_install_path(
                Path::new("/games/f2/Fallout1in2"),
                GameType::Fo1In2,
                Some(GameType::Fo1In2),
                "Fallout1in2"
            ),
            PathBuf::from("/games/f2/Fallout1in2"),
            "the path must not gain a second copy of the directory"
        );
    }

    #[test]
    fn a_mod_that_creates_nothing_is_never_in_place() {
        assert!(!creates_in_place(
            GameType::Fo1In2,
            Some(GameType::Fo1In2),
            false
        ));
    }

    #[test]
    fn the_refusal_names_the_folder_when_the_install_is_one() {
        let said = no_upgrade_here(&fo1in2(), GameType::Fallout2);
        assert!(
            said.starts_with("Fallout1in2 holds Fallout et tu"),
            "{said}"
        );
        assert!(said.contains("1.16"), "{said}");
    }

    #[test]
    fn the_refusal_names_the_installation_when_it_is_the_install() {
        // Naming the wrong one sends the user looking for a folder they do not have.
        let said = no_upgrade_here(&fo1in2(), GameType::Fo1In2);
        assert!(
            said.starts_with("This installation is Fallout et tu"),
            "{said}"
        );
    }
}

//! The manifests ZAX carries for mods that publish none.
//!
//! Every base mod the design names describes itself nowhere: no release of RPU, UPU or Fallout et tu
//! ships an `f2mod.yml`, by either route, so without this the mods tab has nothing to offer on any
//! install. A vendored manifest is the same document upstream would commit, held here and parsed by
//! the ordinary reader with no separate route behind it - the same argument as the grants in
//! `mod_grants`, the load order in `recommended_order` and the DAT library this links: a judgement
//! ZAX makes on the user's behalf, reviewable in the source, changing only with a ZAX release. Keyed
//! by id alone, as the grants are.
//!
//! Anything the author publishes wins over the copy here, by either route, so adopting the format
//! costs them no coordination: it takes effect on their next release and the entry below is then
//! deleted. A tag ZAX has already found nothing at is not asked again, so the switch is a new release
//! rather than a new commit.
//!
//! The ids are minted here from upstream's own naming, which is what an author adopting the format
//! would most likely pick anyway - with the release line appended where a repository publishes two,
//! since one id per line is what makes them two mods rather than one with a branch. If one picks
//! differently, their feed row stops matching and the mod reads as unfollowed until a ZAX release
//! corrects the row.
//!
//! No document names an installer asset. Both BGforge assets carry the version in their names, and
//! the release is what knows it: the Windows route resolves to the release's sole `.exe` and the
//! other to its sole archive. That also survives an upstream rename, where a name spelled here would
//! go on missing until ZAX shipped again.
//!
//! None of them describes what its installer offers, and that is the point: a copy of upstream's
//! component tree kept here would be a second home for a table the installer's own source already
//! owns, going stale against the next release with nothing to notice.

/// One carried document.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VendoredManifest {
    /// The id the document declares, which is what its feed row follows.
    pub id: &'static str,
    /// The document, which states no version and names no asset - the release supplies both.
    pub text: &'static str,
}

/// `mods/upu.ini` as UPU v34 ships it, which both RPU lines ship unchanged inside their own releases: one
/// description for the three documents that install the file. Each entry names its file, since an RPU
/// document's own default would be `mods/rpu23.ini`. UPU's next release adds `caverns_reduce_mobs`, which
/// joins here with it. `fixtures/upu/` holds the shipped file the tests hold this to.
macro_rules! upu_settings {
    () => {
        "  main.goris_derobing_speed:
    file: mods/upu.ini
    kind: int
    min: 16
    max: 100
    unit: fps
    sentinels: { 0: \"Off\" }
    default: 50
    label: Goris de-robing speed
    help: How fast Goris takes off his robe. The original game plays it at 16. No effect if the alternative low FPS Goris de-robing is installed.
  main.critters_walk_faster:
    file: mods/upu.ini
    kind: bool
    default: 1
    label: Faster walking for slow critters
    help: Robots, various guards and a few other critters walk much slower than everyone else; this speeds them up a little. Cosmetic only. No effect if the alternative low FPS walk speed fix is installed.
  main.wipe_inventory:
    file: mods/upu.ini
    kind: bool
    default: 0
    label: Fresh merchant stock on each restock
    help: Off, merchants keep every item you ever sold them, on top of their restocks. On, each restock gives them fresh inventory. Quest items are always kept. Can be changed mid-game.
  ncr.repeatable_brahmin_drive:
    file: mods/upu.ini
    kind: bool
    default: 1
    label: Repeatable NCR brahmin drive
    help: The NCR to Redding brahmin drive can be done again, as Duppo says. The drives end if Hal dies.
"
    };
}

/// `mods/rpu.ini`, the same file in both release lines (2.3.34 and 2.4.34). `fixtures/rpu/` holds it.
macro_rules! rpu_settings {
    () => {
        "  main.marcus_armor:
    file: mods/rpu.ini
    kind: bool
    default: 1
    label: Mutant armor for Marcus
  main.dogmeat_armor:
    file: mods/rpu.ini
    kind: bool
    default: 1
    label: Kevlar armor for Dogmeat
  main.smoking:
    file: mods/rpu.ini
    kind: bool
    default: 1
    label: Smoking animation
    help: The player character's smoking animation.
  main.lenny_new_look:
    file: mods/rpu.ini
    kind: bool
    default: 1
    label: New look for Lenny
    help: Gives Lenny a different ghoul sprite.
  main.vault_boxer:
    file: mods/rpu.ini
    kind: bool
    default: 1
    label: Vault boxer in the ring
    help: Use the unique vault boxer model when fighting in the ring.
"
    };
}

const RPU23: &str = concat!(
    "spec: 1
id: rpu23
name: Restoration Project Updated 2.3
game: fallout2
type: base
becomes: fallout2rpu
installer.windows.built-with: inno
installer.other.run: rpu-install.sh
settings:
",
    rpu_settings!(),
    upu_settings!()
);

const RPU24: &str = concat!(
    "spec: 1
id: rpu24
name: Restoration Project Updated 2.4
game: fallout2
type: base
becomes: fallout2rpu
installer.windows.built-with: inno
installer.other.run: rpu-install.sh
settings:
",
    rpu_settings!(),
    upu_settings!()
);

const UPU: &str = concat!(
    "spec: 1
id: upu
name: Unofficial Patch Updated
game: fallout2
type: base
becomes: fallout2upu
installer.windows.built-with: inno
installer.other.run: upu-install.sh
settings:
",
    upu_settings!()
);

/// Fallout et tu, whose asset name carries no version: one top-level `Fallout1in2/` in the payload,
/// `undat_files.txt` inside it, and Fallout 1's `master.dat` the file the folder it asks for must
/// hold.
const FO1IN2: &str = "spec: 1
id: fo1in2
name: Fallout et tu
game: fallout2
type: base
becomes: fo1in2
archive: Fallout1in2.zip
creates.directory: Fallout1in2
inputs:
  - id: fallout1
    label: Your Fallout 1 folder
    help: The folder holding Fallout 1's MASTER.DAT. Fallout et tu unpacks the game's art and sound from it.
    holds: master.dat
extract-dat.from: fallout1
extract-dat.list: undat_files.txt
extract-dat.into: data
";

/// One document per release line, differing in nothing but which mod it says it is: the two ship in
/// lockstep from one repository and one installer, and only the tag they are built from tells them
/// apart.
pub const VENDORED_MANIFESTS: &[VendoredManifest] = &[
    VendoredManifest {
        id: "rpu23",
        text: RPU23,
    },
    VendoredManifest {
        id: "rpu24",
        text: RPU24,
    },
    VendoredManifest {
        id: "upu",
        text: UPU,
    },
    VendoredManifest {
        id: "fo1in2",
        text: FO1IN2,
    },
];

/// The document ZAX carries for this mod id, or nothing where it carries none.
#[must_use]
pub fn vendored_manifest_for(id: &str) -> Option<&'static str> {
    VENDORED_MANIFESTS
        .iter()
        .find(|entry| entry.id == id)
        .map(|entry| entry.text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::{ManifestDefaults, ModType, parse_manifest};
    use std::collections::BTreeSet;
    use zax_core::install::GameType;

    /// The release supplies the version, so a vendored document is parsed with one standing in.
    fn defaults() -> ManifestDefaults {
        ManifestDefaults {
            version: Some("1.0".to_owned()),
            archive: None,
        }
    }

    #[test]
    fn every_carried_document_is_read_by_the_ordinary_reader() {
        // No separate route behind it: a document that only this module could read would be a second
        // manifest format.
        for entry in VENDORED_MANIFESTS {
            let manifest = parse_manifest(entry.text.as_bytes(), &defaults())
                .unwrap_or_else(|err| panic!("{} does not parse: {err}", entry.id));
            assert_eq!(
                manifest.id, entry.id,
                "the document must declare its own id"
            );
            assert_eq!(manifest.mod_type, ModType::Base);
            assert!(manifest.becomes.is_some(), "{} becomes nothing", entry.id);
        }
    }

    #[test]
    fn every_carried_document_belongs_to_a_followed_base_mod() {
        // The copy is looked up by the feed row's id, so one under an id no row follows is never read.
        // Not the reverse: a row outlives its copy once upstream publishes a manifest of its own.
        for entry in VENDORED_MANIFESTS {
            let row = crate::mod_feed::MOD_FEEDS
                .iter()
                .find(|feed| feed.id == entry.id)
                .unwrap_or_else(|| panic!("no feed row follows {}", entry.id));
            assert!(
                row.base,
                "{} is carried as a base mod on a stacking row",
                entry.id
            );
        }
    }

    #[test]
    fn no_id_is_carried_twice() {
        let mut seen = BTreeSet::new();
        for entry in VENDORED_MANIFESTS {
            assert!(seen.insert(entry.id), "{} is carried twice", entry.id);
        }
    }

    #[test]
    fn no_document_names_an_installer_asset() {
        // The release is what knows the version in the asset's name, and a name spelled here would go
        // on missing after an upstream rename until ZAX shipped again.
        for entry in VENDORED_MANIFESTS {
            let manifest = parse_manifest(entry.text.as_bytes(), &defaults()).expect("parses");
            if let Some(installer) = &manifest.installer {
                assert_eq!(
                    installer.windows.as_ref().and_then(|w| w.asset.as_ref()),
                    None,
                    "{} names a Windows asset",
                    entry.id
                );
                assert_eq!(
                    installer.other.as_ref().and_then(|o| o.asset.as_ref()),
                    None,
                    "{} names an asset for the other route",
                    entry.id
                );
            }
        }
    }

    #[test]
    fn the_two_release_lines_differ_only_in_which_mod_they_say_they_are() {
        let rpu23 = parse_manifest(RPU23.as_bytes(), &defaults()).expect("parses");
        let rpu24 = parse_manifest(RPU24.as_bytes(), &defaults()).expect("parses");
        assert_ne!(rpu23.id, rpu24.id);
        assert_ne!(rpu23.name, rpu24.name);
        assert_eq!(rpu23.becomes, rpu24.becomes);
        assert_eq!(
            rpu23
                .installer
                .as_ref()
                .and_then(|i| i.other.as_ref())
                .map(|o| o.run.as_str()),
            rpu24
                .installer
                .as_ref()
                .and_then(|i| i.other.as_ref())
                .map(|o| o.run.as_str())
        );
    }

    #[test]
    fn fallout_et_tu_asks_for_the_folder_it_unpacks_from() {
        let manifest = parse_manifest(FO1IN2.as_bytes(), &defaults()).expect("parses");
        assert_eq!(manifest.becomes, Some(GameType::Fo1In2));
        assert_eq!(
            manifest.creates.as_ref().map(|c| c.directory.as_str()),
            Some("Fallout1in2")
        );
        let inputs = manifest.inputs.as_ref().expect("it asks for a folder");
        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs[0].holds, "master.dat");
        let extract = manifest.extract_dat.as_ref().expect("it unpacks a DAT");
        assert_eq!(extract.from, inputs[0].id);
    }

    /// What each base mod's release ships under `mods/`, verbatim.
    fn shipped(file: &str) -> Option<Vec<u8>> {
        let at = match file {
            "mods/upu.ini" => "../../fixtures/upu/mods/upu.ini",
            "mods/rpu.ini" => "../../fixtures/rpu/mods/rpu.ini",
            _ => return None,
        };
        std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(at)).ok()
    }

    #[test]
    fn every_described_setting_matches_the_ini_its_release_ships() {
        // Nothing at install compares the two, so a key described here and missing from the release would
        // be a control writing a line the mod never reads. Hard: every key the files carry is described.
        for entry in VENDORED_MANIFESTS {
            let manifest = parse_manifest(entry.text.as_bytes(), &defaults()).expect("parses");
            if manifest.settings.is_empty() {
                continue;
            }
            let report =
                crate::mod_ini::check_mod_ini(&manifest, &shipped, crate::mod_ini::IniMatch::Hard);
            assert!(
                report.mismatches.is_empty() && report.undescribed == 0,
                "{}: {report:?}",
                entry.id
            );
        }
    }

    #[test]
    fn rpu_describes_both_files_it_ships_and_upu_its_own() {
        let files = |text: &str| {
            let manifest = parse_manifest(text.as_bytes(), &defaults()).expect("parses");
            manifest
                .settings
                .iter()
                .map(|setting| setting.def.targets.own().file.clone())
                .collect::<BTreeSet<_>>()
        };
        let both: BTreeSet<String> = ["mods/rpu.ini", "mods/upu.ini"].map(str::to_owned).into();
        assert_eq!(files(RPU23), both);
        assert_eq!(files(RPU24), both);
        assert_eq!(files(UPU), ["mods/upu.ini".to_owned()].into());
    }

    #[test]
    fn an_id_nothing_is_carried_for_answers_nothing() {
        assert_eq!(vendored_manifest_for("ecco"), None);
        assert_eq!(vendored_manifest_for("upu"), Some(UPU));
    }
}

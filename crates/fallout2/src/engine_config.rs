//! Where an alternative engine keeps the settings ZAX writes, and whether it has written any of them
//! yet.
//!
//! Two things here are not simply a file's name. fallout2-ce's content config lives under the directory
//! the game's own `[system] master_patches` names, so its path is not known until that file has been
//! read. And an engine writes its configuration the first time it runs, so before that its keys are
//! ZAX's to leave alone: fallout2-ce's imports from `ddraw.ini` and `f2_res.ini` are one-shot and skip
//! on finding exactly the file or section an early write would create, so writing first would silently
//! suppress them.

use std::collections::BTreeSet;

use zax_core::catalog::{SettingDef, SettingTarget};
use zax_core::config_io::{ConfigFileContents, ConfigFilePaths};
use zax_core::ini::IniDocument;
use zax_core::text::latin1;
use zax_platform::fs::FileKind;
use zax_platform::{Platform, Result};

use crate::engines::{ENGINES, EngineDefinition};

/// The name settings address fallout2-ce's content config by. Its path is per install.
pub const CONTENT_CONFIG: &str = "game#patch.cfg";

/// Where fallout2-ce writes its content config, or nothing where it writes none. It composes the path
/// itself as `<master_patches>\config\game#patch.cfg` and abandons the whole import when
/// `master_patches` is empty, so a file written anywhere else is one the engine never reads.
#[must_use]
pub fn content_config_path(master_patches: Option<&str>) -> Option<String> {
    // The game's config spells its paths the way DOS did; the seam joins with forward slashes.
    let directory = master_patches
        .unwrap_or("")
        .trim()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_owned();
    if directory.is_empty() {
        return None;
    }
    Some(format!("{directory}/config/{CONTENT_CONFIG}"))
}

/// The engines' own config files reachable in this install, each mapped to where it sits. The content
/// config is left out where `master_patches` names no directory that exists: fallout2-ce refuses to
/// import into one, and creating it here would conjure a game directory the game itself treats as
/// absent.
///
/// The game's own three files are not here. Their name is their path, which is what `load_config_files`
/// assumes for any name this does not mention.
pub fn engine_config_paths(
    platform: &dyn Platform,
    install_path: &str,
    game_config: Option<&[u8]>,
) -> Result<ConfigFilePaths> {
    let mut out = ConfigFilePaths::from([("fission.cfg".to_owned(), "fission.cfg".to_owned())]);
    let Some(game_config) = game_config else {
        return Ok(out);
    };
    let document = IniDocument::parse(game_config);
    let master_patches = document.get("system", "master_patches").map(latin1);
    let Some(path) = content_config_path(master_patches.as_deref()) else {
        return Ok(out);
    };
    let directory = &path[..path.len() - format!("/config/{CONTENT_CONFIG}").len()];
    let there = platform
        .fs()
        .stat(&std::path::Path::new(install_path).join(directory))?;
    if there.is_some_and(|stat| stat.kind == FileKind::Dir) {
        out.insert(CONTENT_CONFIG.to_owned(), path);
    }
    Ok(out)
}

/// Whether an engine has written its own settings yet. The test is the engine's settings being present
/// rather than a file existing, because fallout2-ce keeps its own in the game's config file, which
/// every install already has - so its mark is a section vanilla does not carry.
#[must_use]
pub fn has_minted_settings(engine: &EngineDefinition, contents: &ConfigFileContents) -> bool {
    let Some(Some(held)) = contents.get(engine.settings_mark.file) else {
        return false;
    };
    let Some(section) = engine.settings_mark.section else {
        return true;
    };
    IniDocument::parse(held)
        .sections()
        .iter()
        .any(|one| one.to_lowercase() == section.to_lowercase())
}

/// The addresses one edit actually writes: every target of the setting whose engine has written its own
/// settings, plus every target that belongs to no engine at all.
///
/// A dormant engine's target is left alone rather than created. Writing it early would put the file or
/// section that engine's own one-shot import checks for into the install, and the import would then
/// never run - the user would lose the settings it was meant to carry across, silently. The target is
/// picked up the next time the install is read, once the engine has run for itself.
#[must_use]
pub fn live_targets<'a>(
    def: &'a SettingDef,
    contents: &ConfigFileContents,
) -> Vec<&'a SettingTarget> {
    live_targets_among(def, &minted_engines(contents))
}

/// The engines that have written their own settings into these files, by id. What a caller asking
/// about many settings at once works out a single time: each answer parses the engine's config file.
#[must_use]
pub fn minted_engines(contents: &ConfigFileContents) -> BTreeSet<&'static str> {
    ENGINES
        .iter()
        .filter(|engine| has_minted_settings(engine, contents))
        .map(|engine| engine.id)
        .collect()
}

/// [`live_targets`], given which engines have written their settings.
#[must_use]
pub fn live_targets_among<'a>(
    def: &'a SettingDef,
    minted: &BTreeSet<&'static str>,
) -> Vec<&'a SettingTarget> {
    def.targets
        .iter()
        .filter(|target| {
            target
                .engine
                .as_deref()
                .is_none_or(|id| minted.contains(id))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engines::engine_by_id;
    use std::path::Path;
    use zax_platform::memory::{MemoryOptions, MemoryPlatform};

    /// An install whose game folder holds the directories named, and nothing else.
    fn platform_with(dirs: &[&str]) -> MemoryPlatform {
        MemoryPlatform::new(MemoryOptions {
            dirs: dirs.iter().map(|one| (*one).to_owned()).collect(),
            ..MemoryOptions::default()
        })
    }

    fn contents(pairs: &[(&str, Option<&str>)]) -> ConfigFileContents {
        pairs
            .iter()
            .map(|(name, held)| {
                (
                    (*name).to_owned(),
                    held.map(|text| text.as_bytes().to_vec()),
                )
            })
            .collect()
    }

    #[test]
    fn the_content_config_sits_under_the_directory_the_game_names() {
        assert_eq!(
            content_config_path(Some("data")).as_deref(),
            Some("data/config/game#patch.cfg")
        );
        // The game's config spells its paths the way DOS did.
        assert_eq!(
            content_config_path(Some("mods\\rpu\\")).as_deref(),
            Some("mods/rpu/config/game#patch.cfg")
        );
    }

    #[test]
    fn an_empty_master_patches_names_no_content_config() {
        // fallout2-ce abandons the whole import, so a file written anywhere else is never read.
        assert_eq!(content_config_path(None), None);
        assert_eq!(content_config_path(Some("   ")), None);
    }

    #[test]
    fn the_content_config_is_offered_only_where_its_directory_is_there() {
        let platform = platform_with(&["/game/data"]);
        let config = b"[system]\nmaster_patches=data\n";
        let paths = engine_config_paths(&platform, "/game", Some(config)).expect("a read");
        assert_eq!(
            paths.get(CONTENT_CONFIG).map(String::as_str),
            Some("data/config/game#patch.cfg")
        );
        assert!(paths.contains_key("fission.cfg"));
    }

    #[test]
    fn a_directory_the_game_treats_as_absent_is_not_conjured() {
        let platform = platform_with(&["/game"]);
        let config = b"[system]\nmaster_patches=data\n";
        let paths = engine_config_paths(&platform, "/game", Some(config)).expect("a read");
        assert_eq!(paths.get(CONTENT_CONFIG), None);
        assert_eq!(
            platform.fs().stat(Path::new("/game/data")).expect("a read"),
            None,
            "the directory the game treats as absent must stay absent"
        );
    }

    #[test]
    fn an_install_with_no_game_config_still_offers_fissions_own_file() {
        let platform = platform_with(&["/game"]);
        let paths = engine_config_paths(&platform, "/game", None).expect("a read");
        assert_eq!(paths.len(), 1);
        assert!(paths.contains_key("fission.cfg"));
    }

    #[test]
    fn an_engine_with_its_own_file_is_answered_by_the_file() {
        let fission = engine_by_id("fission").expect("a named engine");
        assert!(has_minted_settings(
            fission,
            &contents(&[("fission.cfg", Some(""))])
        ));
        assert!(!has_minted_settings(fission, &contents(&[])));
        // A file the install does not hold reads as absent, not as empty settings.
        assert!(!has_minted_settings(
            fission,
            &contents(&[("fission.cfg", None)])
        ));
    }

    #[test]
    fn fallout2_ces_mark_is_a_section_vanilla_does_not_carry() {
        // Its keys live in the game's own config file, which every install already has.
        let ce = engine_by_id("fallout2-ce").expect("a named engine");
        let vanilla = "[system]\nmaster_patches=data\n[sound]\nmusic_path1=data/sound/music/\n";
        assert!(!has_minted_settings(
            ce,
            &contents(&[("fallout2.cfg", Some(vanilla))])
        ));
        assert!(has_minted_settings(
            ce,
            &contents(&[("fallout2.cfg", Some("[UI]\nmessage_box=1\n"))])
        ));
    }

    #[test]
    fn a_dormant_engines_target_is_left_alone() {
        // Writing it would satisfy the engine's own one-shot import check and lose the settings it
        // was meant to carry across.
        let def: SettingDef = serde_json::from_str(
            r#"{"id":"x","label":"X","targets":[
                 {"file":"ddraw.ini","section":"Misc","key":"Foo"},
                 {"file":"fission.cfg","section":"Misc","key":"Foo","engine":"fission"}
               ],"kind":{"type":"bool","onValue":"1","offValue":"0"}}"#,
        )
        .expect("a setting the test writes");
        let dormant = live_targets(&def, &contents(&[]));
        assert_eq!(dormant.len(), 1);
        assert_eq!(dormant[0].file, "ddraw.ini");
        let awake = live_targets(&def, &contents(&[("fission.cfg", Some(""))]));
        assert_eq!(awake.len(), 2);
    }

    #[test]
    fn a_target_naming_an_engine_zax_does_not_know_is_never_written() {
        let def: SettingDef = serde_json::from_str(
            r#"{"id":"x","label":"X","targets":[
                 {"file":"olympus.cfg","section":"Misc","key":"Foo","engine":"olympus"}
               ],"kind":{"type":"bool","onValue":"1","offValue":"0"}}"#,
        )
        .expect("a setting the test writes");
        assert!(live_targets(&def, &contents(&[("olympus.cfg", Some(""))])).is_empty());
    }
}

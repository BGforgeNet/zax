//! Reading and writing a game's config files.
//!
//! What makes this more than a write: the files are the user's and are routinely hand-edited, so a
//! file that changed underneath the open window is reported rather than overwritten.
//!
//! No copy is taken aside: a save rewrites one line per changed key, and doing it on every change
//! filled the backup directory with copies nothing ever pointed at. Backups belong to the paths that
//! replace whole files - installing and removing mods, engines and sfall.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use zax_platform::fs::FileKind;
use zax_platform::{Platform, Result};

use crate::ini::IniDocument;

/// One key to write. The catalog maps a setting id to this; core does not know what a setting is.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
pub struct ConfigChange {
    pub file: String,
    pub section: String,
    pub key: String,
    pub value: String,
}

/// Contents by file name, as raw bytes, or `None` where the file is not there.
///
/// Bytes rather than decoded text: these files round-trip byte for byte, and the comparison that
/// decides whether one changed underneath the window has to be over what is actually on disk.
pub type ConfigFileContents = BTreeMap<String, Option<Vec<u8>>>;

/// Where a file sits inside an install, for the few whose location is not their own name.
///
/// One of them is kept in a directory another file's settings name, so it cannot be addressed by its
/// path. A name this does not mention is its own path.
pub type ConfigFilePaths = BTreeMap<String, String>;

fn path_of(install: &Path, paths: &ConfigFilePaths, name: &str) -> PathBuf {
    let relative = paths.get(name).map_or(name, String::as_str);
    let mut at = install.to_path_buf();
    for part in relative.split('/').filter(|part| !part.is_empty()) {
        at.push(part);
    }
    at
}

fn read_if_file(platform: &dyn Platform, at: &Path) -> Result<Option<Vec<u8>>> {
    if platform.fs().stat(at)?.map(|s| s.kind) == Some(FileKind::File) {
        Ok(Some(platform.fs().read(at)?))
    } else {
        Ok(None)
    }
}

/// Reads the named files from an install. A file that is not there reads as `None` rather than
/// empty.
///
/// # Errors
///
/// Fails when a file that is there cannot be read.
pub fn load_config_files(
    platform: &dyn Platform,
    install_path: &Path,
    names: &[String],
    paths: &ConfigFilePaths,
) -> Result<ConfigFileContents> {
    let mut out = ConfigFileContents::new();
    for name in names {
        let at = path_of(install_path, paths, name);
        out.insert(name.clone(), read_if_file(platform, &at)?);
    }
    Ok(out)
}

/// Crosses the boundary as `{"written": [...]}` or `{"stale": [...]}`: which of the two happened is
/// the whole answer, and a shape that says so in the tag cannot be read as the other by mistake.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub enum SaveOutcome {
    Written(Vec<String>),
    /// Files that changed on disk since they were read. Nothing is written: applying half a save and
    /// reporting the other half would leave the user with settings from two different intentions and
    /// no way to tell which.
    Stale(Vec<String>),
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct SaveRequest {
    pub install_path: PathBuf,
    /// The contents the edits were made against, as [`load_config_files`] answered.
    pub original: ConfigFileContents,
    pub changes: Vec<ConfigChange>,
    /// The same map [`load_config_files`] was given, so a save writes where the read read.
    #[serde(default)]
    pub paths: ConfigFilePaths,
}

/// Writes the changed keys back, one line each, leaving every other line of the file exactly as it
/// was.
///
/// # Errors
///
/// Fails when a file cannot be read or written.
pub fn save_config_files(platform: &dyn Platform, request: &SaveRequest) -> Result<SaveOutcome> {
    let mut files: Vec<String> = request
        .changes
        .iter()
        .map(|change| change.file.clone())
        .collect();
    files.sort();
    files.dedup();
    if files.is_empty() {
        return Ok(SaveOutcome::Written(Vec::new()));
    }

    let mut current: BTreeMap<String, Option<Vec<u8>>> = BTreeMap::new();
    let mut stale = Vec::new();
    for file in &files {
        let at = path_of(&request.install_path, &request.paths, file);
        let found = read_if_file(platform, &at)?;
        // A name the caller never loaded reads as absent on both sides, which is what it was.
        let before = request.original.get(file).cloned().unwrap_or(None);
        if found != before {
            stale.push(file.clone());
        }
        current.insert(file.clone(), found);
    }
    if !stale.is_empty() {
        return Ok(SaveOutcome::Stale(stale));
    }

    for file in &files {
        let held = current
            .get(file)
            .cloned()
            .unwrap_or(None)
            .unwrap_or_default();
        let mut document = IniDocument::parse(&held);
        for change in &request.changes {
            if &change.file == file {
                document.set_str(&change.section, &change.key, &change.value);
            }
        }
        let at = path_of(&request.install_path, &request.paths, file);
        platform.fs().write(&at, &document.to_bytes())?;
    }

    Ok(SaveOutcome::Written(files))
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

    fn names(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| (*v).to_owned()).collect()
    }

    fn change(file: &str, section: &str, key: &str, value: &str) -> ConfigChange {
        ConfigChange {
            file: file.to_owned(),
            section: section.to_owned(),
            key: key.to_owned(),
            value: value.to_owned(),
        }
    }

    fn request(platform: &MemoryPlatform, changes: Vec<ConfigChange>) -> SaveRequest {
        let install = Path::new("/game");
        let loaded = load_config_files(
            platform,
            install,
            &names(&["fallout2.cfg", "ddraw.ini"]),
            &ConfigFilePaths::new(),
        )
        .expect("load");
        SaveRequest {
            install_path: install.to_path_buf(),
            original: loaded,
            changes,
            paths: ConfigFilePaths::new(),
        }
    }

    #[test]
    fn a_file_that_is_not_there_reads_as_absent() {
        let platform = platform_with(&[("/game/fallout2.cfg", "[sound]\nmaster_volume=32767\n")]);
        let loaded = load_config_files(
            &platform,
            Path::new("/game"),
            &names(&["fallout2.cfg", "missing.ini"]),
            &ConfigFilePaths::new(),
        )
        .expect("load");
        assert!(loaded["fallout2.cfg"].is_some());
        assert_eq!(loaded["missing.ini"], None);
    }

    #[test]
    fn a_relocated_file_is_read_from_where_the_map_says() {
        let platform = platform_with(&[("/game/mods/ddraw.ini", "[Misc]\nA=1\n")]);
        let paths = ConfigFilePaths::from([("ddraw.ini".to_owned(), "mods/ddraw.ini".to_owned())]);
        let loaded = load_config_files(
            &platform,
            Path::new("/game"),
            &names(&["ddraw.ini"]),
            &paths,
        )
        .expect("load");
        assert!(loaded["ddraw.ini"].is_some());
    }

    #[test]
    fn saving_nothing_writes_nothing() {
        let platform = platform_with(&[("/game/fallout2.cfg", "[sound]\nA=1\n")]);
        let request = request(&platform, Vec::new());
        assert_eq!(
            save_config_files(&platform, &request).expect("save"),
            SaveOutcome::Written(Vec::new())
        );
    }

    #[test]
    fn a_save_rewrites_one_line_and_leaves_the_rest_exactly_as_it_was() {
        let before = "; a note\n[sound]\nmaster_volume=32767\nmusic_volume=16384\n";
        let platform = platform_with(&[("/game/fallout2.cfg", before)]);
        let request = request(
            &platform,
            vec![change("fallout2.cfg", "sound", "music_volume", "0")],
        );

        assert_eq!(
            save_config_files(&platform, &request).expect("save"),
            SaveOutcome::Written(names(&["fallout2.cfg"]))
        );
        assert_eq!(
            platform.text_at("/game/fallout2.cfg").as_deref(),
            Some("; a note\n[sound]\nmaster_volume=32767\nmusic_volume=0\n")
        );
    }

    #[test]
    fn a_file_that_changed_underneath_the_window_is_reported_and_nothing_is_written() {
        // The files are the user's and are routinely hand-edited.
        let platform = platform_with(&[("/game/fallout2.cfg", "[sound]\nA=1\n")]);
        let request = request(&platform, vec![change("fallout2.cfg", "sound", "A", "2")]);

        platform
            .fs()
            .write(Path::new("/game/fallout2.cfg"), b"[sound]\nA=9\n")
            .expect("a hand edit");

        assert_eq!(
            save_config_files(&platform, &request).expect("save"),
            SaveOutcome::Stale(names(&["fallout2.cfg"]))
        );
        assert_eq!(
            platform.text_at("/game/fallout2.cfg").as_deref(),
            Some("[sound]\nA=9\n"),
            "the hand edit must survive"
        );
    }

    #[test]
    fn one_stale_file_stops_the_whole_save() {
        // Applying half a save would leave settings from two different intentions.
        let platform = platform_with(&[
            ("/game/fallout2.cfg", "[sound]\nA=1\n"),
            ("/game/ddraw.ini", "[Misc]\nB=1\n"),
        ]);
        let request = request(
            &platform,
            vec![
                change("fallout2.cfg", "sound", "A", "2"),
                change("ddraw.ini", "Misc", "B", "2"),
            ],
        );

        platform
            .fs()
            .write(Path::new("/game/ddraw.ini"), b"[Misc]\nB=9\n")
            .expect("a hand edit");

        assert_eq!(
            save_config_files(&platform, &request).expect("save"),
            SaveOutcome::Stale(names(&["ddraw.ini"]))
        );
        assert_eq!(
            platform.text_at("/game/fallout2.cfg").as_deref(),
            Some("[sound]\nA=1\n"),
            "the unchanged file must not have been written either"
        );
    }

    #[test]
    fn a_key_in_a_file_that_is_not_there_yet_creates_it() {
        let platform = platform_with(&[("/game/fallout2.cfg", "[sound]\nA=1\n")]);
        let request = request(&platform, vec![change("ddraw.ini", "Misc", "B", "2")]);
        assert_eq!(
            save_config_files(&platform, &request).expect("save"),
            SaveOutcome::Written(names(&["ddraw.ini"]))
        );
        assert_eq!(
            platform.text_at("/game/ddraw.ini").as_deref(),
            Some("[Misc]\nB=2\n")
        );
    }

    #[test]
    fn several_changes_to_one_file_are_written_together() {
        let platform = platform_with(&[("/game/fallout2.cfg", "[sound]\nA=1\nB=1\n")]);
        let request = request(
            &platform,
            vec![
                change("fallout2.cfg", "sound", "A", "2"),
                change("fallout2.cfg", "sound", "B", "3"),
            ],
        );
        save_config_files(&platform, &request).expect("save");
        assert_eq!(
            platform.text_at("/game/fallout2.cfg").as_deref(),
            Some("[sound]\nA=2\nB=3\n")
        );
    }
}

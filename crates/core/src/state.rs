//! Loading and saving the application's own state.
//!
//! The file format lives in [`crate::zax_file`]; this is the part that reaches the disk and resolves
//! what each stored path actually holds.

use std::path::PathBuf;

use zax_platform::{Platform, Result};

use crate::discovery::identify_install;
use crate::install::{Install, Theme};
use crate::zax_file::{StoredInstall, ZaxFile, format_zax_file, parse_zax_file};

const ZAX_FILE_NAME: &str = "zax.yml";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppState {
    /// Installs that are on the list and readable now, with the type read from the directory.
    pub installs: Vec<Install>,
    /// Installs on the list that could not be read - an unplugged drive, a folder moved since last
    /// time. Kept rather than dropped, because writing the file back without them would turn a drive
    /// being offline for one session into losing the entry permanently.
    pub unavailable: Vec<StoredInstall>,
    pub theme: Theme,
    pub autosave: bool,
    /// Engines whose caution has been dismissed - see [`ZaxFile`], which is where the shape is
    /// explained.
    pub accepted_cautions: Vec<String>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            installs: Vec::new(),
            unavailable: Vec::new(),
            theme: Theme::System,
            autosave: true,
            accepted_cautions: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadedState {
    pub state: AppState,
    /// Why the file could not be read, when it could not be. The caller shows this and does not
    /// overwrite: an unreadable file replaced by an empty one is the user's install list gone.
    pub problem: Option<String>,
}

fn zax_file_path(platform: &dyn Platform) -> PathBuf {
    platform.paths().config().join(ZAX_FILE_NAME)
}

/// Reads the state file and resolves what each stored path holds now.
///
/// # Errors
///
/// Fails when the file is there but cannot be read at all. A file that parses badly is reported
/// through [`LoadedState::problem`] instead, since that is recoverable and losing it is not.
pub fn load_state(platform: &dyn Platform) -> Result<LoadedState> {
    let path = zax_file_path(platform);
    if platform.fs().stat(&path)?.is_none() {
        return Ok(LoadedState {
            state: AppState::default(),
            problem: None,
        });
    }

    let bytes = platform.fs().read(&path)?;
    let text = String::from_utf8_lossy(&bytes);
    let stored = match parse_zax_file(&text) {
        Ok(stored) => stored,
        Err(reason) => {
            return Ok(LoadedState {
                state: AppState::default(),
                problem: Some(format!("{} could not be read: {reason}", path.display())),
            });
        }
    };

    let mut installs = Vec::new();
    let mut unavailable = Vec::new();
    for entry in stored.installs {
        match identify_install(platform, std::path::Path::new(&entry.path)) {
            None => unavailable.push(entry),
            Some(game_type) => installs.push(Install {
                path: entry.path,
                game_type,
                alias: entry.alias,
                wine: entry.wine,
            }),
        }
    }

    Ok(LoadedState {
        state: AppState {
            installs,
            unavailable,
            theme: stored.theme,
            autosave: stored.autosave,
            accepted_cautions: stored.accepted_cautions,
        },
        problem: None,
    })
}

/// Writes the state back, keeping the entries that could not be read this session.
///
/// # Errors
///
/// Fails when the file cannot be written.
pub fn save_state(platform: &dyn Platform, state: &AppState) -> Result<()> {
    let mut stored: Vec<StoredInstall> = state
        .installs
        .iter()
        .map(|install| StoredInstall {
            path: install.path.clone(),
            alias: install.alias.clone(),
            wine: install.wine.clone(),
        })
        .collect();
    stored.extend(state.unavailable.iter().cloned());

    let text = format_zax_file(&ZaxFile {
        installs: stored,
        theme: state.theme,
        autosave: state.autosave,
        accepted_cautions: state.accepted_cautions.clone(),
    });
    platform
        .fs()
        .write(&zax_file_path(platform), text.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::install::GameType;
    use std::collections::BTreeMap;
    use zax_platform::memory::{Content, MemoryOptions, MemoryPlatform};

    const CONFIG: &str = "/home/tester/.config/zax/zax.yml";

    fn platform_with(files: &[(&str, &str)]) -> MemoryPlatform {
        MemoryPlatform::new(MemoryOptions {
            files: files
                .iter()
                .map(|(p, c)| ((*p).to_owned(), Content::from(*c)))
                .collect(),
            ..MemoryOptions::default()
        })
    }

    fn with_install_and_state(state: &str) -> MemoryPlatform {
        platform_with(&[("/games/f2/fallout2.exe", "MZ"), (CONFIG, state)])
    }

    #[test]
    fn no_file_at_all_is_a_first_run() {
        let platform = MemoryPlatform::default();
        let loaded = load_state(&platform).expect("load");
        assert_eq!(loaded.state, AppState::default());
        assert_eq!(loaded.problem, None);
    }

    #[test]
    fn a_stored_install_gets_its_type_from_the_directory() {
        // The type is not stored, so a mod installed since the file was written is reflected.
        let platform = with_install_and_state("games:\n  - path: /games/f2\n");
        let loaded = load_state(&platform).expect("load");
        assert_eq!(loaded.state.installs.len(), 1);
        assert_eq!(loaded.state.installs[0].game_type, GameType::Fallout2);
        assert!(loaded.state.unavailable.is_empty());
    }

    #[test]
    fn an_install_that_cannot_be_read_is_kept_rather_than_dropped() {
        // An unplugged drive for one session must not lose the entry permanently.
        let platform = with_install_and_state("games:\n  - path: /games/f2\n  - path: /mnt/gone\n");
        let loaded = load_state(&platform).expect("load");
        assert_eq!(loaded.state.installs.len(), 1);
        assert_eq!(
            loaded
                .state
                .unavailable
                .iter()
                .map(|i| i.path.as_str())
                .collect::<Vec<_>>(),
            vec!["/mnt/gone"]
        );
    }

    #[test]
    fn a_file_that_will_not_parse_is_reported_and_the_state_stays_empty() {
        // The caller shows this and does not overwrite.
        let platform = platform_with(&[(CONFIG, "games: [unclosed")]);
        let loaded = load_state(&platform).expect("load");
        assert_eq!(loaded.state, AppState::default());
        assert!(
            loaded
                .problem
                .as_deref()
                .is_some_and(|p| p.contains("could not be read")),
            "{:?}",
            loaded.problem
        );
    }

    #[test]
    fn an_unavailable_install_survives_a_save() {
        // This is the round trip the "kept rather than dropped" rule exists for.
        let platform = with_install_and_state("games:\n  - path: /games/f2\n  - path: /mnt/gone\n");
        let loaded = load_state(&platform).expect("load");
        save_state(&platform, &loaded.state).expect("save");

        let again = load_state(&platform).expect("reload");
        assert_eq!(
            again
                .state
                .unavailable
                .iter()
                .map(|i| i.path.as_str())
                .collect::<Vec<_>>(),
            vec!["/mnt/gone"]
        );
        assert_eq!(again.state.installs.len(), 1);
    }

    #[test]
    fn preferences_round_trip() {
        let platform = with_install_and_state("games: []\ntheme: dark\nautosave: false\n");
        let loaded = load_state(&platform).expect("load");
        assert_eq!(loaded.state.theme, Theme::Dark);
        assert!(!loaded.state.autosave);

        save_state(&platform, &loaded.state).expect("save");
        let again = load_state(&platform).expect("reload");
        assert_eq!(again.state.theme, Theme::Dark);
        assert!(!again.state.autosave);
    }

    #[test]
    fn an_alias_and_wine_settings_survive_a_round_trip() {
        let platform = with_install_and_state(
            "games:\n  - path: /games/f2\n    alias: My run\n    wine_debug: -all\n",
        );
        let loaded = load_state(&platform).expect("load");
        save_state(&platform, &loaded.state).expect("save");

        let again = load_state(&platform).expect("reload");
        let install = &again.state.installs[0];
        assert_eq!(install.alias.as_deref(), Some("My run"));
        assert_eq!(
            install.wine.as_ref().and_then(|w| w.debug.as_deref()),
            Some("-all")
        );
    }

    #[test]
    fn saving_writes_where_loading_reads() {
        let platform = MemoryPlatform::new(MemoryOptions {
            files: BTreeMap::from([("/games/f2/fallout2.exe".to_owned(), Content::from("MZ"))]),
            ..MemoryOptions::default()
        });
        let state = AppState {
            installs: vec![Install::new("/games/f2", GameType::Fallout2)],
            ..AppState::default()
        };
        save_state(&platform, &state).expect("save");
        assert!(
            platform.text_at(CONFIG).is_some(),
            "{:?}",
            platform.all_files()
        );
        assert_eq!(load_state(&platform).expect("load").state.installs.len(), 1);
    }
}

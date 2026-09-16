//! The archive a bug report attaches. What goes in is a fact about this game's layout - where sfall
//! writes its logs, that `mods/` holds the mod files, that saves live under `data/` in a directory
//! whose case varies - so it lives here rather than in the view that offers the button.

use std::path::{Path, PathBuf};

use zax_core::directories::{debug_directory, log_file, temporary_directory};
use zax_core::fs::list_files_recursively;
use zax_core::install::Install;
use zax_core::stamp::{LocalTime, stamp};
use zax_platform::archive::ArchiveEntry;
use zax_platform::fs::FileKind;
use zax_platform::{Platform, Result};

use crate::launch::WINE_LOG;
use crate::mods::{MODS_DIRECTORY, MODS_ORDER_FILE};

/// Fallout 2 installers disagree about the case of this directory, and both spellings occur in the
/// wild.
const SAVE_DIRECTORIES: &[&str] = &["data/SAVEGAME", "data/savegame"];

/// Files from the game folder worth having, beyond every `.ini` and `.cfg`.
pub const WANTED: &[&str] = &["ddraw.dll", "debug.log", "sfall-log.txt", WINE_LOG];

fn interesting(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.ends_with(".ini") || lower.ends_with(".cfg") || WANTED.contains(&lower.as_str())
}

/// A `/`-separated path joined onto a host path a segment at a time, so the host's own separator is
/// what lands on disk.
fn under(root: &Path, path: &str) -> PathBuf {
    let mut out = root.to_path_buf();
    for segment in path.split('/') {
        out.push(segment);
    }
    out
}

/// Where this install keeps its saves, or nothing when it has no save directory yet.
///
/// # Errors
///
/// Fails where the game folder cannot be read.
pub fn save_directory(platform: &dyn Platform, install: &Install) -> Result<Option<PathBuf>> {
    for candidate in SAVE_DIRECTORIES {
        let path = under(Path::new(&install.path), candidate);
        if platform.fs().stat(&path)?.map(|stat| stat.kind) == Some(FileKind::Dir) {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

/// The save slots the user can choose to attach, in the order the game numbers them.
///
/// # Errors
///
/// Fails where the save directory is there but cannot be listed.
pub fn list_saves(platform: &dyn Platform, install: &Install) -> Result<Vec<String>> {
    let Some(directory) = save_directory(platform, install)? else {
        return Ok(Vec::new());
    };
    let mut slots: Vec<String> = platform
        .fs()
        .list(&directory)?
        .into_iter()
        .filter(|entry| {
            entry.kind == FileKind::Dir && entry.name.to_uppercase().starts_with("SLOT")
        })
        .map(|entry| entry.name)
        .collect();
    slots.sort();
    Ok(slots)
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugPackage {
    /// Where the archive was written.
    pub path: PathBuf,
    /// What went into it, by the name it has inside the archive.
    pub contents: Vec<String>,
}

/// Collects the configs, logs and chosen saves into one zip under the debug directory.
///
/// The two listings are generated rather than collected: which files an install has is exactly the
/// question a bug report cannot answer from the configs alone, and a mod that failed to install shows
/// up as an absence.
///
/// # Errors
///
/// Fails where the game folder cannot be read or the archive cannot be written.
pub fn create_debug_package(
    platform: &dyn Platform,
    install: &Install,
    saves: &[String],
    now: LocalTime,
) -> Result<DebugPackage> {
    let at = stamp(now);
    let scratch = temporary_directory(platform).join(format!("debug-{at}"));
    let built = collect(platform, install, saves, &at, &scratch);
    // The scratch listings go whether the archive was written or not; their removal is not the failure
    // worth reporting.
    let _ = platform.fs().remove(&scratch);
    built
}

fn collect(
    platform: &dyn Platform,
    install: &Install,
    saves: &[String],
    at: &str,
    scratch: &Path,
) -> Result<DebugPackage> {
    let mut entries: Vec<ArchiveEntry> = Vec::new();
    let install_path = Path::new(&install.path);

    let listing = |directory: &Path, name: &str, entries: &mut Vec<ArchiveEntry>| -> Result<()> {
        if platform.fs().stat(directory)?.map(|stat| stat.kind) != Some(FileKind::Dir) {
            return Ok(());
        }
        let mut names: Vec<String> = platform
            .fs()
            .list(directory)?
            .into_iter()
            .map(|entry| entry.name)
            .collect();
        names.sort();
        let path = scratch.join(name);
        platform.fs().write(&path, names.join("\n").as_bytes())?;
        entries.push(ArchiveEntry {
            source: path,
            name: name.to_owned(),
        });
        Ok(())
    };

    for entry in platform.fs().list(install_path)? {
        if entry.kind == FileKind::File && interesting(&entry.name) {
            entries.push(ArchiveEntry {
                source: install_path.join(&entry.name),
                name: entry.name,
            });
        }
    }
    listing(install_path, "game.txt", &mut entries)?;

    let mods = install_path.join(MODS_DIRECTORY);
    if platform.fs().stat(&mods)?.map(|stat| stat.kind) == Some(FileKind::Dir) {
        for entry in platform.fs().list(&mods)? {
            // The load order by name as well as by suffix: it is the only file saying which of the mods
            // listed beside it are enabled and in what order the loader takes them, which is the
            // question a conflict asks.
            let lower = entry.name.to_lowercase();
            let wanted = lower.ends_with(".ini") || lower == MODS_ORDER_FILE.to_lowercase();
            if entry.kind == FileKind::File && wanted {
                entries.push(ArchiveEntry {
                    source: mods.join(&entry.name),
                    name: format!("{MODS_DIRECTORY}/{}", entry.name),
                });
            }
        }
        listing(&mods, "mods.txt", &mut entries)?;
    }

    // ZAX's own record of what it did - failed and resumed downloads above all, which nothing in the
    // game folder witnesses and a report from a poor connection cannot reconstruct. Absent until
    // something has been written, and an install that has had no trouble legitimately has none.
    let log = log_file(platform);
    if platform.fs().stat(&log)?.map(|stat| stat.kind) == Some(FileKind::File)
        && let Some(name) = log.file_name().and_then(|one| one.to_str())
    {
        entries.push(ArchiveEntry {
            source: log.clone(),
            name: name.to_owned(),
        });
    }

    if let Some(saves_at) = save_directory(platform, install)? {
        for slot in saves {
            let from = saves_at.join(slot);
            for file in list_files_recursively(platform, &from)? {
                entries.push(ArchiveEntry {
                    source: under(&from, &file),
                    name: format!("{slot}/{file}"),
                });
            }
        }
    }

    let path = debug_directory(platform).join(format!("zax_debug_{at}.zip"));
    platform.archive().create_zip(&path, &entries)?;
    Ok(DebugPackage {
        contents: entries.into_iter().map(|entry| entry.name).collect(),
        path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use zax_core::install::GameType;
    use zax_platform::memory::{Content, MemoryOptions, MemoryPlatform};

    fn now() -> LocalTime {
        LocalTime {
            year: 2024,
            month: 5,
            day: 6,
            hour: 7,
            minute: 8,
            second: 9,
        }
    }

    fn install() -> Install {
        Install::new("/games/f2", GameType::Fallout2)
    }

    fn platform(files: &[(&str, &str)]) -> MemoryPlatform {
        MemoryPlatform::new(MemoryOptions {
            files: files
                .iter()
                .map(|(path, text)| ((*path).to_owned(), Content::from(*text)))
                .collect(),
            ..MemoryOptions::default()
        })
    }

    fn packaged(platform: &MemoryPlatform, saves: &[String]) -> DebugPackage {
        create_debug_package(platform, &install(), saves, now()).expect("a package")
    }

    #[test]
    fn the_configs_and_logs_go_in_and_nothing_else_does() {
        let platform = platform(&[
            ("/games/f2/fallout2.cfg", "[system]\n"),
            ("/games/f2/ddraw.ini", "[Misc]\n"),
            ("/games/f2/sfall-log.txt", "log"),
            ("/games/f2/fallout2.exe", "binary"),
            ("/games/f2/master.dat", "data"),
        ]);
        let built = packaged(&platform, &[]);
        assert!(built.contents.contains(&"fallout2.cfg".to_owned()));
        assert!(built.contents.contains(&"ddraw.ini".to_owned()));
        assert!(built.contents.contains(&"sfall-log.txt".to_owned()));
        assert!(!built.contents.contains(&"fallout2.exe".to_owned()));
        assert!(!built.contents.contains(&"master.dat".to_owned()));
    }

    #[test]
    fn the_listing_answers_what_the_configs_cannot() {
        // A mod that failed to install shows up as an absence.
        let platform = platform(&[
            ("/games/f2/fallout2.cfg", "[system]\n"),
            ("/games/f2/master.dat", "data"),
            ("/games/f2/mods/ecco.dat", "dat"),
            ("/games/f2/mods/mods_order.txt", "ecco.dat\n"),
        ]);
        // Through `collect` rather than the whole package, which clears the scratch the listings are
        // written into before it returns.
        let scratch = Path::new("/scratch");
        let built = collect(&platform, &install(), &[], "at", scratch).expect("a package");
        assert!(built.contents.contains(&"game.txt".to_owned()));
        assert!(built.contents.contains(&"mods.txt".to_owned()));
        let body = platform
            .fs()
            .read(&scratch.join("mods.txt"))
            .expect("a read");
        assert_eq!(
            String::from_utf8(body).expect("a listing"),
            "ecco.dat\nmods_order.txt"
        );
    }

    #[test]
    fn the_load_order_goes_in_by_name_as_well_as_by_suffix() {
        // It is the only file saying which mods are enabled and in what order.
        let platform = platform(&[
            ("/games/f2/mods/mods_order.txt", "ecco.dat\n"),
            ("/games/f2/mods/ecco.ini", "[Main]\n"),
            ("/games/f2/mods/ecco.dat", "dat"),
        ]);
        let built = packaged(&platform, &[]);
        assert!(built.contents.contains(&"mods/mods_order.txt".to_owned()));
        assert!(built.contents.contains(&"mods/ecco.ini".to_owned()));
        assert!(!built.contents.contains(&"mods/ecco.dat".to_owned()));
    }

    #[test]
    fn an_install_with_no_mods_folder_still_packages() {
        let platform = platform(&[("/games/f2/fallout2.cfg", "[system]\n")]);
        let built = packaged(&platform, &[]);
        assert!(!built.contents.contains(&"mods.txt".to_owned()));
        assert!(built.path.to_string_lossy().ends_with(".zip"), "{built:?}");
    }

    #[test]
    fn zaxs_own_log_goes_in_where_there_is_one() {
        let platform = platform(&[("/games/f2/fallout2.cfg", "[system]\n")]);
        let built = packaged(&platform, &[]);
        assert!(!built.contents.contains(&"zax.log".to_owned()));
        platform
            .fs()
            .write(&log_file(&platform), b"a line")
            .expect("a write");
        let with_log = packaged(&platform, &[]);
        assert!(with_log.contents.contains(&"zax.log".to_owned()));
    }

    #[test]
    fn either_spelling_of_the_save_directory_answers() {
        // Fallout 2 installers disagree about its case and both occur in the wild.
        for spelling in ["data/SAVEGAME", "data/savegame"] {
            let platform = platform(&[(&format!("/games/f2/{spelling}/SLOT01/SAVE.DAT"), "save")]);
            assert_eq!(
                save_directory(&platform, &install()).expect("a read"),
                Some(under(Path::new("/games/f2"), spelling))
            );
            assert_eq!(
                list_saves(&platform, &install()).expect("a read"),
                ["SLOT01"]
            );
        }
    }

    #[test]
    fn an_install_with_no_saves_offers_none() {
        let platform = platform(&[("/games/f2/fallout2.cfg", "[system]\n")]);
        assert_eq!(save_directory(&platform, &install()).expect("a read"), None);
        assert!(
            list_saves(&platform, &install())
                .expect("a read")
                .is_empty()
        );
    }

    #[test]
    fn the_slots_come_back_in_the_order_the_game_numbers_them() {
        let platform = platform(&[
            ("/games/f2/data/SAVEGAME/SLOT10/SAVE.DAT", "save"),
            ("/games/f2/data/SAVEGAME/SLOT02/SAVE.DAT", "save"),
            ("/games/f2/data/SAVEGAME/SLOT01/SAVE.DAT", "save"),
            ("/games/f2/data/SAVEGAME/notes.txt", "not a slot"),
        ]);
        assert_eq!(
            list_saves(&platform, &install()).expect("a read"),
            ["SLOT01", "SLOT02", "SLOT10"]
        );
    }

    #[test]
    fn a_chosen_slot_goes_in_whole() {
        let platform = platform(&[
            ("/games/f2/fallout2.cfg", "[system]\n"),
            ("/games/f2/data/SAVEGAME/SLOT01/SAVE.DAT", "save"),
            ("/games/f2/data/SAVEGAME/SLOT01/proto/00000001.pro", "proto"),
            ("/games/f2/data/SAVEGAME/SLOT02/SAVE.DAT", "other"),
        ]);
        let built = packaged(&platform, &["SLOT01".to_owned()]);
        assert!(built.contents.contains(&"SLOT01/SAVE.DAT".to_owned()));
        assert!(
            built
                .contents
                .contains(&"SLOT01/proto/00000001.pro".to_owned())
        );
        assert!(
            !built.contents.iter().any(|name| name.starts_with("SLOT02")),
            "{:?}",
            built.contents
        );
    }

    #[test]
    fn the_scratch_listings_do_not_outlive_the_package() {
        let platform = platform(&[("/games/f2/fallout2.cfg", "[system]\n")]);
        packaged(&platform, &[]);
        let scratch = temporary_directory(&platform).join(format!("debug-{}", stamp(now())));
        assert_eq!(platform.fs().stat(&scratch).expect("a read"), None);
    }

    #[test]
    fn the_archive_is_named_for_the_moment_it_was_made() {
        let platform = platform(&[("/games/f2/fallout2.cfg", "[system]\n")]);
        let built = packaged(&platform, &[]);
        assert_eq!(
            built.path,
            debug_directory(&platform).join(format!("zax_debug_{}.zip", stamp(now())))
        );
    }

    #[test]
    fn a_wine_log_beside_the_game_is_worth_having() {
        let platform = platform(&[(&format!("/games/f2/{WINE_LOG}"), "wine said")]);
        let built = packaged(&platform, &[]);
        assert!(built.contents.contains(&WINE_LOG.to_owned()));
    }

    #[test]
    fn a_map_of_the_contents_matches_what_was_zipped() {
        let platform = platform(&[
            ("/games/f2/fallout2.cfg", "[system]\n"),
            ("/games/f2/mods/ecco.ini", "[Main]\n"),
        ]);
        let built = packaged(&platform, &[]);
        let zipped: Vec<String> = platform
            .records()
            .zipped
            .last()
            .expect("one archive")
            .entries
            .iter()
            .map(|entry| entry.name.clone())
            .collect();
        assert_eq!(built.contents, zipped);
    }
}

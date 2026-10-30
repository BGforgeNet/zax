//! Finding installs on a real machine.
//!
//! The rule for *what counts as* an install lives in [`crate::install`] and takes directory
//! listings; this module is the part that has to read them.
//!
//! Every store lets the user put the game somewhere else, so a list of default paths can only ever
//! be a guess. Where a launcher records what it did - Steam's library list, Epic's manifests, GOG's
//! registry keys - the scan asks it and learns the real directory; the default paths are the
//! fallback for retail copies and for anything installed by hand, and a shallow search catches
//! folders whose names nobody predicted. One conversion installs inside another install, so the
//! installs themselves are a source too, asked once the rest have answered.
//!
//! Whatever a source proposes is only a candidate: one gate, [`identify_install`], decides what is
//! really an install, so a new source cannot invent a way for something to qualify.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde_json::Value;
use zax_platform::fs::{DirEntry, FileKind};
use zax_platform::{OperatingSystem, Platform};

use crate::install::{
    EPIC_MANIFEST_DIRECTORY, EPIC_REGISTRY_KEY, FO1IN2_DIRECTORY, GOG_REGISTRY_KEYS, GameType,
    Install, SCAN_LOCATIONS, STEAM_APP_ID, STEAM_LOCATIONS, STEAM_REGISTRY_KEY,
    UNSEARCHABLE_DIRECTORIES, detect_game_type,
};
use crate::log::{LogLevel, append_log};
use crate::stamp::Utc;
use crate::vdf::{VdfValue, parse_vdf};

/// How many directories the shallow search may look at. Reached only on a machine with a very wide
/// drive root.
const SEARCH_BUDGET: u32 = 4_000;

/// How deep below a root the shallow search goes. Two levels reaches `D:/Games/Fallout 2 GOG` and
/// stops.
const SEARCH_DEPTH: u32 = 2;

/// A directory some source thinks may hold a game, and what suggested it - which is what the log
/// reports.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Candidate {
    path: PathBuf,
    source: &'static str,
}

/// One scan's shared state.
///
/// Listings are kept because the sources overlap heavily - several of them look at the same drive
/// root - and a scan that re-read every parent per candidate would cost multiples of what it needs.
struct Scan<'a> {
    platform: &'a dyn Platform,
    listings: BTreeMap<PathBuf, Option<BTreeMap<String, DirEntry>>>,
    notes: Vec<String>,
    budget: u32,
}

impl<'a> Scan<'a> {
    fn new(platform: &'a dyn Platform) -> Self {
        Self {
            platform,
            listings: BTreeMap::new(),
            notes: Vec::new(),
            budget: SEARCH_BUDGET,
        }
    }

    /// A directory's entries by lowercased name, or `None` when it is not a readable directory.
    ///
    /// Unreadable is an ordinary answer to a scan: it probes directories it was never given
    /// permission to, and a machine that refuses one of them must not lose the rest of the scan
    /// with it.
    fn listing(&mut self, path: &Path) -> Option<&BTreeMap<String, DirEntry>> {
        if !self.listings.contains_key(path) {
            let found = match self.platform.fs().stat(path) {
                Ok(Some(stat)) if stat.kind == FileKind::Dir => match self.platform.fs().list(path)
                {
                    Ok(entries) => Some(
                        entries
                            .into_iter()
                            .map(|entry| (entry.name.to_lowercase(), entry))
                            .collect(),
                    ),
                    Err(err) => {
                        // The Xbox app's own directory is the one that reliably does this, which is
                        // worth telling the user about rather than silently finding nothing there.
                        self.notes
                            .push(format!("could not look inside {}: {err}", path.display()));
                        None
                    }
                },
                Ok(_) => None,
                Err(err) => {
                    self.notes
                        .push(format!("could not look inside {}: {err}", path.display()));
                    None
                }
            };
            self.listings.insert(path.to_path_buf(), found);
        }
        self.listings.get(path).and_then(Option::as_ref)
    }

    /// A relative path under a root, spelled the way the filesystem actually spells it, or `None`
    /// when it is not there.
    ///
    /// Matching is case-insensitive because the same install reads back differently through Wine
    /// than it does natively, and because none of these paths were typed by the user. Resolving
    /// against the real entries rather than guessing a second spelling is also what keeps one
    /// directory from being found twice under two casings.
    fn resolve(&mut self, root: &Path, relative: &str) -> Option<PathBuf> {
        let mut at = root.to_path_buf();
        for segment in relative.split('/').filter(|s| !s.is_empty()) {
            let found = self.listing(&at)?.get(&segment.to_lowercase())?;
            if found.kind != FileKind::Dir {
                return None;
            }
            at = at.join(&found.name);
        }
        Some(at)
    }

    fn read_bytes(&self, path: &Path) -> Option<Vec<u8>> {
        match self.platform.fs().stat(path) {
            Ok(Some(stat)) if stat.kind == FileKind::File => self.platform.fs().read(path).ok(),
            _ => None,
        }
    }
}

/// The names in a directory, or `None` when it is not a readable directory.
fn list_names(platform: &dyn Platform, path: &Path) -> Option<Vec<String>> {
    match platform.fs().stat(path) {
        Ok(Some(stat)) if stat.kind == FileKind::Dir => Some(
            platform
                .fs()
                .list(path)
                .ok()?
                .into_iter()
                .map(|entry| entry.name)
                .collect(),
        ),
        _ => None,
    }
}

/// What kind of install sits at a path, or `None` when it is not one.
///
/// Includes the case where the path is gone or is not a directory at all, which is what a recorded
/// install on an unmounted drive looks like.
#[must_use]
pub fn identify_install(platform: &dyn Platform, path: &Path) -> Option<GameType> {
    let root = list_names(platform, path)?;
    let mods = list_names(platform, &path.join("mods")).unwrap_or_default();
    detect_game_type(&root, &mods)
}

/// Where the scan starts.
///
/// On Windows that is every drive that answers, rather than the two that used to be assumed - a
/// second disk holding games is the ordinary case, and it is rarely D:. Elsewhere it is the home
/// directory, the Wine prefix's C: drive where a Windows build lives, and any mounted volume, which
/// is where a Steam Deck keeps its SD card.
#[must_use]
pub fn scan_roots(platform: &dyn Platform, wine_prefix: Option<&Path>) -> Vec<PathBuf> {
    if platform.os() == OperatingSystem::Windows {
        let mut drives = Vec::new();
        // From C: rather than A:, because the two letters below it are the floppy drives and asking
        // a machine that still has one costs seconds of it seeking for a disk nobody has installed a
        // game on.
        for letter in b'C'..=b'Z' {
            let root = PathBuf::from(format!("{}:\\", letter as char));
            if matches!(platform.fs().stat(&root), Ok(Some(stat)) if stat.kind == FileKind::Dir) {
                drives.push(root);
            }
        }
        return drives;
    }

    let home = platform.paths().home();
    let prefix = wine_prefix.map_or_else(|| home.join(".wine"), Path::to_path_buf);
    let mut roots = vec![home.to_path_buf(), prefix.join("drive_c")];

    let mut scan = Scan::new(platform);
    for mount in ["/run/media", "/media", "/mnt"] {
        let mount = Path::new(mount);
        let Some(entries) = scan.listing(mount) else {
            continue;
        };
        let names: Vec<String> = entries
            .values()
            .filter(|entry| entry.kind == FileKind::Dir)
            .map(|entry| entry.name.clone())
            .collect();
        for name in names {
            // `/run/media/<user>/<volume>` on some desktops, `/media/<volume>` on others; take both
            // levels.
            let at = mount.join(&name);
            roots.push(at.clone());
            let below: Vec<String> = scan
                .listing(&at)
                .map(|entries| {
                    entries
                        .values()
                        .filter(|entry| entry.kind == FileKind::Dir)
                        .map(|entry| entry.name.clone())
                        .collect()
                })
                .unwrap_or_default();
            roots.extend(below.into_iter().map(|name| at.join(name)));
        }
    }
    roots
}

/// Steam's own directories: the defaults under every root, plus wherever the registry says Steam
/// went.
fn steam_directories(scan: &mut Scan<'_>, roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(Some(recorded)) = scan
        .platform
        .registry()
        .read(STEAM_REGISTRY_KEY.key, STEAM_REGISTRY_KEY.value)
    {
        out.push(PathBuf::from(recorded));
    }
    for root in roots {
        for location in STEAM_LOCATIONS {
            if let Some(found) = scan.resolve(root, location) {
                out.push(found);
            }
        }
    }
    out
}

/// Steam keeps every library it knows about in one file, including the one it was installed into, so
/// finding any Steam directory finds all of them - on every drive, wherever the user put them.
///
/// Each library then records the folder each game sits in, which is how this avoids having to know
/// what Steam calls the folder.
fn from_steam(scan: &mut Scan<'_>, roots: &[PathBuf]) -> Vec<Candidate> {
    let mut out = Vec::new();
    let mut seen: BTreeSet<PathBuf> = BTreeSet::new();

    for steam in steam_directories(scan, roots) {
        let mut libraries = vec![steam.clone()];
        if let Some(listed) = scan.resolve(&steam, "steamapps")
            && let Some(text) = scan.read_bytes(&listed.join("libraryfolders.vdf"))
        {
            libraries.extend(library_paths(&text));
        }

        for library in libraries {
            if !seen.insert(library.clone()) {
                continue;
            }
            let Some(apps) = scan.resolve(&library, "steamapps") else {
                continue;
            };
            let Some(manifest) =
                scan.read_bytes(&apps.join(format!("appmanifest_{STEAM_APP_ID}.acf")))
            else {
                continue;
            };
            let parsed = parse_vdf(&manifest);
            let Some(directory) = parsed
                .map("AppState")
                .and_then(|state| state.text("installdir"))
            else {
                continue;
            };
            if let Some(at) = scan.resolve(&apps, &format!("common/{directory}")) {
                out.push(Candidate {
                    path: at,
                    source: "Steam library",
                });
            }
        }
    }
    out
}

/// Every `path` one level under `libraryfolders`, which is where each library's own root is
/// recorded.
fn library_paths(text: &[u8]) -> Vec<PathBuf> {
    let parsed = parse_vdf(text);
    let Some(folders) = parsed.map("libraryfolders") else {
        return Vec::new();
    };
    folders
        .iter()
        .filter_map(|(_, entry)| match entry {
            VdfValue::Map(map) => map.text("path"),
            VdfValue::Text(_) => None,
        })
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .collect()
}

/// Epic writes one manifest per installed game, each naming the directory it went into.
///
/// Every manifest is offered rather than the one for Fallout 2, because which product id that is
/// cannot be read off the launcher and the gate rejects the rest for free.
fn from_epic(scan: &mut Scan<'_>, roots: &[PathBuf]) -> Vec<Candidate> {
    let mut directories = Vec::new();
    if let Ok(Some(recorded)) = scan
        .platform
        .registry()
        .read(EPIC_REGISTRY_KEY.key, EPIC_REGISTRY_KEY.value)
    {
        directories.push(PathBuf::from(recorded).join("Manifests"));
    }
    for root in roots {
        if let Some(found) = scan.resolve(root, EPIC_MANIFEST_DIRECTORY) {
            directories.push(found);
        }
    }

    let mut out = Vec::new();
    for directory in directories {
        let items: Vec<String> = scan
            .listing(&directory)
            .map(|entries| {
                entries
                    .values()
                    .filter(|entry| {
                        entry.kind == FileKind::File && entry.name.to_lowercase().ends_with(".item")
                    })
                    .map(|entry| entry.name.clone())
                    .collect()
            })
            .unwrap_or_default();
        for item in items {
            let Some(text) = scan.read_bytes(&directory.join(&item)) else {
                continue;
            };
            if let Some(where_at) = install_location(&text) {
                out.push(Candidate {
                    path: PathBuf::from(where_at),
                    source: "Epic manifest",
                });
            }
        }
    }
    out
}

/// A manifest is JSON, and a damaged one costs the install it describes rather than the scan.
fn install_location(text: &[u8]) -> Option<String> {
    let parsed: Value = serde_json::from_slice(text).ok()?;
    let where_at = parsed.get("InstallLocation")?.as_str()?;
    (!where_at.is_empty()).then(|| where_at.to_owned())
}

/// GOG records the directory per product.
///
/// Both ids are asked for: the store sells the game as a pack, and which of the two an install
/// registers under depends on which of them was installed.
fn from_gog(scan: &Scan<'_>) -> Vec<Candidate> {
    let mut out = Vec::new();
    for key in GOG_REGISTRY_KEYS {
        if let Ok(Some(found)) = scan.platform.registry().read(key, "path") {
            out.push(Candidate {
                path: PathBuf::from(found),
                source: "GOG registry",
            });
        }
    }
    out
}

/// The store defaults, which is all there is for a retail copy or one installed by hand.
fn from_known_locations(scan: &mut Scan<'_>, roots: &[PathBuf]) -> Vec<Candidate> {
    let mut out = Vec::new();
    for root in roots {
        for location in SCAN_LOCATIONS {
            if let Some(found) = scan.resolve(root, location) {
                out.push(Candidate {
                    path: found,
                    source: "known location",
                });
            }
        }
    }
    out
}

/// A shallow look below each root, for the copies no list of defaults can predict - a renamed
/// folder, a second library directory, a game moved by hand.
///
/// Bounded in both depth and total directories examined, because this is the one source whose cost
/// is set by what is on the machine rather than by what it is looking for.
fn from_search(scan: &mut Scan<'_>, roots: &[PathBuf]) -> Vec<Candidate> {
    let mut out = Vec::new();
    let mut pending: Vec<(PathBuf, u32)> = roots.iter().map(|root| (root.clone(), 1)).collect();

    while let Some((at, depth)) = pending.pop() {
        if depth > SEARCH_DEPTH || scan.budget == 0 {
            continue;
        }
        let names: Vec<String> = scan
            .listing(&at)
            .map(|entries| {
                entries
                    .values()
                    .filter(|entry| entry.kind == FileKind::Dir)
                    .map(|entry| entry.name.clone())
                    .collect()
            })
            .unwrap_or_default();
        for name in names {
            if scan.budget == 0 {
                break;
            }
            let lowered = name.to_lowercase();
            if lowered.starts_with('.') || UNSEARCHABLE_DIRECTORIES.contains(&lowered.as_str()) {
                continue;
            }
            scan.budget -= 1;
            let below = at.join(&name);
            out.push(Candidate {
                path: below.clone(),
                source: "search",
            });
            pending.push((below, depth + 1));
        }
    }
    out
}

/// Fallout et tu, which lives in a folder inside a Fallout 2 install rather than anywhere a launcher
/// or a default path would name.
///
/// Installs already on the list are asked as well as the ones just found: the mod is normally
/// installed long after the game it sits in was added, and a scan that only looked inside new
/// installs would never find it on the machine of anyone who had already used ZAX.
fn from_installs(scan: &mut Scan<'_>, installs: &[PathBuf]) -> Vec<Candidate> {
    let mut out = Vec::new();
    for path in installs {
        if let Some(found) = scan.resolve(path, FO1IN2_DIRECTORY) {
            out.push(Candidate {
                path: found,
                source: "inside an install",
            });
        }
    }
    out
}

/// Two spellings of one directory are one install, on the filesystems that do not distinguish them.
fn dedupe_key(platform: &dyn Platform, path: &Path) -> String {
    // By component, so `C:/Games` and `C:\Games\` are one key where the host reads both as separators,
    // while a Linux host keeps `\` as the file-name character it is there.
    let at = path
        .components()
        .map(|part| part.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");
    if platform.os() == OperatingSystem::Linux {
        at
    } else {
        at.to_lowercase()
    }
}

/// Installs found on this machine and not already on the list, in the order the sources are asked.
///
/// The launchers that know where they put things come first, then the defaults, then the search,
/// then inside the installs. The order is what decides which source a directory is credited to in
/// the log when more than one proposes it.
pub fn scan_for_installs(
    platform: &dyn Platform,
    known: &[Install],
    now: Utc,
    wine_prefix: Option<&Path>,
) -> Vec<Install> {
    let mut scan = Scan::new(platform);
    let roots = scan_roots(platform, wine_prefix);

    let mut candidates = Vec::new();
    candidates.extend(from_steam(&mut scan, &roots));
    candidates.extend(from_epic(&mut scan, &roots));
    candidates.extend(from_gog(&scan));
    candidates.extend(from_known_locations(&mut scan, &roots));
    candidates.extend(from_search(&mut scan, &roots));

    let mut seen: BTreeSet<String> = known
        .iter()
        .map(|install| dedupe_key(platform, Path::new(&install.path)))
        .collect();
    let mut found: Vec<Install> = Vec::new();
    let mut credited: Vec<String> = Vec::new();

    let mut consider = |proposed: &[Candidate], found: &mut Vec<Install>| {
        for candidate in proposed {
            let key = dedupe_key(platform, &candidate.path);
            if !seen.insert(key) {
                continue;
            }
            let Some(game_type) = identify_install(platform, &candidate.path) else {
                continue;
            };
            let path = candidate.path.to_string_lossy().into_owned();
            credited.push(format!(
                "{path} ({}, {})",
                candidate.source,
                game_type.as_str()
            ));
            found.push(Install::new(path, game_type));
        }
    };

    consider(&candidates, &mut found);
    // Last, because it is the one source whose directories are not known until every other has
    // answered.
    let inside: Vec<PathBuf> = known
        .iter()
        .map(|one| PathBuf::from(&one.path))
        .chain(found.iter().map(|one| PathBuf::from(&one.path)))
        .collect();
    let nested = from_installs(&mut scan, &inside);
    consider(&nested, &mut found);

    // A note is something the scan could not do - an unreadable root, a candidate it had to skip -
    // so it is a warning; the count that follows is the ordinary record of a scan having run.
    for note in &scan.notes {
        append_log(platform, LogLevel::Warn, &format!("scan: {note}"), now);
    }
    let detail = if credited.is_empty() {
        String::new()
    } else {
        format!(": {}", credited.join("; "))
    };
    append_log(
        platform,
        LogLevel::Info,
        &format!(
            "scan: {} roots, {} candidates, {} new{detail}",
            roots.len(),
            candidates.len() + nested.len(),
            found.len()
        ),
        now,
    );
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use zax_platform::memory::{Content, MemoryOptions, MemoryPlatform};

    fn now() -> Utc {
        Utc {
            year: 2026,
            month: 9,
            day: 16,
            hour: 12,
            minute: 0,
            second: 0,
            millisecond: 0,
        }
    }

    /// The marker every install must have in its root, so a fixture is a real install.
    fn install_at(root: &str) -> Vec<(String, String)> {
        vec![(format!("{root}/fallout2.exe"), "MZ".to_owned())]
    }

    /// Found paths as `Path`s, whose equality is the host's: a Windows host joins with `\` onto these
    /// `/` fixtures, and reads the two as one path.
    fn paths_of(found: &[Install]) -> Vec<&Path> {
        found.iter().map(|i| Path::new(&i.path)).collect()
    }

    fn platform_with(entries: Vec<(String, String)>, options: MemoryOptions) -> MemoryPlatform {
        let mut files: BTreeMap<String, Content> = entries
            .into_iter()
            .map(|(p, c)| (p, Content::from(c)))
            .collect();
        files.extend(options.files.clone());
        MemoryPlatform::new(MemoryOptions { files, ..options })
    }

    #[test]
    fn a_directory_with_the_marker_is_identified() {
        let platform = platform_with(install_at("/games/f2"), MemoryOptions::default());
        assert_eq!(
            identify_install(&platform, Path::new("/games/f2")),
            Some(GameType::Fallout2)
        );
    }

    #[test]
    fn a_path_that_is_gone_identifies_as_nothing() {
        // What a recorded install on an unmounted drive looks like.
        let platform = MemoryPlatform::default();
        assert_eq!(identify_install(&platform, Path::new("/gone")), None);
    }

    #[test]
    fn a_file_rather_than_a_directory_identifies_as_nothing() {
        let platform = platform_with(install_at("/games/f2"), MemoryOptions::default());
        assert_eq!(
            identify_install(&platform, Path::new("/games/f2/fallout2.exe")),
            None
        );
    }

    #[test]
    fn the_mods_directory_is_read_where_it_is_there() {
        let mut entries = install_at("/games/f2");
        entries.push(("/games/f2/mods/rpu.dat".to_owned(), "dat".to_owned()));
        let platform = platform_with(entries, MemoryOptions::default());
        assert_eq!(
            identify_install(&platform, Path::new("/games/f2")),
            Some(GameType::Fallout2Rpu)
        );
    }

    #[test]
    fn roots_off_windows_cover_home_and_the_wine_drive() {
        let platform = MemoryPlatform::default();
        let roots = scan_roots(&platform, None);
        assert!(roots.contains(&PathBuf::from("/home/tester")));
        assert!(roots.contains(&PathBuf::from("/home/tester/.wine/drive_c")));
    }

    #[test]
    fn a_named_wine_prefix_replaces_the_default_one() {
        let platform = MemoryPlatform::default();
        let roots = scan_roots(&platform, Some(Path::new("/prefixes/f2")));
        assert!(roots.contains(&PathBuf::from("/prefixes/f2/drive_c")));
        assert!(!roots.contains(&PathBuf::from("/home/tester/.wine/drive_c")));
    }

    #[test]
    fn a_mounted_volume_is_a_root_at_both_levels() {
        // `/run/media/<user>/<volume>` on some desktops, `/media/<volume>` on others.
        let platform = platform_with(
            vec![("/run/media/tester/SDCARD/marker".to_owned(), "x".to_owned())],
            MemoryOptions::default(),
        );
        let roots = scan_roots(&platform, None);
        assert!(roots.contains(&PathBuf::from("/run/media/tester")));
        assert!(roots.contains(&PathBuf::from("/run/media/tester/SDCARD")));
    }

    #[test]
    fn a_known_location_under_the_home_directory_is_found() {
        let platform = platform_with(
            install_at("/home/tester/Games/Fallout 2"),
            MemoryOptions::default(),
        );
        let found = scan_for_installs(&platform, &[], now(), None);
        assert_eq!(
            paths_of(&found),
            vec![Path::new("/home/tester/Games/Fallout 2")]
        );
    }

    #[test]
    fn a_known_location_is_matched_whatever_its_casing() {
        // None of these paths were typed by the user, and Wine reads them back differently.
        let platform = platform_with(
            install_at("/home/tester/games/FALLOUT 2"),
            MemoryOptions::default(),
        );
        let found = scan_for_installs(&platform, &[], now(), None);
        assert_eq!(
            paths_of(&found),
            vec![Path::new("/home/tester/games/FALLOUT 2")]
        );
    }

    #[test]
    fn an_install_already_on_the_list_is_not_offered_again() {
        let platform = platform_with(
            install_at("/home/tester/Games/Fallout 2"),
            MemoryOptions::default(),
        );
        let known = vec![Install::new(
            "/home/tester/Games/Fallout 2",
            GameType::Fallout2,
        )];
        assert!(scan_for_installs(&platform, &known, now(), None).is_empty());
    }

    #[test]
    fn a_candidate_that_is_not_an_install_is_refused() {
        // One gate decides, so a source cannot invent a way for something to qualify.
        let platform = platform_with(
            vec![(
                "/home/tester/Games/Fallout 2/readme.txt".to_owned(),
                "not a game".to_owned(),
            )],
            MemoryOptions::default(),
        );
        assert!(scan_for_installs(&platform, &[], now(), None).is_empty());
    }

    #[test]
    fn the_shallow_search_finds_a_folder_nobody_predicted() {
        let platform = platform_with(
            install_at("/home/tester/MyGames/Fallout2-GOG"),
            MemoryOptions::default(),
        );
        let found = scan_for_installs(&platform, &[], now(), None);
        assert_eq!(
            paths_of(&found),
            vec![Path::new("/home/tester/MyGames/Fallout2-GOG")]
        );
    }

    #[test]
    fn the_search_does_not_descend_past_its_depth() {
        // Two levels reaches `Games/Fallout 2` and stops.
        let platform = platform_with(
            install_at("/home/tester/one/two/three/Fallout 2"),
            MemoryOptions::default(),
        );
        assert!(scan_for_installs(&platform, &[], now(), None).is_empty());
    }

    #[test]
    fn fallout_et_tu_inside_a_known_install_is_found() {
        // The mod is normally installed long after the game it sits in was added.
        let mut entries = install_at("/games/f2");
        entries.extend(install_at("/games/f2/Fallout1in2"));
        entries.push((
            "/games/f2/Fallout1in2/mods/fo1_base".to_owned(),
            "dat".to_owned(),
        ));
        let platform = platform_with(entries, MemoryOptions::default());

        let known = vec![Install::new("/games/f2", GameType::Fallout2)];
        let found = scan_for_installs(&platform, &known, now(), None);
        assert_eq!(paths_of(&found), vec![Path::new("/games/f2/Fallout1in2")]);
        assert_eq!(found[0].game_type, GameType::Fo1In2);
    }

    #[test]
    fn a_steam_library_names_the_folder_the_game_sits_in() {
        let steam = "/home/tester/.local/share/Steam";
        let library = "/mnt/disk/SteamLibrary";
        let mut entries = install_at(&format!("{library}/steamapps/common/Fallout 2"));
        entries.push((
            format!("{steam}/steamapps/libraryfolders.vdf"),
            format!("\"libraryfolders\"\n{{\n \"0\"\n {{\n  \"path\" \"{library}\"\n }}\n}}\n"),
        ));
        entries.push((
            format!("{library}/steamapps/appmanifest_{STEAM_APP_ID}.acf"),
            "\"AppState\"\n{\n \"installdir\" \"Fallout 2\"\n}\n".to_owned(),
        ));
        let platform = platform_with(entries, MemoryOptions::default());

        let found = scan_for_installs(&platform, &[], now(), None);
        assert!(
            found.iter().any(|i| Path::new(&i.path)
                == Path::new(&format!("{library}/steamapps/common/Fallout 2"))),
            "{found:?}"
        );
    }

    #[test]
    fn an_epic_manifest_names_where_the_game_went() {
        let manifests = format!("/home/tester/{EPIC_MANIFEST_DIRECTORY}");
        let mut entries = install_at("/home/tester/EpicGames/Fallout 2");
        entries.push((
            format!("{manifests}/1234.item"),
            r#"{"InstallLocation":"/home/tester/EpicGames/Fallout 2"}"#.to_owned(),
        ));
        let platform = platform_with(entries, MemoryOptions::default());

        let found = scan_for_installs(&platform, &[], now(), None);
        assert!(
            found
                .iter()
                .any(|i| Path::new(&i.path) == Path::new("/home/tester/EpicGames/Fallout 2")),
            "{found:?}"
        );
    }

    #[test]
    fn a_damaged_epic_manifest_costs_only_the_install_it_describes() {
        let manifests = format!("/home/tester/{EPIC_MANIFEST_DIRECTORY}");
        let mut entries = install_at("/home/tester/Games/Fallout 2");
        entries.push((format!("{manifests}/broken.item"), "{not json".to_owned()));
        let platform = platform_with(entries, MemoryOptions::default());

        let found = scan_for_installs(&platform, &[], now(), None);
        assert!(
            found
                .iter()
                .any(|i| Path::new(&i.path) == Path::new("/home/tester/Games/Fallout 2")),
            "the rest of the scan must survive: {found:?}"
        );
    }

    #[test]
    fn the_gog_registry_names_a_directory() {
        let platform = platform_with(
            install_at("/games/GOG/Fallout 2"),
            MemoryOptions {
                registry: BTreeMap::from([(
                    GOG_REGISTRY_KEYS[0].to_owned(),
                    BTreeMap::from([("path".to_owned(), "/games/GOG/Fallout 2".to_owned())]),
                )]),
                ..MemoryOptions::default()
            },
        );
        let found = scan_for_installs(&platform, &[], now(), None);
        assert!(
            found
                .iter()
                .any(|i| Path::new(&i.path) == Path::new("/games/GOG/Fallout 2")),
            "{found:?}"
        );
    }

    #[test]
    fn a_scan_writes_what_it_did_to_the_log() {
        let platform = platform_with(
            install_at("/home/tester/Games/Fallout 2"),
            MemoryOptions::default(),
        );
        scan_for_installs(&platform, &[], now(), None);
        let log = platform
            .text_at("/home/tester/.cache/zax/zax.log")
            .unwrap_or_default();
        assert!(log.contains("scan:"), "{log}");
        assert!(log.contains("1 new"), "{log}");
        assert!(log.contains("known location"), "{log}");
    }

    #[test]
    fn a_dotted_directory_is_not_searched() {
        let platform = platform_with(
            install_at("/home/tester/.hidden/Fallout 2"),
            MemoryOptions::default(),
        );
        assert!(scan_for_installs(&platform, &[], now(), None).is_empty());
    }

    #[test]
    fn a_directory_on_the_unsearchable_list_is_skipped() {
        let platform = platform_with(
            install_at("/home/tester/AppData/Fallout 2"),
            MemoryOptions::default(),
        );
        assert!(scan_for_installs(&platform, &[], now(), None).is_empty());
    }
}

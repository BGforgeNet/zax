//! The per-user state that is not a game config file: which installs ZAX knows about, how to launch
//! each, and the application's own preferences. The Python implementation kept this in `zax.yml`
//! under the platform config directory, and the shape here is the same one so an existing file still
//! loads.

/// Which mod is installed, decided by reading the directory rather than by anything the user tells
/// us.
///
/// The four patched types are two pairs, and the distinction is not cosmetic: killap's Unofficial
/// Patch and Restoration Project patch `data/` in place, while the Updated forks that descend from
/// them are separate mods distributed as a `mods/*.dat`. Calling either one "the unofficial patch"
/// mislabels the other.
///
/// `Fo1In2` is not a fifth patch but a different game: Fallout 1 rebuilt on this engine, in its own
/// directory.
/// Spelled across the boundary exactly as `as_str` spells it for `zax.yml`, so one name identifies a
/// type everywhere rather than one for the file and another for the interface.
#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    Hash,
    PartialOrd,
    Ord,
    serde::Serialize,
    serde::Deserialize,
    ts_rs::TS,
)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "lowercase")]
pub enum GameType {
    Fallout2,
    Fallout2Up,
    Fallout2Rp,
    Fallout2Upu,
    Fallout2Rpu,
    Fo1In2,
}

impl GameType {
    /// Every type, for a caller that has to cover them all.
    pub const ALL: [Self; 6] = [
        Self::Fallout2,
        Self::Fallout2Up,
        Self::Fallout2Rp,
        Self::Fallout2Upu,
        Self::Fallout2Rpu,
        Self::Fo1In2,
    ];

    /// The name this type is stored under in `zax.yml`, unchanged from the Python implementation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Fallout2 => "fallout2",
            Self::Fallout2Up => "fallout2up",
            Self::Fallout2Rp => "fallout2rp",
            Self::Fallout2Upu => "fallout2upu",
            Self::Fallout2Rpu => "fallout2rpu",
            Self::Fo1In2 => "fo1in2",
        }
    }

    /// Whether a name read out of a document is one this version knows how to detect.
    #[must_use]
    pub fn from_name(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|held| held.as_str() == value)
    }

    /// The install's default display name.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Fallout2 => "Fallout 2",
            Self::Fallout2Up => "Unofficial Patch",
            Self::Fallout2Rp => "Restoration Project",
            Self::Fallout2Upu => "Unofficial Patch Updated",
            Self::Fallout2Rpu => "Restoration Project Updated",
            Self::Fo1In2 => "Fallout et tu",
        }
    }

    /// The same thing said in full, for the tooltip.
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::Fallout2 => "Fallout 2",
            Self::Fallout2Up => "Fallout 2 with killap's Unofficial Patch",
            Self::Fallout2Rp => "Fallout 2 with killap's Restoration Project",
            Self::Fallout2Upu => "Fallout 2 with the Unofficial Patch Updated",
            Self::Fallout2Rpu => "Fallout 2 with the Restoration Project Updated",
            Self::Fo1In2 => "Fallout 1 in the Fallout 2 engine",
        }
    }

    #[must_use]
    pub const fn badge(self) -> &'static str {
        match self {
            Self::Fallout2 => "vanilla",
            Self::Fallout2Up => "up",
            Self::Fallout2Rp => "rp",
            Self::Fallout2Upu => "upu",
            Self::Fallout2Rpu => "rpu",
            Self::Fo1In2 => "fo1in2",
        }
    }
}

/// Wine settings are per install rather than global: one install can be a Windows build under its
/// own prefix while another is native, and a prefix that is right for one is wrong for the other.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
pub struct WineConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub debug: Option<String>,
}

impl WineConfig {
    /// Whether anything is set. An install the user never configured carries no Wine block at all.
    #[must_use]
    pub const fn is_empty(&self) -> bool {
        self.prefix.is_none() && self.debug.is_none()
    }

    /// The same settings with blank fields dropped, so clearing a field removes it instead of
    /// pinning it to an empty string.
    #[must_use]
    pub fn trimmed(&self) -> Self {
        fn kept(value: Option<&String>) -> Option<String> {
            let trimmed = value?.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_owned())
        }
        Self {
            prefix: kept(self.prefix.as_ref()),
            debug: kept(self.debug.as_ref()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
pub struct Install {
    pub path: String,
    /// Named `type` across the boundary, as the interface and `zax.yml` both spell it.
    #[serde(rename = "type")]
    pub game_type: GameType,
    /// What the user chose to call this install. `None` means the type's own name, which is what
    /// most use.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wine: Option<WineConfig>,
}

impl Install {
    /// An install as it joins the list, whether the user pointed at it or a scan turned it up, so
    /// both routes start it the same way.
    ///
    /// The Wine default is stored on Windows too: it costs one line nothing reads there, and it is
    /// already right if the folder is later opened from a machine that does use Wine.
    #[must_use]
    pub fn new(path: impl Into<String>, game_type: GameType) -> Self {
        Self {
            path: path.into(),
            game_type,
            alias: None,
            wine: Some(WineConfig {
                prefix: None,
                debug: Some(DEFAULT_WINE_DEBUG.to_owned()),
            }),
        }
    }

    /// What to call an install: the user's name for it, or the one its type carries.
    #[must_use]
    pub fn display_name(&self) -> &str {
        self.alias
            .as_deref()
            .unwrap_or_else(|| self.game_type.name())
    }
}

/// What a new install starts `WINEDEBUG` at.
///
/// Wine's default leaves `err` and `fixme` on, which is a stub notice for every unimplemented call
/// rather than anything diagnostic; clearing the field is what asks for them.
pub const DEFAULT_WINE_DEBUG: &str = "-all";

/// The one file every install ZAX recognises must have in its root.
///
/// Named rather than inlined because the interface points its picker at it: what the user is asked
/// to find has to be the same thing that decides. Lowercase, as the comparison is; a real install
/// may shout it, which is the caller's problem to allow.
pub const INSTALL_MARKER: &str = "fallout2.exe";

/// What killap's installers leave in the game folder.
///
/// These patches write into `data/` and add no `mods/*.dat`, so a root file is the only thing that
/// distinguishes them from an unpatched game. The Restoration Project comes first because it carries
/// the Unofficial Patch and leaves both files. This is the same test the Restoration Project's own
/// installer makes, which reads an install as the Unofficial Patch only when `up-changelog.txt` is
/// present and `rp-changelog.txt` is not.
const ROOT_MARKERS: &[(&str, GameType)] = &[
    ("rp-changelog.txt", GameType::Fallout2Rp),
    ("up-changelog.txt", GameType::Fallout2Up),
];

/// The type of install at a directory, or `None` when it is not a Fallout 2 install at all.
///
/// Takes listings rather than a path so the rule is testable without a filesystem: deciding what
/// counts as an install is domain logic, and only reading the directory needs the platform. Matching
/// is case-insensitive because the same install reads back differently through Wine than natively.
#[must_use]
pub fn detect_game_type(root_entries: &[String], mod_entries: &[String]) -> Option<GameType> {
    let root: Vec<String> = root_entries.iter().map(|e| e.to_lowercase()).collect();
    if !root.iter().any(|e| e == INSTALL_MARKER) {
        return None;
    }

    let mods: Vec<String> = mod_entries.iter().map(|e| e.to_lowercase()).collect();
    let holds = |name: &str| mods.iter().any(|e| e == name);

    // Fallout et tu replaces the game rather than patching it, and ships no marker of its own in the
    // root it shares with a stock Fallout 2 layout. Its core mod is what names it.
    if holds("fo1_base") {
        return Some(GameType::Fo1In2);
    }

    // The Updated forks next: each descends from a killap patch and can carry the files that
    // identify it, so testing killap's markers first would report the ancestor.
    if holds("rpu.dat") {
        return Some(GameType::Fallout2Rpu);
    }
    if holds("upu.dat") {
        return Some(GameType::Fallout2Upu);
    }

    for (marker, game_type) in ROOT_MARKERS {
        if root.iter().any(|e| e == marker) {
            return Some(*game_type);
        }
    }
    Some(GameType::Fallout2)
}

/// Installs are held sorted by path, so the list does not reorder itself as one is added or removed.
///
/// Ordered by bytes rather than by locale, which the TypeScript used: the same list would otherwise
/// sort differently on two machines.
fn sort_by_path(installs: &mut [Install]) {
    installs.sort_by(|a, b| a.path.cmp(&b.path));
}

/// Adds an install, refusing a duplicate rather than silently merging it.
///
/// The same path added twice would otherwise give two rows that edit one set of files and disagree
/// about what is on disk.
///
/// # Errors
///
/// Answers with wording for the user when the path is already on the list.
pub fn add_install(installs: &mut Vec<Install>, candidate: Install) -> Result<(), String> {
    if installs.iter().any(|held| held.path == candidate.path) {
        return Err("That install is already on the list.".to_owned());
    }
    installs.push(candidate);
    sort_by_path(installs);
    Ok(())
}

pub fn remove_install(installs: &mut Vec<Install>, path: &str) {
    installs.retain(|held| held.path != path);
}

/// Sets an install's Wine settings, dropping blank fields.
///
/// An install the user never configured does not carry two blank keys, and clearing a field removes
/// it instead of pinning it to an empty string.
pub fn set_wine(installs: &mut [Install], path: &str, wine: &WineConfig) {
    let Some(install) = installs.iter_mut().find(|held| held.path == path) else {
        return;
    };
    let kept = wine.trimmed();
    install.wine = if kept.is_empty() { None } else { Some(kept) };
}

/// Sets an install's alias, or clears it back to the type's name when given nothing.
///
/// The same drop-when-empty rule the Wine fields use, so clearing the field removes it rather than
/// pinning an empty string the display would then show in place of a name.
pub fn set_alias(installs: &mut [Install], path: &str, alias: &str) {
    let Some(install) = installs.iter_mut().find(|held| held.path == path) else {
        return;
    };
    let chosen = alias.trim();
    install.alias = (!chosen.is_empty()).then(|| chosen.to_owned());
}

/// Where an unattended scan looks, relative to each drive on Windows and to the home directory or a
/// Wine prefix elsewhere. Data rather than code so the platform layer decides how to walk it and the
/// list stays reviewable.
///
/// Every one of these is only a store's default, which the user is free to change - the launchers
/// that record where the game actually went are asked separately, and this list is what is left:
/// retail copies, installs made by hand, and machines whose launcher is not running or not
/// installed.
pub const SCAN_LOCATIONS: &[&str] = &[
    // GOG's offline installers use the first; Galaxy does not put games there.
    "GOG Games/Fallout 2",
    "Program Files (x86)/GOG Galaxy/Games/Fallout 2",
    // Steam's first library. Every other library is found through `libraryfolders.vdf` instead.
    "Program Files (x86)/Steam/steamapps/common/Fallout 2",
    // Epic, which gave the game away for a week in 2024 and so put it in a great many libraries.
    "Program Files/Epic Games/Fallout 2",
    // The Xbox app writes into a directory nothing may modify until the user enables mod support for
    // the game, at which point it moves it to one of these.
    "XboxGames/Fallout 2/Content",
    "Program Files/ModifiableWindowsApps/Fallout 2",
    // Heroic and Lutris, which is how a Linux machine usually holds a GOG or Epic copy.
    "Games/Heroic/Fallout 2",
    "Games/Fallout 2",
    "Games/Fallout2",
];

/// The folder Fallout et tu is unpacked into, inside a Fallout 2 install.
///
/// The game it converts is required, and its `master.dat` is what the mod reads. Nothing that looks
/// for a Fallout 2 install reaches it: the launchers name the install itself, and the shallow search
/// stops at the level that install sits on, so it is looked for under each install the scan knows
/// about instead.
pub const FO1IN2_DIRECTORY: &str = "Fallout1in2";

/// Where the Steam client itself may be, relative to a root. Only a starting point: whichever of
/// these exists names every library on the machine, including ones on other drives.
pub const STEAM_LOCATIONS: &[&str] = &[
    "Program Files (x86)/Steam",
    "Program Files/Steam",
    "Steam",
    "SteamLibrary",
    ".steam/steam",
    ".steam/root",
    ".local/share/Steam",
    ".var/app/com.valvesoftware.Steam/data/Steam",
];

/// Fallout 2 on Steam. Names the manifest that says which folder this machine's copy sits in.
pub const STEAM_APP_ID: &str = "38410";

/// Epic's per-game manifests, relative to a root. Each names the directory that game was installed
/// into.
pub const EPIC_MANIFEST_DIRECTORY: &str = "ProgramData/Epic/EpicGamesLauncher/Data/Manifests";

/// One registry value: the key it lives under, and its name within that key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RegistryValue {
    pub key: &'static str,
    pub value: &'static str,
}

/// Where Steam records its own location, for an install that is not under any of
/// [`STEAM_LOCATIONS`].
pub const STEAM_REGISTRY_KEY: RegistryValue = RegistryValue {
    key: "HKCU\\Software\\Valve\\Steam",
    value: "SteamPath",
};

/// Where Epic records the directory its `Manifests` folder sits in.
pub const EPIC_REGISTRY_KEY: RegistryValue = RegistryValue {
    key: "HKLM\\SOFTWARE\\WOW6432Node\\Epic Games\\EpicGamesLauncher",
    value: "AppDataPath",
};

/// Where GOG records an install's directory, one key per product.
///
/// Two of them because the store sells Fallout 2 as a pack: which id an install registers under
/// depends on which product was installed, and asking for a key that is not there costs nothing.
pub const GOG_REGISTRY_KEYS: &[&str] = &[
    "HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1440166436",
    "HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1440151285",
];

/// Directories the shallow search does not descend into, lowercased.
///
/// Each is either large enough to spend the whole budget on its own or somewhere no game is
/// installed, and none of them is where a user puts one.
pub const UNSEARCHABLE_DIRECTORIES: &[&str] = &[
    "windows",
    "winsxs",
    "$recycle.bin",
    "system volume information",
    "recovery",
    "appdata",
    "node_modules",
    "proc",
    "sys",
    "dev",
];

#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    Hash,
    Default,
    serde::Serialize,
    serde::Deserialize,
    ts_rs::TS,
)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    Light,
    Dark,
    #[default]
    System,
}

impl Theme {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Light => "light",
            Self::Dark => "dark",
            Self::System => "system",
        }
    }

    #[must_use]
    pub fn from_name(value: &str) -> Option<Self> {
        [Self::Light, Self::Dark, Self::System]
            .into_iter()
            .find(|held| held.as_str() == value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| (*v).to_owned()).collect()
    }

    #[test]
    fn a_directory_with_no_marker_is_not_an_install() {
        assert_eq!(detect_game_type(&names(&["readme.txt"]), &[]), None);
        assert_eq!(detect_game_type(&[], &[]), None);
    }

    #[test]
    fn the_marker_is_matched_however_it_is_spelled() {
        // The same install reads back differently through Wine than it does natively.
        assert_eq!(
            detect_game_type(&names(&["FALLOUT2.EXE"]), &[]),
            Some(GameType::Fallout2)
        );
    }

    #[test]
    fn a_bare_install_is_vanilla() {
        assert_eq!(
            detect_game_type(&names(&["fallout2.exe", "master.dat"]), &[]),
            Some(GameType::Fallout2)
        );
    }

    #[test]
    fn fallout_et_tu_is_named_by_its_core_mod() {
        // It ships no marker of its own in the root it shares with a stock Fallout 2 layout.
        assert_eq!(
            detect_game_type(&names(&["fallout2.exe"]), &names(&["fo1_base"])),
            Some(GameType::Fo1In2)
        );
    }

    #[test]
    fn an_updated_fork_is_not_reported_as_its_ancestor() {
        // Each descends from a killap patch and can carry the files that identify it.
        let root = names(&["fallout2.exe", "rp-changelog.txt", "up-changelog.txt"]);
        assert_eq!(
            detect_game_type(&root, &names(&["rpu.dat"])),
            Some(GameType::Fallout2Rpu)
        );
        assert_eq!(
            detect_game_type(&root, &names(&["upu.dat"])),
            Some(GameType::Fallout2Upu)
        );
    }

    #[test]
    fn the_restoration_project_wins_over_the_unofficial_patch_it_carries() {
        // The same test the Restoration Project's own installer makes.
        let both = names(&["fallout2.exe", "up-changelog.txt", "rp-changelog.txt"]);
        assert_eq!(detect_game_type(&both, &[]), Some(GameType::Fallout2Rp));

        let up_only = names(&["fallout2.exe", "up-changelog.txt"]);
        assert_eq!(detect_game_type(&up_only, &[]), Some(GameType::Fallout2Up));
    }

    #[test]
    fn every_type_round_trips_through_its_stored_name() {
        for game_type in GameType::ALL {
            assert_eq!(GameType::from_name(game_type.as_str()), Some(game_type));
            assert!(!game_type.name().is_empty());
            assert!(!game_type.label().is_empty());
            assert!(!game_type.badge().is_empty());
        }
        assert_eq!(GameType::from_name("fallout3"), None);
    }

    #[test]
    fn a_new_install_starts_with_wine_quietened() {
        let install = Install::new("/games/f2", GameType::Fallout2);
        assert_eq!(
            install.wine.as_ref().and_then(|w| w.debug.as_deref()),
            Some(DEFAULT_WINE_DEBUG)
        );
        assert_eq!(install.display_name(), "Fallout 2");
    }

    #[test]
    fn an_alias_replaces_the_types_name() {
        let mut install = Install::new("/games/f2", GameType::Fallout2);
        install.alias = Some("My playthrough".to_owned());
        assert_eq!(install.display_name(), "My playthrough");
    }

    #[test]
    fn installs_are_held_sorted_by_path() {
        let mut installs = Vec::new();
        add_install(&mut installs, Install::new("/b", GameType::Fallout2)).expect("add");
        add_install(&mut installs, Install::new("/a", GameType::Fallout2)).expect("add");
        assert_eq!(
            installs.iter().map(|i| i.path.as_str()).collect::<Vec<_>>(),
            vec!["/a", "/b"]
        );
    }

    #[test]
    fn the_same_path_twice_is_refused() {
        // Two rows editing one set of files would disagree about what is on disk.
        let mut installs = Vec::new();
        add_install(&mut installs, Install::new("/a", GameType::Fallout2)).expect("add");
        let again = add_install(&mut installs, Install::new("/a", GameType::Fallout2));
        assert_eq!(
            again,
            Err("That install is already on the list.".to_owned())
        );
        assert_eq!(installs.len(), 1);
    }

    #[test]
    fn removing_leaves_the_others() {
        let mut installs = Vec::new();
        add_install(&mut installs, Install::new("/a", GameType::Fallout2)).expect("add");
        add_install(&mut installs, Install::new("/b", GameType::Fallout2)).expect("add");
        remove_install(&mut installs, "/a");
        assert_eq!(installs.len(), 1);
        assert_eq!(installs[0].path, "/b");
        remove_install(&mut installs, "/nowhere");
        assert_eq!(installs.len(), 1);
    }

    #[test]
    fn clearing_a_wine_field_drops_it_rather_than_blanking_it() {
        let mut installs = vec![Install::new("/a", GameType::Fallout2)];
        set_wine(
            &mut installs,
            "/a",
            &WineConfig {
                prefix: Some("  ".to_owned()),
                debug: Some("+relay".to_owned()),
            },
        );
        let wine = installs[0].wine.as_ref().expect("a debug value remains");
        assert_eq!(wine.prefix, None);
        assert_eq!(wine.debug.as_deref(), Some("+relay"));
    }

    #[test]
    fn clearing_every_wine_field_drops_the_block() {
        let mut installs = vec![Install::new("/a", GameType::Fallout2)];
        set_wine(&mut installs, "/a", &WineConfig::default());
        assert_eq!(installs[0].wine, None);
    }

    #[test]
    fn an_alias_is_trimmed_and_an_empty_one_clears() {
        let mut installs = vec![Install::new("/a", GameType::Fallout2)];
        set_alias(&mut installs, "/a", "  Named  ");
        assert_eq!(installs[0].alias.as_deref(), Some("Named"));
        set_alias(&mut installs, "/a", "   ");
        assert_eq!(installs[0].alias, None);
        assert_eq!(installs[0].display_name(), "Fallout 2");
    }

    #[test]
    fn setting_wine_or_an_alias_on_a_path_that_is_not_listed_changes_nothing() {
        let mut installs = vec![Install::new("/a", GameType::Fallout2)];
        let before = installs.clone();
        set_alias(&mut installs, "/elsewhere", "Named");
        set_wine(&mut installs, "/elsewhere", &WineConfig::default());
        assert_eq!(installs, before);
    }

    #[test]
    fn a_theme_round_trips_through_its_stored_name() {
        for theme in [Theme::Light, Theme::Dark, Theme::System] {
            assert_eq!(Theme::from_name(theme.as_str()), Some(theme));
        }
        assert_eq!(Theme::from_name("neon"), None);
        assert_eq!(Theme::default(), Theme::System);
    }

    #[test]
    fn the_scan_tables_hold_no_duplicate_and_no_backslash() {
        // The lists are joined onto a root by the platform layer, which expects forward slashes.
        for table in [SCAN_LOCATIONS, STEAM_LOCATIONS] {
            let mut seen = std::collections::BTreeSet::new();
            for entry in table {
                assert!(seen.insert(*entry), "{entry} is listed twice");
                assert!(!entry.contains('\\'), "{entry} carries a backslash");
            }
        }
    }

    #[test]
    fn the_unsearchable_list_is_lowercase() {
        // It is compared against lowercased directory names, so an uppercase entry would never match.
        for entry in UNSEARCHABLE_DIRECTORIES {
            assert_eq!(*entry, entry.to_lowercase(), "{entry} is not lowercase");
        }
    }
}

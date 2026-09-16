//! The in-memory machine the browser preview edits.
//!
//! The desktop build reaches a real machine through the shell's commands. Opened in a browser there is
//! none, so this builds one over the in-memory seam seeded with the bundled fixture: everything that
//! only touches files works for real, and everything that reaches the network or starts a program says
//! it cannot. Recording a launch that never happened, or inventing a version number, would be worse
//! than refusing.

use std::collections::BTreeMap;
use std::path::Path;

use zax_fallout2::records::{InstallRecord, InstalledEngine, InstalledMod, save_record};
use zax_platform::memory::{Content, MemoryOptions, MemoryPlatform, Response};
use zax_platform::process::{LaunchOptions, ProcessIdentity, ProcessLauncher, RunOutcome};
use zax_platform::{Error, Platform, Result};

/// The install the preview edits, named for what it is rather than as a plausible home directory.
pub const PREVIEW_INSTALL: &str = "fixtures/f2up";

const FALLOUT2_CFG: &str = include_str!("../../../fixtures/f2up/fallout2.cfg");
const F2_RES_INI: &str = include_str!("../../../fixtures/f2up/f2_res.ini");
const DDRAW_INI: &str = include_str!("../../../fixtures/f2up/ddraw.ini");

// The ini FO2tweaks' release ships, verbatim, and a manifest for it written here - the mod publishes
// none of its own yet. Describing the real ini is what makes the settings surface worth showing; the
// document being ours is why the feed below records that this repository carries no manifest.
const FO2TWEAKS_MANIFEST: &str = include_str!("../../../fixtures/fo2tweaks/f2mod.yml");
const FO2TWEAKS_INI: &str = include_str!("../../../fixtures/fo2tweaks/mods/fo2tweaks.ini");

// Real release listings, captured from each repository's own API and cut to the fields ZAX reads plus
// the newest releases of each line. Seeded as network answers below so the mods tab performs its real
// read: a listing states what exists and does nothing with it, so a real capture of one is not the
// invented version number the rest of this seam refuses to produce.
const RPU_FEED: &str =
    include_str!("../../../fixtures/preview/feeds/BGforgeNet-Fallout2_Restoration_Project.json");
const UPU_FEED: &str =
    include_str!("../../../fixtures/preview/feeds/BGforgeNet-Fallout2_Unofficial_Patch.json");
const FO1IN2_FEED: &str = include_str!("../../../fixtures/preview/feeds/rotators-Fo1in2.json");
const FO2TWEAKS_FEED: &str =
    include_str!("../../../fixtures/preview/feeds/BGforgeNet-FO2tweaks.json");

/// One seeded game folder: where it is, what makes it read as the type it is meant to be, and the
/// version it states where that differs from the shared fixture's.
struct PreviewGame {
    path: &'static str,
    marks: &'static [&'static str],
    stamp: Option<&'static str>,
}

/// One install per game type, so every badge, every type-gated refusal and every base mod's
/// eligibility is reachable in a browser. Only `f2up` carries a mods folder and a record - the rest
/// exist to be a list with something in it and to be selected - but each is detected the way a real one
/// is, from the marker files its type is actually known by rather than from anything declared here.
const PREVIEW_GAMES: &[PreviewGame] = &[
    // First because the interface opens on it: this is the one with a mods folder, a record and an
    // engine already deployed, so the preview starts on the install that has something to show.
    PreviewGame {
        path: PREVIEW_INSTALL,
        marks: &["up-changelog.txt"],
        stamp: None,
    },
    PreviewGame {
        path: "fixtures/f2",
        marks: &[],
        stamp: None,
    },
    PreviewGame {
        path: "fixtures/f2rp",
        marks: &["rp-changelog.txt"],
        stamp: None,
    },
    PreviewGame {
        path: "fixtures/f2upu",
        marks: &["mods/upu.dat"],
        stamp: None,
    },
    PreviewGame {
        path: "fixtures/f2rpu",
        marks: &["mods/rpu.dat"],
        stamp: None,
    },
    // A directory in a real install, holding the Fallout 1 data the conversion runs on; the type is
    // read off the entry's name, so what is under it only has to make the directory exist.
    //
    // Stamped with a Fallout et tu version rather than the sfall one every other fixture shares: this
    // install states its own, and a release behind the feed's is what a user of it usually has - which
    // is the state its mod row is about.
    PreviewGame {
        path: "fixtures/fo1in2",
        marks: &["mods/fo1_base/fo1_base.dat"],
        stamp: Some("FALLOUT ET TU v1.15.3735"),
    },
];

/// The captured listing for each repository, by the address the feed reader asks for.
fn captured_feeds() -> BTreeMap<String, &'static str> {
    [
        ("BGforgeNet/Fallout2_Restoration_Project", RPU_FEED),
        ("BGforgeNet/Fallout2_Unofficial_Patch", UPU_FEED),
        ("rotators/Fo1in2", FO1IN2_FEED),
        ("BGforgeNet/FO2tweaks", FO2TWEAKS_FEED),
    ]
    .into_iter()
    .map(|(repository, body)| (repository.to_owned(), body))
    .collect()
}

/// The repositories this fixture holds a manifest for. FO2tweaks does not publish an `f2mod.yml` yet;
/// the fixture is the document it would publish, and the same one the seeded record carries, so what
/// the preview shows of a described mod is what a real read would give once it does. The three base
/// mods stay on the note instead, which is the answer their tags really give.
const CAPTURED_MANIFESTS: &[(&str, &str)] = &[("BGforgeNet/FO2tweaks", FO2TWEAKS_MANIFEST)];

/// Every tag a captured listing names, which is what a manifest is asked for per release.
fn tags_in(body: &str) -> Vec<String> {
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(body) else {
        return Vec::new();
    };
    parsed
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|release| release.get("tag_name")?.as_str().map(str::to_owned))
        .collect()
}

/// The state file a fresh preview starts from.
fn preview_state() -> String {
    let games: String = PREVIEW_GAMES
        .iter()
        .map(|game| format!("- path: {}\n", game.path))
        .collect();
    format!("games:\n{games}theme: system\n")
}

/// Every file that makes one of those directories read as the install it is meant to be.
fn game_files(files: &mut BTreeMap<String, Content>) {
    for game in PREVIEW_GAMES {
        files.insert(
            format!("{}/fallout2.cfg", game.path),
            Content::from(FALLOUT2_CFG),
        );
        files.insert(
            format!("{}/f2_res.ini", game.path),
            Content::from(F2_RES_INI),
        );
        // One line of the shared file rewritten where a game states its own version, so the fixture
        // keeps every sfall setting the tabs edit and differs only in what it says it is.
        let ddraw = match game.stamp {
            None => DDRAW_INI.to_owned(),
            Some(stamp) => DDRAW_INI
                .lines()
                .map(|line| {
                    if line.starts_with("VersionString=") {
                        format!("VersionString={stamp}")
                    } else {
                        line.to_owned()
                    }
                })
                .collect::<Vec<String>>()
                .join("\n"),
        };
        files.insert(format!("{}/ddraw.ini", game.path), Content::from(ddraw));
        files.insert(format!("{}/fallout2.exe", game.path), Content::from(""));
        for mark in game.marks {
            files.insert(format!("{}/{mark}", game.path), Content::from(""));
        }
    }
}

/// A mods folder covering every state the mods view has: one loaded, one commented out, one folder
/// rather than an archive, an entry whose file is gone, one sitting in the folder that the order file
/// never names, and one the record claims - the only kind that shows an owner. Two entries are gone
/// rather than one, which is the state the bulk forget is offered in; the last two are the two the
/// shipped recommendation ranks, seeded the wrong way round, which is what the load-order advice has to
/// say something about.
///
/// The two `mod_` names are here for the Fission sub-tab, which splits this folder by what that
/// engine's own folder scan would find. One of the two is commented out, which that tab lists all the
/// same: the marker is sfall's and the folder scan Fission runs does not read it.
const MODS_ORDER: &str = "; Loaded in this order - a mod further down overrides one above it.\n\
     weapon_sounds.dat\n; extra_music.dat\nhero_appearance\nold_patch.dat\nold_music.dat\n\
     InventoryFilter.dat\nfo2tweaks.dat\nmod_combat_speed.dat\n; mod_dialog_fix.dat\n";

/// A second folder, left as Fission last wrote it. The Mods tab stands down over an order file in a
/// format ZAX cannot edit, and that state is only reachable by having one - the preview refuses a
/// launch, which is the only thing that would otherwise put a folder into it.
const FISSION_ORDER: &str = "# FISSION mods_order.txt (pipe-separated)\n\
     # Format: enabled|datName|internalName|displayName|author|description|dependencies|iconIndex\n\
     1|combat_speed|combat_speed|Combat Speed|Some Author|Faster combat| |7\n\
     0|dialog_fix|dialog_fix|Dialog Fix|Some Author|Fixes dialog| |3\n";

/// The manifest for the mod the record claims but no feed follows.
const WEAPON_SOUNDS_MANIFEST: &str = "spec: 1\nid: weapon-sounds\nname: Weapon Sounds\n\
     version: \"2.1\"\ngame: fallout2\n\
     description: Replacement firing sounds for every weapon in the game.\n\
     forum: https://forums.bgforge.net/viewforum.php?f=26\n";

/// The machine the preview runs on, seeded and ready to read.
///
/// # Errors
///
/// Fails only where the seeded record cannot be written, which is a fault in this fixture rather than
/// anything a user did.
pub fn preview_platform() -> Result<PreviewPlatform> {
    let mut files: BTreeMap<String, Content> = BTreeMap::new();
    game_files(&mut files);

    for (at, body) in [
        (format!("{PREVIEW_INSTALL}/mods/mods_order.txt"), MODS_ORDER),
        (
            format!("{PREVIEW_INSTALL}/mods/fo2tweaks.ini"),
            FO2TWEAKS_INI,
        ),
        (
            "fixtures/f2rpu/mods/mods_order.txt".to_owned(),
            FISSION_ORDER,
        ),
        (
            "fixtures/f2rpu/mods/mods_order.sfall.txt".to_owned(),
            "rpu.dat\nbarter_prices.dat\n",
        ),
        ("preview/config/zax.yml".to_owned(), &preview_state()),
    ] {
        files.insert(at, Content::from(body));
    }
    for at in [
        format!("{PREVIEW_INSTALL}/mods/InventoryFilter.dat"),
        format!("{PREVIEW_INSTALL}/mods/fo2tweaks.dat"),
        format!("{PREVIEW_INSTALL}/mods/weapon_sounds.dat"),
        format!("{PREVIEW_INSTALL}/mods/extra_music.dat"),
        format!("{PREVIEW_INSTALL}/mods/barter_prices.dat"),
        format!("{PREVIEW_INSTALL}/mods/mod_combat_speed.dat"),
        format!("{PREVIEW_INSTALL}/mods/mod_dialog_fix.dat"),
        format!("{PREVIEW_INSTALL}/mods/hero_appearance/art/critters/hmjmps.frm"),
        // What the engine record claims is deployed here. Present, or reconciliation reads it as
        // removed.
        format!("{PREVIEW_INSTALL}/fallout-fission-linux-x64"),
        format!("{PREVIEW_INSTALL}/fission.dat"),
        "fixtures/f2rpu/mods/mod_combat_speed.dat".to_owned(),
        "fixtures/f2rpu/mods/mod_dialog_fix.dat".to_owned(),
        "fixtures/f2rpu/mods/barter_prices.dat".to_owned(),
    ] {
        files.insert(at, Content::from(""));
    }

    // Seeded as network answers rather than straight into the feed cache because the in-memory seam
    // keeps a fixed clock: a file it writes always reads as stale and the fetch happens anyway.
    let mut responses: BTreeMap<String, Response> = BTreeMap::new();
    let feeds = captured_feeds();
    for (repository, body) in &feeds {
        responses.insert(
            format!("https://api.github.com/repos/{repository}/releases?per_page=100"),
            Response::Body((*body).to_owned()),
        );
    }
    // Answered for every tag of the repository that has one: the manifest is committed rather than
    // stamped per release, so which tag was asked for decides the version rather than the document.
    for (repository, manifest) in CAPTURED_MANIFESTS {
        let Some(body) = feeds.get(*repository) else {
            continue;
        };
        for tag in tags_in(body) {
            responses.insert(
                format!("https://raw.githubusercontent.com/{repository}/{tag}/f2mod.yml"),
                Response::Body((*manifest).to_owned()),
            );
        }
    }

    // What each engine's cached archive unpacks to, keyed by the text the cache writes into it, so
    // picking a build on the Engines tab deploys for real. Without contents the preflight refuses the
    // archive, and a refused archive is deleted from the cache - the build would vanish from the tab on
    // the first pick.
    let archives = BTreeMap::from([
        (
            "preview fallout2-ce".to_owned(),
            BTreeMap::from([
                (
                    "fallout2-ce-linux-x64/fallout2-ce".to_owned(),
                    Content::from("preview"),
                ),
                (
                    "fallout2-ce-linux-x64/ce.dat".to_owned(),
                    Content::from("preview"),
                ),
            ]),
        ),
        (
            "preview fission".to_owned(),
            BTreeMap::from([
                (
                    "fallout-fission-linux-x64".to_owned(),
                    Content::from("preview"),
                ),
                ("fission.dat".to_owned(), Content::from("preview")),
            ]),
        ),
    ]);

    let platform = MemoryPlatform::new(MemoryOptions {
        home: Some("preview".to_owned()),
        config: Some("preview/config".to_owned()),
        cache: Some("preview/cache".to_owned()),
        files,
        responses,
        archives,
        ..MemoryOptions::default()
    });

    seed_record(&platform)?;
    seed_cached_builds(&platform)?;
    seed_absent_manifests(&platform, &feeds)?;
    Ok(PreviewPlatform {
        process: PreviewProcess {
            identity: ProcessIdentity {
                host: "preview".to_owned(),
                pid: 1,
            },
        },
        memory: platform,
    })
}

/// The record is what makes the seeded ini an installed mod rather than clutter. Written through the
/// real writer so the preview holds a record the desktop build could have made.
fn seed_record(platform: &MemoryPlatform) -> Result<()> {
    use zax_fallout2::manifest::ModType;

    save_record(
        platform,
        &InstallRecord {
            path: PREVIEW_INSTALL.to_owned(),
            mods: vec![
                InstalledMod {
                    id: "fo2tweaks".to_owned(),
                    // The release the fixture was taken from. The manifest states no version of its
                    // own - a committed one takes it from the release tag - so refreshing the fixture
                    // means moving this with it.
                    version: "14.7".to_owned(),
                    // What an install writes, and what a removal is judged against - a record without
                    // it is one an older version left, which the preview is not pretending to be.
                    mod_type: Some(ModType::Pluggable),
                    reason: None,
                    complete: true,
                    files: vec![
                        "mods/fo2tweaks.dat".to_owned(),
                        "mods/fo2tweaks.ini".to_owned(),
                    ],
                    entries: Vec::new(),
                    parts: Vec::new(),
                    manifest: FO2TWEAKS_MANIFEST.to_owned(),
                    shipped: BTreeMap::from([(
                        "mods/fo2tweaks.ini".to_owned(),
                        FO2TWEAKS_INI.to_owned(),
                    )]),
                    carried: BTreeMap::new(),
                },
                // A mod ZAX installed that no feed follows any more - an id retired from the list, or
                // renamed upstream. Its row is drawn from this record alone, which is the state that
                // keeps Remove reachable for a mod the tab would otherwise have no line for at all.
                //
                // The manifest names a forum, and the row still offers no button for it: the address is
                // resolved from a held release, and having none is what makes the row unfollowed.
                InstalledMod {
                    id: "weapon-sounds".to_owned(),
                    version: "2.1".to_owned(),
                    mod_type: Some(ModType::Pluggable),
                    reason: None,
                    complete: true,
                    files: vec!["mods/weapon_sounds.dat".to_owned()],
                    // Declared rather than derived, since the id carries no underscore and the entry
                    // does.
                    entries: vec!["weapon_sounds.dat".to_owned()],
                    parts: Vec::new(),
                    manifest: WEAPON_SOUNDS_MANIFEST.to_owned(),
                    shipped: BTreeMap::new(),
                    carried: BTreeMap::new(),
                },
            ],
            // Fission deployed in this folder, which is what the Mods tab's Fission sub-tab follows:
            // the machine's cache says one could be run here, the record says one has been. The files
            // are what the deployment put there, and reconciliation checks they are still present.
            engines: vec![InstalledEngine {
                id: "fission".to_owned(),
                release: "beta-0.9.6.8".to_owned(),
                published: "2026-06-14T00:00:00Z".to_owned(),
                complete: true,
                files: vec![
                    "fallout-fission-linux-x64".to_owned(),
                    "fission.dat".to_owned(),
                ],
                backup: None,
                commit: None,
                pinned: false,
            }],
            written: BTreeMap::new(),
            opaque: Vec::new(),
            later_format: None,
        },
    )
}

/// Builds of both engines, so the Run button's chooser has something to choose between, the Engines tab
/// has rows, and the surfaces that only exist for an engine the machine can run are reachable here
/// rather than only in the desktop build. Written the way the cache writes them - the archive, and the
/// note naming what it is - rather than through a download the preview refuses.
fn seed_cached_builds(platform: &MemoryPlatform) -> Result<()> {
    for (engine, asset, release, published) in [
        (
            "fallout2-ce",
            "fallout2-ce-linux-x64.tar.gz",
            "continious",
            "2026-07-01T00:00:00Z",
        ),
        (
            "fallout2-ce",
            "fallout2-ce-linux-x64.tar.gz",
            "continious",
            "2026-08-23T09:37:22Z",
        ),
        (
            "fission",
            "fallout-fission-linux-x64.zip",
            "beta-0.9.6.8",
            "2026-06-14T00:00:00Z",
        ),
    ] {
        let key: String = published.chars().filter(char::is_ascii_digit).collect();
        let at = format!("preview/cache/packages/engines/{engine}/{key}");
        platform.fs().write(
            Path::new(&format!("{at}/{asset}")),
            format!("preview {engine}").as_bytes(),
        )?;
        let note =
            serde_json::json!({ "release": release, "published": published, "commit": null });
        platform.fs().write(
            Path::new(&format!("{at}/release.json")),
            note.to_string().as_bytes(),
        )?;
    }
    Ok(())
}

/// Per release, the note that its author publishes no manifest of their own - which is what sends the
/// base mods to the documents ZAX carries for exactly that case. True of the three: none of those
/// repositories has an `f2mod.yml`, at the tag or on its default branch, so the note records the answer
/// the network would give. The fourth is answered above instead, and a note here would stop it ever
/// being asked for.
fn seed_absent_manifests(
    platform: &MemoryPlatform,
    feeds: &BTreeMap<String, &'static str>,
) -> Result<()> {
    let described: Vec<&str> = CAPTURED_MANIFESTS.iter().map(|(at, _)| *at).collect();
    for (repository, body) in feeds {
        if described.contains(&repository.as_str()) {
            continue;
        }
        for tag in tags_in(body) {
            let at = zax_fallout2::mod_feed::feed_cache_path(platform, repository, Some(&tag));
            let mut marker = at.into_os_string();
            marker.push(".none");
            platform.fs().write(Path::new(&marker), &[])?;
        }
    }
    Ok(())
}

/// What the preview refuses, in the words the interface shows.
pub const PREVIEW_REASON: &str =
    "The browser preview has no machine to reach - this needs the desktop build.";

/// The in-memory machine with its process launcher replaced.
///
/// Nothing a process does can be simulated honestly: a recorded launch and an invented release both
/// read as success. The in-memory seam records a launch, which is right for a test asserting on the
/// record and wrong here - so the preview refuses instead. `alive` answers rather than refusing, and
/// answers false: the preview starts no programs, so no id it could be asked about is running, and a
/// refusal there would be a lock nothing could ever read past.
#[derive(Debug)]
pub struct PreviewPlatform {
    memory: MemoryPlatform,
    process: PreviewProcess,
}

#[derive(Debug)]
struct PreviewProcess {
    identity: ProcessIdentity,
}

fn refuses<T>() -> Result<T> {
    Err(Error::Unsupported(PREVIEW_REASON.to_owned()))
}

impl ProcessLauncher for PreviewProcess {
    fn identity(&self) -> &ProcessIdentity {
        &self.identity
    }

    fn launch(
        &self,
        _program: &Path,
        _args: &[String],
        _options: &LaunchOptions<'_>,
    ) -> Result<()> {
        refuses()
    }

    fn run(
        &self,
        _program: &Path,
        _args: &[String],
        _options: &LaunchOptions<'_>,
    ) -> Result<RunOutcome> {
        refuses()
    }

    fn open(&self, _target: &Path) -> Result<()> {
        refuses()
    }

    fn alive(&self, _pid: u32) -> Result<bool> {
        Ok(false)
    }

    fn command_of(&self, _pid: u32) -> Result<Option<String>> {
        Ok(None)
    }
}

impl Platform for PreviewPlatform {
    fn os(&self) -> zax_platform::OperatingSystem {
        self.memory.os()
    }

    fn arch(&self) -> zax_platform::Architecture {
        self.memory.arch()
    }

    fn fs(&self) -> &dyn zax_platform::fs::FileSystem {
        self.memory.fs()
    }

    fn paths(&self) -> &dyn zax_platform::paths::Paths {
        self.memory.paths()
    }

    fn process(&self) -> &dyn ProcessLauncher {
        &self.process
    }

    fn net(&self) -> &dyn zax_platform::net::Network {
        self.memory.net()
    }

    fn archive(&self) -> &dyn zax_platform::archive::Archive {
        self.memory.archive()
    }

    fn hash(&self) -> &dyn zax_platform::hash::Hashing {
        self.memory.hash()
    }

    fn registry(&self) -> &dyn zax_platform::registry::Registry {
        // Answers nothing, which is the truth rather than a refusal: a browser has no registry, and
        // "no such key" is what a scan does with every machine that has none of these launchers.
        self.memory.registry()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use zax_core::install::GameType;
    use zax_core::state::load_state;
    use zax_fallout2::records::load_record;

    #[test]
    fn the_preview_opens_on_an_install_with_something_to_show() {
        let platform = preview_platform().expect("the fixture seeds");
        let held = load_state(&platform).expect("a state file");
        assert_eq!(held.state.installs.len(), PREVIEW_GAMES.len());
        assert_eq!(held.state.installs[0].path, PREVIEW_INSTALL);
        assert_eq!(held.problem, None);
    }

    #[test]
    fn every_seeded_folder_is_detected_as_the_type_it_is_meant_to_be() {
        // From the marker files the type is actually known by, rather than from anything declared.
        let platform = preview_platform().expect("the fixture seeds");
        let held = load_state(&platform).expect("a state file");
        let types: Vec<GameType> = held
            .state
            .installs
            .iter()
            .map(|one| one.game_type)
            .collect();
        assert!(types.contains(&GameType::Fallout2), "{types:?}");
        assert!(types.contains(&GameType::Fallout2Up), "{types:?}");
        assert!(types.contains(&GameType::Fallout2Rp), "{types:?}");
        assert!(types.contains(&GameType::Fallout2Upu), "{types:?}");
        assert!(types.contains(&GameType::Fallout2Rpu), "{types:?}");
        assert!(types.contains(&GameType::Fo1In2), "{types:?}");
    }

    #[test]
    fn the_record_makes_the_seeded_ini_an_installed_mod() {
        let platform = preview_platform().expect("the fixture seeds");
        let record = load_record(&platform, PREVIEW_INSTALL).expect("a record");
        assert_eq!(record.mods.len(), 2);
        assert!(record.mods.iter().any(|one| one.id == "fo2tweaks"));
        // And a mod no feed follows, which is what keeps Remove reachable for one.
        assert!(record.mods.iter().any(|one| one.id == "weapon-sounds"));
        assert_eq!(record.engines.len(), 1);
    }

    #[test]
    fn the_captured_listings_are_answered_at_the_address_the_reader_asks_for() {
        let platform = preview_platform().expect("the fixture seeds");
        let held = platform
            .net()
            .fetch_text("https://api.github.com/repos/BGforgeNet/FO2tweaks/releases?per_page=100")
            .expect("a captured listing");
        assert!(held.contains("tag_name"), "{held:.80}");
    }

    #[test]
    fn a_repository_that_publishes_no_manifest_says_so_rather_than_being_asked_per_release() {
        let platform = preview_platform().expect("the fixture seeds");
        let tags = tags_in(RPU_FEED);
        assert!(!tags.is_empty(), "the captured listing names releases");
        for tag in tags {
            let at = zax_fallout2::mod_feed::feed_cache_path(
                &platform,
                "BGforgeNet/Fallout2_Restoration_Project",
                Some(&tag),
            );
            let mut marker = at.into_os_string();
            marker.push(".none");
            assert!(
                platform
                    .fs()
                    .stat(Path::new(&marker))
                    .expect("a read")
                    .is_some(),
                "{tag} has no note"
            );
        }
    }

    #[test]
    fn the_mods_folder_covers_every_state_the_view_has() {
        let platform = preview_platform().expect("the fixture seeds");
        let install = zax_core::install::Install::new(PREVIEW_INSTALL, GameType::Fallout2Up);
        let snapshot = zax_fallout2::mods::read_mods(&platform, &install).expect("a reading");
        let listed = zax_fallout2::mods::list_mods(&snapshot);
        // One enabled, one commented out, a folder, two the folder no longer holds, and one the file
        // never names.
        assert!(listed.iter().any(|one| one.enabled));
        assert!(listed.iter().any(|one| !one.enabled));
        assert!(
            listed
                .iter()
                .any(|one| one.kind == zax_fallout2::mods::ModKind::Folder)
        );
        assert!(
            listed
                .iter()
                .filter(|one| one.kind == zax_fallout2::mods::ModKind::Missing)
                .count()
                >= 2
        );
        assert!(listed.iter().any(|one| one.owner.is_some()));
    }

    #[test]
    fn the_second_folder_is_left_in_the_format_zax_cannot_edit() {
        // The Mods tab stands down over one, and a launch is the only other way to reach that state.
        let platform = preview_platform().expect("the fixture seeds");
        let install = zax_core::install::Install::new("fixtures/f2rpu", GameType::Fallout2Rpu);
        let snapshot = zax_fallout2::mods::read_mods(&platform, &install).expect("a reading");
        assert_eq!(
            snapshot.format,
            Some(zax_fallout2::mods::OrderFormat::Fission)
        );
    }

    #[test]
    fn the_machine_holds_a_build_of_each_engine() {
        let platform = preview_platform().expect("the fixture seeds");
        for (id, asset, held) in [
            ("fallout2-ce", "fallout2-ce-linux-x64.tar.gz", 2),
            ("fission", "fallout-fission-linux-x64.zip", 1),
        ] {
            let engine = zax_fallout2::engines::engine_by_id(id).expect("a named engine");
            let cached = zax_fallout2::engine_release::cached_engines(&platform, engine, asset)
                .expect("a listing");
            assert_eq!(cached.len(), held, "{id}");
        }
    }
}

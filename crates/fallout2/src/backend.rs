//! Everything the interface asks the machine to do, as one flat list of operations.
//!
//! This is what crosses the process boundary in the desktop build, which is why it is operations
//! rather than the platform interface itself. Three reasons. Path joining is a pure computation and
//! proxying it over a channel would be absurd. One user action becomes one message instead of the
//! dozens a file-by-file proxy would send. And the privileged surface a renderer can reach is an
//! enumerable list rather than "any file".
//!
//! Composed here because these are operations on a Fallout 2 install: the config files, sfall, the
//! debug archive.
//!
//! Every method is synchronous, as the seam under it is. The command layer in the shell crate is where
//! a long one moves off the thread that draws.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use zax_core::catalog::SettingDef;
use zax_core::config_io::{
    ConfigChange, ConfigFileContents, SaveOutcome, SaveRequest, load_config_files,
    save_config_files,
};
use zax_core::directories::{backup_directory, debug_directory, log_file, package_directory};
use zax_core::discovery::{identify_install, scan_for_installs};
use zax_core::install::{GameType, Install};
use zax_core::stamp::{LocalTime, Utc};
use zax_core::state::{AppState, LoadedState, load_state, save_state};
use zax_core::updates::{ZaxRelease, latest_zax};
use zax_platform::net::{DownloadOptions, DownloadProgress};
use zax_platform::process::LaunchOptions;
use zax_platform::{Error, OperatingSystem, Platform, Result};

use crate::catalog::settings;
use crate::debug_package::{DebugPackage, create_debug_package, list_saves};
use crate::engine_choice::BuildPick;
use crate::engine_choice::choose_build;
use crate::engine_config::engine_config_paths;
use crate::engine_install::{EngineChoice, install_cached_engine, installed_engines, pin_engine};
use crate::engine_release::{
    CachedEngine, EngineProgress, EngineRelease, cached_engines, engine_named, engine_releases,
    fetch_engine_build, forget_engine,
};
use crate::engines::{ENGINES, ReleaseModel, build_for};
use crate::files::CONFIG_FILES;
use crate::hires::installed_hires_version;
use crate::install_lock::still_running;
use crate::launch::{game_program, plan_launch};
use crate::manifest::{DroppedSetting, ManifestDefaults, ModSetting, may_write, parse_manifest};
use crate::mod_asset::ModProgress;
use crate::mod_base::{BaseInstallOutcome, BaseInstallPlan, apply_base_install, plan_base_install};
use crate::mod_create::{
    CreateInstallOutcome, CreateInstallPlan, apply_create_install, plan_create_install,
};
use crate::mod_feed::{
    FeedSource, MOD_FEEDS, ModFeedListing, ModInstallState, ModRelease, compare_in_line,
    fetch_feed, fetch_feed_at, list_mod_versions, read_mod_feeds, read_mod_install_state,
};
use crate::mod_grants::grants_for;
use crate::mod_install::{
    ModInstallOutcome, ModInstallPlan, ModRemoval, apply_mod_install, plan_mod_install,
    restore_mod_install, uninstall_mod,
};
use crate::mod_transaction::{read_transaction, release_of};
use crate::mods::{
    ModsSaveRequest, ModsSnapshot, OrderFormat, OrderSwap, preview_order_swap, read_mods,
    save_mods, swap_order_to,
};
use crate::reconcile_settings::{HeldTarget, address, address_of};
use crate::records::{InstalledEngine, load_record, reconcile_record, save_record};
mod app;

pub use app::{
    Answered, AppView, InstallReport, ModInstallRequest, OrderEdit, ReadingView, SaveRefusal,
    SettingEdit, SettingValue, Started,
};

use crate::sfall::{
    SfallProgress, SfallRelease, SfallUpdate, installed_sfall_version, latest_sfall,
    list_sfall_versions, update_sfall,
};

/// The application's own directories, and which machine this is. Read once, at startup.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct MachineDescription {
    pub os: OperatingSystem,
    pub backup_directory: String,
    pub debug_directory: String,
    pub package_directory: String,
    pub log_file: String,
}

/// One of ZAX's own directories, named rather than passed as a path so a renderer cannot ask for
/// another.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "lowercase")]
pub enum OwnDirectory {
    Backup,
    Debug,
    Packages,
}

/// Something of ZAX's own the user can empty. The log is a file rather than a directory, hence its own
/// arm.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(tag = "what", rename_all = "lowercase")]
pub enum WipeTarget {
    Own { directory: OwnDirectory },
    Log,
}

/// Which of a mod's own pages to open.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "lowercase")]
pub enum ModPage {
    Forum,
    Homepage,
}

/// Somewhere the desktop's own handler is asked to open. Named for the same reason: a mod's page is
/// asked for by naming which page of which mod, never by handing over the address, so what is opened is
/// always something ZAX itself read rather than something a caller supplied.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(tag = "what", rename_all = "lowercase")]
pub enum OpenTarget {
    Own { directory: OwnDirectory },
    Log,
    Download,
    Mod { id: String, page: ModPage },
}

pub const RELEASES_PAGE: &str = "https://github.com/BGforgeNet/zax/releases/latest";

/// One installed mod's configuration surface: who it belongs to, and the schema its record carries.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct ModSettingsGroup {
    pub mod_id: String,
    pub name: String,
    /// The ini files the schema describes - what the open-the-file affordance opens.
    pub files: Vec<String>,
    pub settings: Vec<ModSetting>,
    /// Entries the schema declares that this version cannot draw. Carried so the surface can say what
    /// is missing and why: a control quietly absent reads as a mod that never offered it.
    pub dropped: Vec<DroppedSetting>,
}

/// One build the machine holds, as a version list needs it. Addressed by `published`, not by tag.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct CachedBuild {
    /// The release's tag, as published. A rolling project republishes one, so it does not identify a
    /// build.
    pub release: String,
    /// When it was published, ISO 8601. The key a build is asked for by.
    pub published: String,
    pub commit: Option<String>,
}

/// What this machine would install of one engine, where it publishes a build for it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct MachineBuild {
    pub asset: String,
    pub program: String,
}

/// One engine as the Engines tab needs it: what it is, what this machine would install, and which
/// builds it already holds. Nothing here is a game folder's business - what is deployed in one is
/// `deployed_engines`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct EngineListing {
    pub id: String,
    pub name: String,
    pub short: String,
    pub page: String,
    /// How the project publishes, which decides whether a build is named to the user by tag or by date.
    pub releases: ReleaseModel,
    /// What would be installed here, or nothing with `why` saying there is none.
    pub build: Option<MachineBuild>,
    pub why: Option<String>,
    /// What has to be said before running this engine, from the catalog. Absent for one that needs
    /// nothing said.
    pub caution: Option<String>,
    /// What this machine holds, newest first. Empty is an engine nothing has fetched yet.
    pub versions: Vec<CachedBuild>,
}

/// What a plan resolved to, whichever of the three shapes an install takes.
///
/// Tagged with the kind the TypeScript carried on each of the three plans, so the interface tells them
/// apart by reading one field rather than by which others are present.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum InstallPlan {
    Stacking(ModInstallPlan),
    Base(BaseInstallPlan),
    Creates(CreateInstallPlan),
}

impl InstallPlan {
    /// What the install compares against what was confirmed.
    #[must_use]
    pub fn fingerprint(&self) -> &str {
        match self {
            Self::Stacking(plan) => &plan.fingerprint,
            Self::Base(plan) => &plan.fingerprint,
            Self::Creates(plan) => &plan.fingerprint,
        }
    }
}

/// What one finished install left behind, whichever route ran it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum InstallOutcome {
    Stacking(ModInstallOutcome),
    Base(BaseInstallOutcome),
    Creates(CreateInstallOutcome),
}

/// How far a long operation has got, in the words the interface shows. Plain fields because it crosses
/// a process boundary on the desktop.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct OperationProgress {
    /// What is happening now - "Downloading sfall 4.5".
    pub step: String,
    /// Bytes so far and bytes expected, when the step is a transfer and the server said how big it is.
    pub received: Option<u64>,
    pub total: Option<u64>,
    /// Whether `cancel` would reach this step. Declared rather than inferred from the byte counts being
    /// present: the interface offers the button on this, and a control that is offered and does nothing
    /// is worse than one that was never there.
    pub cancellable: bool,
}

/// What only the window's own shell can do. Kept out of the platform seam because it is not a
/// capability of the machine but of whatever is presenting the interface, and a browser has none.
///
/// The clock is here for the same reason: `stamp` takes the fields rather than reading them so a test
/// can name what a backup directory is called, and the host that owns the timezone is the one
/// presenting the window.
pub trait Shell: Send + Sync {
    /// A directory the user picked, or nothing if they cancelled.
    ///
    /// `holding` names a file that directory must contain, and changes what the user is shown: a picker
    /// for that file rather than for a folder, whose parent is what comes back. A folder picker hides
    /// files, so a user asked for "the folder holding master.dat" has to recognise it by name alone -
    /// and the one thing that would settle it is the file they are not allowed to see.
    ///
    /// # Errors
    ///
    /// Fails where the picker itself could not be shown.
    fn choose_folder(&self, holding: Option<&str>) -> Result<Option<String>>;

    /// Where progress goes. A host with nowhere to show it does nothing here, and every operation still
    /// runs.
    fn report(&self, progress: &OperationProgress);

    /// Local wall-clock time, broken down by whoever owns the timezone. What a stamped directory is
    /// named after, since the user reads that name in their own time.
    fn now(&self) -> LocalTime;

    /// The same instant in UTC, for what is written into a log read beside other programs'.
    fn utc(&self) -> Utc;

    /// Milliseconds since the epoch, for the freshness of a cached listing and the age of a lock.
    fn millis(&self) -> i64;
}

/// The step and byte counts as one message. They arrive separately - the step from whichever part of
/// the operation is starting, the counts from the transport, which knows nothing about what it is
/// fetching - so the last step named is what a set of counts is reported under.
struct ReportState {
    shell: Arc<dyn Shell>,
    /// Only the transfer honours it: a step that names no byte counts says so, and the interface stops
    /// offering the button rather than offering one that would be ignored.
    cancel: AtomicBool,
    step: Mutex<String>,
}

impl ReportState {
    fn step(&self, named: &str) {
        *self
            .step
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = named.to_owned();
        self.shell.report(&OperationProgress {
            step: named.to_owned(),
            received: None,
            total: None,
            cancellable: false,
        });
    }

    fn progress(&self, held: DownloadProgress) {
        let step = self
            .step
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        self.shell.report(&OperationProgress {
            step,
            received: Some(held.received),
            total: held.total,
            cancellable: true,
        });
    }
}

/// The three progress shapes over one reporter. Three rather than one for the reason the domain keeps
/// them apart: folding them together is a refactor of three working flows.
struct Reporter {
    state: Arc<ReportState>,
    on_step: Box<dyn Fn(&str) + Send + Sync>,
    on_progress: Box<dyn Fn(DownloadProgress) + Send + Sync>,
}

impl Reporter {
    fn new(shell: Arc<dyn Shell>) -> Self {
        let state = Arc::new(ReportState {
            shell,
            cancel: AtomicBool::new(false),
            step: Mutex::new(String::new()),
        });
        let stepping = Arc::clone(&state);
        let progressing = Arc::clone(&state);
        Self {
            state,
            on_step: Box::new(move |named: &str| stepping.step(named)),
            on_progress: Box::new(move |held: DownloadProgress| progressing.progress(held)),
        }
    }

    fn download(&self) -> DownloadOptions<'_> {
        DownloadOptions {
            on_progress: Some(&*self.on_progress),
            cancel: Some(&self.state.cancel),
        }
    }

    fn mods(&self) -> ModProgress<'_> {
        ModProgress {
            download: self.download(),
            on_step: Some(&*self.on_step),
        }
    }

    fn engines(&self) -> EngineProgress<'_> {
        EngineProgress {
            download: self.download(),
            on_step: Some(&*self.on_step),
        }
    }

    fn sfall(&self) -> SfallProgress<'_> {
        SfallProgress {
            download: self.download(),
            on_step: Some(&*self.on_step),
        }
    }
}

/// What the feeds published, read once and kept.
#[derive(Debug, Clone)]
struct HeldFeeds {
    listing: ModFeedListing,
    releases: Vec<ModRelease>,
}

pub struct Backend {
    platform: Arc<dyn Platform>,
    shell: Arc<dyn Shell>,
    /// A repository publishes one release whichever game folder is selected, so re-reading it per
    /// install would spend the same requests - and, inside the feed cache's window, the same parse of
    /// the same files - to arrive at the answer already held.
    feeds: Mutex<Option<HeldFeeds>>,
    /// The running operation's cancel. One at a time because the interface refuses to start a second
    /// while one runs, and cleared as it is used so a click that arrives late cannot reach whatever
    /// started next.
    running: Mutex<Option<Arc<ReportState>>>,
    /// What the interface is showing and editing - see `app`.
    held: Mutex<app::Held>,
    /// The game each install last started, by path: its process id and the program it runs as. A game
    /// started any other way is not here, and an install over it fails on the files it holds instead.
    games: Mutex<BTreeMap<String, (u32, String)>>,
}

impl std::fmt::Debug for Backend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Backend").finish_non_exhaustive()
    }
}

/// Every address a linked setting writes. What a base is recorded for: an address no link reaches has
/// nothing to reconcile against, so recording one would grow the record for nothing.
fn linked_addresses() -> BTreeSet<String> {
    settings()
        .iter()
        .filter(|setting: &&SettingDef| setting.targets.len() > 1)
        .flat_map(|setting| setting.targets.iter().map(address_of))
        .collect()
}

/// The release a mod flow works on, and the parts it installs.
struct ChosenRelease {
    release: ModRelease,
    selection: Vec<String>,
}

impl Backend {
    #[must_use]
    pub fn new(platform: Arc<dyn Platform>, shell: Arc<dyn Shell>) -> Self {
        Self {
            platform,
            shell,
            feeds: Mutex::new(None),
            running: Mutex::new(None),
            held: Mutex::new(app::Held::default()),
            games: Mutex::new(BTreeMap::new()),
        }
    }

    fn platform(&self) -> &dyn Platform {
        self.platform.as_ref()
    }

    /// Runs `work` with a reporter wired to the shell, registered as the cancellable operation for as
    /// long as it runs and cleared afterwards.
    fn reporting<T>(&self, work: impl FnOnce(&Reporter) -> Result<T>) -> Result<T> {
        let reporter = Reporter::new(Arc::clone(&self.shell));
        *self
            .running
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(Arc::clone(&reporter.state));
        let outcome = work(&reporter);
        let mut running = self
            .running
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // Only if it is still this operation's: one that started since owns the slot now.
        if running
            .as_ref()
            .is_some_and(|held| Arc::ptr_eq(held, &reporter.state))
        {
            *running = None;
        }
        outcome
    }

    fn own(&self, which: OwnDirectory) -> std::path::PathBuf {
        match which {
            OwnDirectory::Backup => backup_directory(self.platform()),
            OwnDirectory::Debug => debug_directory(self.platform()),
            OwnDirectory::Packages => package_directory(self.platform()),
        }
    }

    /// The feeds as last read, reading them if nothing has.
    fn feeds_held(&self) -> HeldFeeds {
        let mut held = self
            .feeds
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(held) = held.as_ref() {
            return held.clone();
        }
        let (listing, releases) = read_mod_feeds(self.platform(), self.shell.millis());
        let read = HeldFeeds { listing, releases };
        *held = Some(read.clone());
        read
    }

    /// The feeds where something has read them, and nothing otherwise - for a reading of an install,
    /// which must not reach the network on its own initiative.
    fn feeds_if_read(&self) -> Option<HeldFeeds> {
        self.feeds
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// The same, for the two callers asking after the feeds themselves rather than needing a release
    /// from them: startup and the Refresh control. `again` is Refresh, and a held answer carrying a
    /// refusal is read again regardless - the machine that was offline when ZAX started may not be a
    /// minute later.
    ///
    /// That retry belongs here and not in `feeds_held`, or an offline machine would attempt every feed
    /// again on every change of game, which is the cost the two halves exist to avoid.
    fn feeds_asked(&self, again: bool) -> HeldFeeds {
        if !again && self.feeds_held().listing.failures.is_empty() {
            return self.feeds_held();
        }
        let (listing, releases) = read_mod_feeds(self.platform(), self.shell.millis());
        let read = HeldFeeds { listing, releases };
        *self
            .feeds
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(read.clone());
        read
    }

    /// The release a mod flow works on - never data the renderer supplied. An unfinished transaction
    /// answers with the release it opened on, so a retry finishes the version it started: the copies it
    /// set aside are that version's, and a feed that published a newer one meanwhile would otherwise
    /// leave a recovery describing files that are no longer the ones on disk.
    fn release_for_mod(
        &self,
        install: &Install,
        mod_id: &str,
        chosen: &[String],
        version: Option<&str>,
    ) -> Result<ChosenRelease> {
        // An unfinished attempt decides its own selection too, and for the same reason: the copies
        // waiting beside it are those parts', and a second answer to the dialog would land on the first
        // attempt's work.
        if let Some(open) = read_transaction(self.platform(), install, mod_id)? {
            return Ok(ChosenRelease {
                release: release_of(&open)?,
                selection: open.selection,
            });
        }
        let Some(feed) = MOD_FEEDS.iter().find(|entry| entry.id == mod_id) else {
            return Err(Error::Unsupported(format!(
                "No known feed carries \"{mod_id}\"."
            )));
        };
        let source = FeedSource::from(feed);
        // A version the user picked is fetched by name; otherwise the release the listing was drawn
        // from, so what gets installed is the version the button offered. Going back to the feed for the
        // newest here would let a release published since open the plan the user never saw, and the
        // confirmation compares the two - so the flow would refuse itself rather than install anything.
        let release = match version {
            Some(version) => fetch_feed_at(self.platform(), &source, version, self.shell.millis())?,
            None => match self
                .feeds_held()
                .releases
                .into_iter()
                .find(|one| one.manifest.id == mod_id)
            {
                Some(held) => held,
                None => fetch_feed(self.platform(), &source, self.shell.millis())?,
            },
        };
        Ok(ChosenRelease {
            release,
            selection: chosen.to_vec(),
        })
    }

    /// The settings schemas the install's records carry. A snapshot a newer spec wrote is skipped, not
    /// fatal.
    fn installed_mod_settings(&self, install_path: &str) -> Result<Vec<ModSettingsGroup>> {
        let mut groups = Vec::new();
        for held in load_record(self.platform(), install_path)?.mods {
            if !held.complete {
                continue;
            }
            // The mod stays installed and listed; only its configuration surface is missing, as it is
            // for any mod without a schema.
            let Ok(manifest) = parse_manifest(
                held.manifest.as_bytes(),
                &ManifestDefaults {
                    version: Some(held.version.clone()),
                    archive: None,
                },
            ) else {
                continue;
            };
            // A mod without a schema gets no configuration surface - the schema is the convention. One
            // whose whole schema this version cannot draw still gets a section, or the reason would have
            // nowhere to go.
            if manifest.settings.is_empty() && manifest.dropped.is_empty() {
                continue;
            }
            let mut files: Vec<String> = Vec::new();
            for setting in &manifest.settings {
                let file = &setting.def.targets.own().file;
                if !files.contains(file) {
                    files.push(file.clone());
                }
            }
            groups.push(ModSettingsGroup {
                mod_id: manifest.id,
                name: manifest.name,
                files,
                settings: manifest.settings,
                dropped: manifest.dropped,
            });
        }
        Ok(groups)
    }

    /// Moves the base of each given address to the value named, which is what a later load compares
    /// against to tell which side has moved since. Only addresses a link reaches: one no link reaches
    /// has nothing to reconcile with, and recording every key would put the whole catalog in the record.
    ///
    /// Never fails the operation that asked for it. A record written by a newer ZAX is not ours to
    /// rewrite, and a lost base only costs the preference between two values - the files themselves are
    /// already correct.
    fn move_base(&self, install_path: &str, at: &[ConfigChange]) -> Result<()> {
        let linked = linked_addresses();
        let relevant: Vec<&ConfigChange> = at
            .iter()
            .filter(|one| linked.contains(&address(&one.file, &one.section, &one.key)))
            .collect();
        if relevant.is_empty() {
            return Ok(());
        }
        let record = load_record(self.platform(), install_path)?;
        if record.later_format.is_some() {
            return Ok(());
        }
        let mut written = record.written.clone();
        for one in relevant {
            written.insert(
                address(&one.file, &one.section, &one.key),
                one.value.clone(),
            );
        }
        save_record(
            self.platform(),
            &crate::records::InstallRecord { written, ..record },
        )
    }

    /// Brings a folder to the build `pick` names and records whether it is pinned there, answering the
    /// build the machine runs. Shared by a run and by picking a build on the Engines tab, so choosing
    /// one without starting the game leaves the folder exactly as that run would have.
    fn place_engine(
        &self,
        install: &Install,
        engine_id: &str,
        pick: Option<&BuildPick>,
    ) -> Result<&'static crate::engines::EngineBuild> {
        let engine = engine_named(engine_id)?;
        let Some(build) = build_for(engine, self.platform().os(), self.platform().arch()) else {
            return Err(Error::Unsupported(format!(
                "{} publishes no build ZAX can run on this machine.",
                engine.name
            )));
        };
        let deployed = installed_engines(self.platform(), install)?
            .into_iter()
            .find(|one| one.id == engine_id);
        let cached = cached_engines(self.platform(), engine, build.asset)?;
        let choice = choose_build(deployed.as_ref(), &cached, pick);
        match choice {
            crate::engine_choice::BuildChoice::Nothing => {
                return Err(Error::Unsupported(format!(
                    "ZAX has no copy of {} for this game. Fetch one on the Engines tab first.",
                    engine.name
                )));
            }
            // Deploying is what choosing a build amounts to: a folder holds one, so switching means
            // unpacking the other over it - the same deployment, backup and record write an install has
            // always made.
            crate::engine_choice::BuildChoice::Deploy { build: held, pin } => {
                let at = EngineChoice {
                    published: Some(held.release.published.clone()),
                    pin,
                };
                self.reporting(|reporter| {
                    install_cached_engine(
                        self.platform(),
                        install,
                        engine_id,
                        &at,
                        self.shell.now(),
                        &reporter.engines(),
                    )
                })?;
            }
            crate::engine_choice::BuildChoice::Here { pin } => {
                if pin != deployed.is_some_and(|one| one.pinned) {
                    pin_engine(self.platform(), install, engine_id, pin)?;
                }
            }
        }
        Ok(build)
    }
}

// --- the operations the interface calls -------------------------------------------------------

impl Backend {
    /// # Errors
    ///
    /// Fails where the picker itself could not be shown.
    pub fn choose_folder(&self, holding: Option<&str>) -> Result<Option<String>> {
        self.shell.choose_folder(holding)
    }

    #[must_use]
    pub fn describe(&self) -> MachineDescription {
        let shown = |at: std::path::PathBuf| at.to_string_lossy().into_owned();
        MachineDescription {
            os: self.platform().os(),
            backup_directory: shown(backup_directory(self.platform())),
            debug_directory: shown(debug_directory(self.platform())),
            package_directory: shown(package_directory(self.platform())),
            log_file: shown(log_file(self.platform())),
        }
    }

    /// # Errors
    ///
    /// Fails where the state file is there but cannot be read.
    pub fn load_state(&self) -> Result<LoadedState> {
        load_state(self.platform())
    }

    /// # Errors
    ///
    /// Fails where the state file cannot be written.
    pub fn save_state(&self, state: &AppState) -> Result<()> {
        save_state(self.platform(), state)
    }

    /// Every config file this install's interface edits, the installed mods' own among them.
    ///
    /// # Errors
    ///
    /// Fails where a file is there but cannot be read.
    pub fn load_config_files(&self, install_path: &str) -> Result<ConfigFileContents> {
        // The installed mods' settings files load through the same lossless path the engine's files do,
        // so the interface's guard-and-backup behaviour is one mechanism, not two.
        let mut names: Vec<String> = CONFIG_FILES.iter().map(|one| (*one).to_owned()).collect();
        for group in self.installed_mod_settings(install_path)? {
            for file in group.files {
                if !names.contains(&file) {
                    names.push(file);
                }
            }
        }
        let held = load_config_files(
            self.platform(),
            Path::new(install_path),
            &names,
            &zax_core::config_io::ConfigFilePaths::new(),
        )?;
        // Second, because where the content config sits is a setting inside the file just read.
        let paths = engine_config_paths(
            self.platform(),
            install_path,
            held.get("fallout2.cfg").and_then(Option::as_deref),
        )?;
        let engines = load_config_files(
            self.platform(),
            Path::new(install_path),
            &paths.keys().cloned().collect::<Vec<String>>(),
            &paths,
        )?;
        let mut out = held;
        out.extend(engines);
        Ok(out)
    }

    /// # Errors
    ///
    /// Fails where a file cannot be read or written.
    pub fn save_config_files(&self, request: &SaveRequest) -> Result<SaveOutcome> {
        // Resolved against the contents the edits were made against, which is what the read used, so a
        // save writes where it read. A `master_patches` changed in the same save takes effect on the
        // next load.
        let paths = engine_config_paths(
            self.platform(),
            &request.install_path.to_string_lossy(),
            request
                .original
                .get("fallout2.cfg")
                .and_then(Option::as_deref),
        )?;
        let outcome = save_config_files(
            self.platform(),
            &SaveRequest {
                paths,
                ..request.clone()
            },
        )?;
        if matches!(outcome, SaveOutcome::Written(_)) {
            self.move_base(&request.install_path.to_string_lossy(), &request.changes)?;
        }
        Ok(outcome)
    }

    /// The base each address of a setting more than one engine carries is measured from, keyed by
    /// `file|section|key`.
    ///
    /// # Errors
    ///
    /// Fails where the record is there but cannot be read.
    pub fn settings_base(&self, install_path: &str) -> Result<BTreeMap<String, String>> {
        Ok(load_record(self.platform(), install_path)?.written)
    }

    /// Moves those bases to the values named, without touching a file.
    ///
    /// What reverting a carried-across value does. The user has said these engines may disagree, and no
    /// file changes when they do - so unless the bases move with them, the next load reads the same
    /// disagreement off the same files and carries it across again. A later change inside an engine
    /// still reads as a move.
    ///
    /// # Errors
    ///
    /// Fails where the record cannot be read or written.
    pub fn accept_settings_base(&self, install_path: &str, at: &[HeldTarget]) -> Result<()> {
        let changes: Vec<ConfigChange> = at
            .iter()
            .map(|one| ConfigChange {
                file: one.target.file.clone(),
                section: one.target.section.clone(),
                key: one.target.key.clone(),
                value: one.value.clone(),
            })
            .collect();
        self.move_base(install_path, &changes)
    }

    /// sfall's mod load order, and what sits in the folder it orders.
    ///
    /// # Errors
    ///
    /// Fails where the folder cannot be read.
    pub fn load_mods(&self, install: &Install) -> Result<ModsSnapshot> {
        read_mods(self.platform(), install)
    }

    /// # Errors
    ///
    /// Fails where the order file cannot be written.
    pub fn save_mods(&self, request: &ModsSaveRequest) -> Result<SaveOutcome> {
        save_mods(self.platform(), request)
    }

    /// What every followed feed has published. The same answer for every install, so it is read once
    /// and held: `refresh` is what the Mods tab's own control passes to ask the feeds again rather than
    /// be told what they said before.
    #[must_use]
    pub fn published_mods(&self, refresh: bool) -> ModFeedListing {
        self.feeds_asked(refresh).listing
    }

    /// Where one install stands against those mods - what is deployed in the folder, and what its
    /// record says. This is the half a change of game invalidates; `listing_from` puts the two back
    /// together.
    ///
    /// # Errors
    ///
    /// Fails where the folder or the record cannot be read.
    pub fn mod_install_state(&self, install: &Install) -> Result<ModInstallState> {
        let record = reconcile_record(
            self.platform(),
            &load_record(self.platform(), &install.path)?,
        )?;
        let sfall = installed_sfall_version(self.platform(), install)?;
        read_mod_install_state(
            self.platform(),
            &self.feeds_held().releases,
            install,
            &record,
            sfall.as_deref(),
        )
    }

    /// Downloads and verifies a mod's release, answering the resolved plan the confirmation shows.
    ///
    /// # Errors
    ///
    /// Fails for every reason the three planners do.
    pub fn plan_mod(
        &self,
        install: &Install,
        mod_id: &str,
        choices: &[String],
        answers: &BTreeMap<String, String>,
        version: Option<&str>,
    ) -> Result<InstallPlan> {
        let chosen = self.release_for_mod(install, mod_id, choices, version)?;
        self.reporting(|reporter| plan_for(self, install, &chosen, answers, reporter))
    }

    /// Installs the plan whose fingerprint this is; one that no longer resolves the same is refused.
    ///
    /// # Errors
    ///
    /// Fails for every reason the three installers do, and where the plan no longer resolves the same.
    pub fn install_mod(
        &self,
        install: &Install,
        mod_id: &str,
        fingerprint: &str,
        choices: &[String],
        answers: &BTreeMap<String, String>,
        version: Option<&str>,
    ) -> Result<InstallOutcome> {
        let chosen = self.release_for_mod(install, mod_id, choices, version)?;
        self.reporting(|reporter| {
            // Re-planned rather than trusting a plan the renderer held: the directory may have moved on
            // since the confirmation, and the plan is cheap against the already-verified archive. What
            // runs is still what was agreed to - a plan that resolved differently is refused here rather
            // than quietly carried out.
            let plan = plan_for(self, install, &chosen, answers, reporter)?;
            if plan.fingerprint() != fingerprint {
                return Err(Error::Unsupported(format!(
                    "What installing {} would do has changed since you confirmed it - the game folder \
                     or the release moved on. Look at the new plan and confirm again.",
                    chosen.release.manifest.name
                )));
            }
            let now = self.shell.now();
            match plan {
                InstallPlan::Creates(plan) => apply_create_install(
                    self.platform(),
                    install,
                    &chosen.release,
                    &plan,
                    &reporter.mods(),
                    now,
                )
                .map(InstallOutcome::Creates),
                InstallPlan::Base(_) => apply_base_install(
                    self.platform(),
                    install,
                    &chosen.release,
                    &reporter.mods(),
                    now,
                    self.shell.millis(),
                )
                .map(InstallOutcome::Base),
                InstallPlan::Stacking(plan) => apply_mod_install(
                    self.platform(),
                    install,
                    &chosen.release,
                    &plan,
                    &reporter.mods(),
                    now,
                )
                .map(InstallOutcome::Stacking),
            }
        })
    }

    /// The versions this mod's feed publishes, newest first, for a row that offers a choice rather than
    /// only the release at the head of its line. `above` is what the install already carries, and the
    /// answer excludes it and everything below: the comparison belongs here, where the release line
    /// that defines it is known.
    ///
    /// # Errors
    ///
    /// Fails where no known feed carries the id, or where the listing cannot be read.
    pub fn mod_versions(&self, mod_id: &str, above: Option<&str>) -> Result<Vec<String>> {
        let Some(feed) = MOD_FEEDS.iter().find(|entry| entry.id == mod_id) else {
            return Err(Error::Unsupported(format!(
                "No known feed carries \"{mod_id}\"."
            )));
        };
        let source = FeedSource::from(feed);
        let versions = list_mod_versions(self.platform(), &source, self.shell.millis())?;
        let Some(above) = above else {
            return Ok(versions);
        };
        Ok(versions
            .into_iter()
            .filter(|version| {
                compare_in_line(feed.line.as_ref(), version, above) == std::cmp::Ordering::Greater
            })
            .collect())
    }

    /// Unwinds an install that never finished; the working directory holds everything it puts back.
    ///
    /// # Errors
    ///
    /// Fails where nothing is waiting, or where the working directory is gone.
    pub fn restore_mod(&self, install: &Install, mod_id: &str) -> Result<()> {
        restore_mod_install(self.platform(), install, mod_id, self.shell.now())
    }

    /// # Errors
    ///
    /// Fails where the mod's type forbids removal, or where nothing of it is here.
    pub fn remove_mod(&self, install: &Install, mod_id: &str) -> Result<ModRemoval> {
        uninstall_mod(self.platform(), install, mod_id, self.shell.now())
    }

    /// The installed mods' settings schemas, rendered by the same per-kind controls the catalog uses.
    ///
    /// # Errors
    ///
    /// Fails where the record cannot be read.
    pub fn mod_settings(&self, install: &Install) -> Result<Vec<ModSettingsGroup>> {
        self.installed_mod_settings(&install.path)
    }

    /// Hands one of an installed mod's own files to the desktop's opener - the route to the sections a
    /// schema does not cover. Bounded to files the mod's record declares, so a renderer cannot name
    /// another.
    ///
    /// # Errors
    ///
    /// Fails where nothing of the mod is recorded, or where the file is not one of its own.
    pub fn open_mod_file(&self, install: &Install, mod_id: &str, file: &str) -> Result<()> {
        let record = load_record(self.platform(), &install.path)?;
        let Some(held) = record.mods.iter().find(|one| one.id == mod_id) else {
            return Err(Error::Unsupported(format!(
                "Nothing of \"{mod_id}\" is recorded for this install."
            )));
        };
        // Bounded to the files the record itself declares - its state snapshots and its schema's files.
        let mut allowed: BTreeSet<String> = held.shipped.keys().cloned().collect();
        // An unreadable snapshot narrows what may be opened; it does not widen anything.
        if let Ok(manifest) = parse_manifest(
            held.manifest.as_bytes(),
            &ManifestDefaults {
                version: Some(held.version.clone()),
                archive: None,
            },
        ) {
            for setting in &manifest.settings {
                allowed.insert(setting.def.targets.own().file.clone());
            }
        }
        // The second condition is defence in depth: both sources of `allowed` are already bounded the
        // same way - the record reader drops an entry naming a path the mod may not write, and the
        // manifest parser does the same to a setting's file.
        if !allowed.contains(file) || !may_write(file, grants_for(mod_id)) {
            return Err(Error::Unsupported(format!(
                "\"{file}\" is not one of {mod_id}'s files."
            )));
        }
        let mut at = Path::new(&install.path).to_path_buf();
        for segment in file.split('/') {
            at.push(segment);
        }
        self.platform().process().open(&at)
    }

    /// # Errors
    ///
    /// Fails where the directory is there but cannot be read.
    #[must_use]
    pub fn identify_install(&self, path: &str) -> Option<GameType> {
        identify_install(self.platform(), Path::new(path))
    }

    /// Installs found on this machine and not already on the list.
    ///
    /// The Wine prefix is the default one: the per-install prefix a user configures is a property of
    /// an install that already exists, and a scan is looking for the ones that do not.
    #[must_use]
    pub fn scan_for_installs(&self, known: &[Install]) -> Vec<Install> {
        scan_for_installs(self.platform(), known, self.shell.utc(), None)
    }

    /// # Errors
    ///
    /// Fails where the library is there but cannot be read.
    pub fn installed_sfall_version(&self, install: &Install) -> Result<Option<String>> {
        installed_sfall_version(self.platform(), install)
    }

    /// # Errors
    ///
    /// Fails where the release feed cannot be read.
    pub fn latest_sfall(&self) -> Result<SfallRelease> {
        latest_sfall(self.platform())
    }

    /// # Errors
    ///
    /// Fails where the download or any step of the update does.
    pub fn update_sfall(&self, install: &Install, version: &str) -> Result<SfallUpdate> {
        self.reporting(|reporter| {
            update_sfall(
                self.platform(),
                install,
                version,
                self.shell.now(),
                &reporter.sfall(),
            )
        })
    }

    /// # Errors
    ///
    /// Fails where the file listing cannot be read.
    pub fn list_sfall_versions(&self) -> Result<Vec<String>> {
        list_sfall_versions(self.platform())
    }

    /// Every engine ZAX knows, against this machine. Answers from the catalog and the cache - no
    /// network.
    ///
    /// # Errors
    ///
    /// Fails where the cache is there but cannot be read.
    pub fn machine_engines(&self) -> Result<Vec<EngineListing>> {
        let mut out = Vec::new();
        for engine in ENGINES {
            let build = build_for(engine, self.platform().os(), self.platform().arch());
            let versions = match build {
                None => Vec::new(),
                Some(build) => cached_engines(self.platform(), engine, build.asset)?
                    .into_iter()
                    .map(|one: CachedEngine| CachedBuild {
                        release: one.release.release,
                        published: one.release.published,
                        commit: one.release.commit,
                    })
                    .collect(),
            };
            out.push(EngineListing {
                id: engine.id.to_owned(),
                name: engine.name.to_owned(),
                short: engine.short.to_owned(),
                page: engine.page.to_owned(),
                releases: engine.releases,
                build: build.map(|build| MachineBuild {
                    asset: build.asset.to_owned(),
                    program: build.program.to_owned(),
                }),
                why: build
                    .is_none()
                    .then(|| format!("{} publishes no build for this machine.", engine.name)),
                caution: engine.caution.map(str::to_owned),
                versions,
            });
        }
        Ok(out)
    }

    /// What is deployed in one game folder, reconciled against the directory.
    ///
    /// # Errors
    ///
    /// Fails where the record cannot be read.
    pub fn deployed_engines(&self, install: &Install) -> Result<Vec<InstalledEngine>> {
        installed_engines(self.platform(), install)
    }

    /// What the project has published, newest first.
    ///
    /// # Errors
    ///
    /// Fails where the listing cannot be read.
    pub fn engine_releases(&self, engine_id: &str) -> Result<Vec<EngineRelease>> {
        engine_releases(self.platform(), engine_id)
    }

    /// Downloads a build into the machine's cache. `published` names one, or nothing for the newest.
    ///
    /// # Errors
    ///
    /// Fails where the project publishes none for this machine, or where the download does.
    pub fn fetch_engine(&self, engine_id: &str, published: Option<&str>) -> Result<EngineRelease> {
        self.reporting(|reporter| {
            fetch_engine_build(self.platform(), engine_id, published, &reporter.engines())
        })
    }

    /// Drops one build from the cache. Nothing is removed from any game folder.
    ///
    /// # Errors
    ///
    /// Fails where the cached directory cannot be removed.
    pub fn forget_engine(&self, engine_id: &str, published: &str) -> Result<()> {
        forget_engine(self.platform(), engine_named(engine_id)?, published)
    }

    /// Puts the picked build in one game folder without running anything, and records the pick - what a
    /// run with the same pick would do before it started the program.
    ///
    /// # Errors
    ///
    /// Fails where the machine holds no build to put there.
    pub fn use_engine_build(
        &self,
        install: &Install,
        engine_id: &str,
        pick: &BuildPick,
    ) -> Result<()> {
        self.place_engine(install, engine_id, Some(pick))?;
        Ok(())
    }

    /// Read only: nothing here installs the hi-res patch, so this reports what is there and stops.
    ///
    /// # Errors
    ///
    /// Fails where the library is there but cannot be read.
    pub fn installed_hires_version(&self, install: &Install) -> Result<Option<String>> {
        installed_hires_version(self.platform(), install)
    }

    /// # Errors
    ///
    /// Fails where the release feed cannot be read.
    pub fn latest_zax(&self) -> Result<ZaxRelease> {
        latest_zax(self.platform())
    }

    /// # Errors
    ///
    /// Fails where the save directory is there but cannot be listed.
    pub fn list_saves(&self, install: &Install) -> Result<Vec<String>> {
        list_saves(self.platform(), install)
    }

    /// # Errors
    ///
    /// Fails where the game folder cannot be read or the archive cannot be written.
    pub fn create_debug_package(
        &self,
        install: &Install,
        saves: &[String],
    ) -> Result<DebugPackage> {
        create_debug_package(self.platform(), install, saves, self.shell.now())
    }

    /// What launching `engine_id` would do to this folder's mod order, or nothing where it would do
    /// nothing. Asked before the launch, so what is about to change can still be refused.
    ///
    /// # Errors
    ///
    /// Fails where the order file cannot be read.
    pub fn order_swap(
        &self,
        install: &Install,
        engine_id: Option<&str>,
    ) -> Result<Option<OrderSwap>> {
        preview_order_swap(
            self.platform(),
            Path::new(&install.path),
            self.order_format_for(engine_id)?,
        )
    }

    /// Which order format an engine reads, defaulting to sfall's - including for the game's own
    /// executable, which has no engine to ask.
    fn order_format_for(&self, engine_id: Option<&str>) -> Result<OrderFormat> {
        let Some(engine_id) = engine_id else {
            return Ok(OrderFormat::Sfall);
        };
        Ok(engine_named(engine_id)?
            .order_format
            .unwrap_or(OrderFormat::Sfall))
    }

    /// `engine_id` names an alternative engine, or nothing for the game's own executable. `pick` is the
    /// build to run, or nothing to follow what the folder holds and what the cache offers.
    ///
    /// The program comes from the record and the catalog, never from the renderer - a caller that could
    /// name the program would be naming a program for the machine to start.
    ///
    /// # Errors
    ///
    /// Fails where the machine holds no build to run, or where the program cannot be started.
    pub fn launch(
        &self,
        install: &Install,
        sfall_version: Option<&str>,
        engine_id: Option<&str>,
        pick: Option<&BuildPick>,
    ) -> Result<()> {
        let wanted = self.order_format_for(engine_id)?;
        let program = match engine_id {
            None => None,
            Some(engine_id) => Some(self.place_engine(install, engine_id, pick)?.program),
        };
        // Before the program starts, never after it exits: the seam's `launch` answers once the game is
        // up, and a swap owed to a session ZAX did not see the end of is a swap that never happens.
        swap_order_to(self.platform(), Path::new(&install.path), wanted)?;
        let runs_as = game_program(program).to_owned();
        let plan = plan_launch(self.platform().os(), install, sfall_version, program);
        let games = &self.games;
        let started = |pid: u32| {
            games
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .insert(install.path.clone(), (pid, runs_as.clone()));
        };
        self.platform().process().launch(
            Path::new(&plan.program),
            &plan.args,
            &LaunchOptions {
                cwd: Some(std::path::PathBuf::from(plan.cwd)),
                env: plan.env,
                log: plan.log.map(std::path::PathBuf::from),
                on_start: Some(&started),
            },
        )
    }

    /// Whether the game ZAX last started for this install is still running.
    ///
    /// # Errors
    ///
    /// Fails where the host cannot be asked about the process.
    pub fn game_running(&self, install: &Install) -> Result<bool> {
        let mut games = self
            .games
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some((pid, runs_as)) = games.get(&install.path).cloned() else {
            return Ok(false);
        };
        if self.platform().process().alive(pid)? && still_running(self.platform(), pid, &runs_as)? {
            return Ok(true);
        }
        // Gone, or its id now someone else's: forgotten, so a later program given the same id is never
        // taken for the game.
        games.remove(&install.path);
        Ok(false)
    }

    /// # Errors
    ///
    /// Fails where the desktop's own handler could not be reached, or where the mod publishes no such
    /// page.
    pub fn open(&self, target: &OpenTarget) -> Result<()> {
        match target {
            OpenTarget::Mod { id, page } => {
                // The address is taken from the release ZAX read, exactly as the download page below is
                // resolved here rather than named by the caller. A held feed answers it: the row
                // offering the page came from one.
                let held = self
                    .feeds_held()
                    .releases
                    .into_iter()
                    .find(|one| one.manifest.id == *id);
                let url = held.and_then(|one| match page {
                    ModPage::Forum => one.manifest.forum.clone(),
                    ModPage::Homepage => one.manifest.homepage.clone(),
                });
                let Some(url) = url else {
                    let named = match page {
                        ModPage::Forum => "forum",
                        ModPage::Homepage => "homepage",
                    };
                    return Err(Error::Unsupported(format!(
                        "No {named} is published for {id}."
                    )));
                };
                self.platform().process().open(Path::new(&url))
            }
            // Resolved here rather than named by the interface: a renderer that could give the address
            // would be handing an argument to the system's own opener. The page when the feed cannot be
            // reached - a user who pressed a download button was going there anyway, and it needs no
            // request to name.
            OpenTarget::Download => {
                let url = latest_zax(self.platform())
                    .map_or_else(|_| RELEASES_PAGE.to_owned(), |release| release.url);
                self.platform().process().open(Path::new(&url))
            }
            OpenTarget::Log => self.platform().process().open(&log_file(self.platform())),
            OpenTarget::Own { directory } => self.platform().process().open(&self.own(*directory)),
        }
    }

    /// Recreated straight away, so the path the interface shows stays valid. The log needs no
    /// recreating: the next line written makes it.
    ///
    /// # Errors
    ///
    /// Fails where the directory cannot be removed or remade.
    pub fn wipe(&self, which: WipeTarget) -> Result<()> {
        match which {
            WipeTarget::Log => self.platform().fs().remove(&log_file(self.platform())),
            WipeTarget::Own { directory } => {
                let at = self.own(directory);
                self.platform().fs().remove(&at)?;
                self.platform().fs().mkdir(&at)
            }
        }
    }

    /// Stops the running operation's transfer, if it has one. Answers either way rather than reporting
    /// that nothing was cancellable: what the caller acts on is what the operation itself then does,
    /// and a step that finished between the click and this arriving is not an error anyone can act on.
    ///
    /// Taken as it is used, so a click that lands after its operation has already finished cannot abort
    /// the one that started next.
    pub fn cancel(&self) {
        let held = self
            .running
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        if let Some(state) = held {
            state.cancel.store(true, Ordering::SeqCst);
        }
    }
}

/// Which of the three planners a release takes, resolved once so the plan and the install cannot
/// disagree about which kind of install this is.
fn plan_for(
    backend: &Backend,
    install: &Install,
    chosen: &ChosenRelease,
    answers: &BTreeMap<String, String>,
    reporter: &Reporter,
) -> Result<InstallPlan> {
    let manifest = &chosen.release.manifest;
    if manifest.creates.is_some() {
        return plan_create_install(
            backend.platform(),
            install,
            &chosen.release,
            answers,
            &reporter.mods(),
        )
        .map(InstallPlan::Creates);
    }
    if manifest.mod_type == crate::manifest::ModType::Base {
        return plan_base_install(
            backend.platform(),
            install,
            &chosen.release,
            &reporter.mods(),
        )
        .map(InstallPlan::Base);
    }
    plan_mod_install(
        backend.platform(),
        install,
        &chosen.release,
        &chosen.selection,
        &reporter.mods(),
    )
    .map(InstallPlan::Stacking)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::records::{InstallRecord, InstalledMod};
    use std::sync::Mutex as StdMutex;
    use zax_platform::memory::{Content, MemoryOptions, MemoryPlatform};

    /// A shell with no window: it picks nothing, keeps what it was told, and holds the clock still.
    #[derive(Debug, Default)]
    struct TestShell {
        folder: Option<String>,
        said: StdMutex<Vec<OperationProgress>>,
    }

    impl Shell for TestShell {
        fn choose_folder(&self, _holding: Option<&str>) -> Result<Option<String>> {
            Ok(self.folder.clone())
        }

        fn report(&self, progress: &OperationProgress) {
            self.said
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(progress.clone());
        }

        fn now(&self) -> LocalTime {
            LocalTime {
                year: 2024,
                month: 5,
                day: 6,
                hour: 7,
                minute: 8,
                second: 9,
            }
        }

        fn utc(&self) -> Utc {
            Utc {
                year: 2024,
                month: 5,
                day: 6,
                hour: 7,
                minute: 8,
                second: 9,
                millisecond: 0,
            }
        }

        fn millis(&self) -> i64 {
            1_700_000_000_000
        }
    }

    fn install() -> Install {
        Install::new("/games/f2", GameType::Fallout2)
    }

    fn backend_with(files: &[(&str, &str)]) -> (Backend, Arc<MemoryPlatform>) {
        let platform = Arc::new(MemoryPlatform::new(MemoryOptions {
            files: files
                .iter()
                .map(|(path, text)| ((*path).to_owned(), Content::from(*text)))
                .collect(),
            dirs: vec!["/games/f2".to_owned()],
            ..MemoryOptions::default()
        }));
        let backend = Backend::new(
            Arc::clone(&platform) as Arc<dyn Platform>,
            Arc::new(TestShell::default()),
        );
        (backend, platform)
    }

    /// What removing a mod answers after the game was started, on a host that reports the game's id
    /// (the first the memory host hands out) as `live`, running `command` where one is given.
    fn removal_after_play(live: bool, command: Option<&str>) -> Result<AppView> {
        let platform = Arc::new(MemoryPlatform::new(MemoryOptions {
            files: BTreeMap::from([("/games/f2/fallout2.exe".to_owned(), Content::from("MZ"))]),
            dirs: vec!["/games/f2".to_owned()],
            live_pids: if live { vec![1000] } else { Vec::new() },
            commands: command
                .map(|held| BTreeMap::from([(1000, held.to_owned())]))
                .unwrap_or_default(),
            ..MemoryOptions::default()
        }));
        let backend = Backend::new(
            Arc::clone(&platform) as Arc<dyn Platform>,
            Arc::new(TestShell::default()),
        );
        backend.add_install("/games/f2")?;
        backend.select_install("/games/f2")?;
        backend.launch_selected(None, None)?;
        backend.remove_mod_and_read("ecco")
    }

    #[test]
    fn a_mod_flow_waits_for_the_game_zax_started_to_close() {
        let err = removal_after_play(true, None).expect_err("refused");
        assert!(format!("{err}").contains("The game is running"), "{err}");
        let err =
            removal_after_play(true, Some("Z:\\games\\f2\\fallout2.exe")).expect_err("refused");
        assert!(format!("{err}").contains("The game is running"), "{err}");
    }

    #[test]
    fn a_game_that_has_exited_or_whose_id_moved_on_refuses_nothing() {
        // Past the guard, the removal answers for itself: there is no such mod here.
        for (live, command) in [(false, None), (true, Some("/usr/bin/bash"))] {
            let err = removal_after_play(live, command).expect_err("nothing to remove");
            assert!(format!("{err}").contains("Nothing of"), "{err}");
        }
    }

    #[test]
    fn the_machine_is_described_by_zaxs_own_directories() {
        let (backend, platform) = backend_with(&[]);
        let held = backend.describe();
        assert_eq!(held.os, platform.os());
        assert!(held.backup_directory.ends_with("backup"), "{held:?}");
        assert!(held.log_file.ends_with("zax.log"), "{held:?}");
    }

    #[test]
    fn wiping_a_directory_leaves_the_path_the_interface_shows_valid() {
        let (backend, platform) = backend_with(&[]);
        let at = backup_directory(platform.as_ref());
        platform
            .fs()
            .write(&at.join("old"), b"a backup")
            .expect("a write");
        backend
            .wipe(WipeTarget::Own {
                directory: OwnDirectory::Backup,
            })
            .expect("a wipe");
        assert_eq!(platform.fs().stat(&at.join("old")).expect("a read"), None);
        assert!(
            platform.fs().stat(&at).expect("a read").is_some(),
            "the directory itself must survive"
        );
    }

    #[test]
    fn wiping_the_log_removes_the_file_and_makes_no_directory() {
        let (backend, platform) = backend_with(&[]);
        let at = log_file(platform.as_ref());
        platform.fs().write(&at, b"a line").expect("a write");
        backend.wipe(WipeTarget::Log).expect("a wipe");
        assert_eq!(platform.fs().stat(&at).expect("a read"), None);
    }

    #[test]
    fn what_is_opened_is_always_something_zax_itself_read() {
        let (backend, platform) = backend_with(&[]);
        backend.open(&OpenTarget::Log).expect("an open");
        backend
            .open(&OpenTarget::Own {
                directory: OwnDirectory::Debug,
            })
            .expect("an open");
        let opened = platform.records().opened;
        assert_eq!(opened.len(), 2);
        assert!(opened[0].ends_with("zax.log"), "{opened:?}");
        assert!(opened[1].ends_with("debug"), "{opened:?}");
    }

    #[test]
    fn a_mod_page_no_feed_holds_is_refused_rather_than_guessed_at() {
        let (backend, _) = backend_with(&[]);
        let err = backend
            .open(&OpenTarget::Mod {
                id: "ecco".to_owned(),
                page: ModPage::Forum,
            })
            .expect_err("no held release");
        assert!(format!("{err}").contains("No forum is published"), "{err}");
    }

    /// One record holding a mod whose schema names a file of its own.
    fn with_record(platform: &MemoryPlatform, held: InstalledMod) {
        let record = load_record(platform, "/games/f2").expect("a record");
        save_record(
            platform,
            &InstallRecord {
                mods: vec![held],
                ..record
            },
        )
        .expect("a record");
    }

    fn recorded_mod() -> InstalledMod {
        InstalledMod {
            id: "ecco".to_owned(),
            version: "1.0".to_owned(),
            mod_type: Some(crate::manifest::ModType::Pluggable),
            reason: None,
            complete: true,
            files: vec!["mods/ecco.dat".to_owned()],
            entries: Vec::new(),
            parts: Vec::new(),
            manifest: "spec: 1\nid: ecco\nname: EcCo\nversion: 1.0\ngame: fallout2\n\
                       type: pluggable\narchive: ecco.zip\nsettings:\n  main.Speed:\n    \
                       kind: int\n    label: Speed\n    default: '5'\n"
                .to_owned(),
            shipped: BTreeMap::new(),
            before: BTreeMap::new(),
            carried: BTreeMap::new(),
        }
    }

    #[test]
    fn an_installed_mods_schema_becomes_a_configuration_surface() {
        let (backend, platform) = backend_with(&[]);
        with_record(&platform, recorded_mod());
        let groups = backend.mod_settings(&install()).expect("a reading");
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].mod_id, "ecco");
        assert_eq!(groups[0].files, ["mods/ecco.ini"]);
        assert_eq!(groups[0].settings.len(), 1);
    }

    #[test]
    fn a_file_that_is_not_the_mods_own_is_never_opened() {
        // A renderer that could name another file would be naming a file for the system's opener.
        let (backend, platform) = backend_with(&[]);
        with_record(&platform, recorded_mod());
        let err = backend
            .open_mod_file(&install(), "ecco", "fallout2.cfg")
            .expect_err("not one of its files");
        assert!(
            format!("{err}").contains("is not one of ecco's files"),
            "{err}"
        );
        backend
            .open_mod_file(&install(), "ecco", "mods/ecco.ini")
            .expect("its own schema's file");
        assert_eq!(
            platform.records().opened,
            ["/games/f2/mods/ecco.ini".to_owned()]
        );
    }

    #[test]
    fn nothing_is_opened_for_a_mod_this_install_has_no_record_of() {
        let (backend, _) = backend_with(&[]);
        let err = backend
            .open_mod_file(&install(), "ecco", "mods/ecco.ini")
            .expect_err("no record");
        assert!(
            format!("{err}").contains("is recorded for this install"),
            "{err}"
        );
    }

    #[test]
    fn the_config_files_an_install_loads_include_the_installed_mods_own() {
        let (backend, platform) = backend_with(&[
            ("/games/f2/fallout2.cfg", "[system]\nmaster_patches=data\n"),
            ("/games/f2/mods/ecco.ini", "[main]\nSpeed=5\n"),
        ]);
        with_record(&platform, recorded_mod());
        let held = backend.load_config_files("/games/f2").expect("a read");
        assert!(held.contains_key("fallout2.cfg"));
        assert!(held.contains_key("mods/ecco.ini"));
        // Fission's own file is offered whether or not it is there, which is what lets a save write it.
        assert!(held.contains_key("fission.cfg"));
    }

    #[test]
    fn a_base_is_recorded_only_for_an_address_a_link_reaches() {
        let (backend, _) = backend_with(&[]);
        let linked = linked_addresses();
        let held = linked
            .iter()
            .next()
            .expect("the catalog links at least one setting")
            .clone();
        let (file, rest) = held.split_once('|').expect("an address");
        let (section, key) = rest.split_once('|').expect("an address");
        backend
            .accept_settings_base(
                "/games/f2",
                &[HeldTarget {
                    target: zax_core::catalog::SettingTarget {
                        file: file.to_owned(),
                        section: section.to_owned(),
                        key: key.to_owned(),
                        engine: None,
                        gated_by: None,
                    },
                    value: "7".to_owned(),
                }],
            )
            .expect("a base");
        assert_eq!(
            backend
                .settings_base("/games/f2")
                .expect("a record")
                .get(&held),
            Some(&"7".to_owned())
        );
    }

    #[test]
    fn an_address_no_link_reaches_grows_the_record_by_nothing() {
        let (backend, _) = backend_with(&[]);
        backend
            .accept_settings_base(
                "/games/f2",
                &[HeldTarget {
                    target: zax_core::catalog::SettingTarget {
                        file: "nowhere.ini".to_owned(),
                        section: "Misc".to_owned(),
                        key: "Foo".to_owned(),
                        engine: None,
                        gated_by: None,
                    },
                    value: "7".to_owned(),
                }],
            )
            .expect("nothing to record");
        assert!(
            backend
                .settings_base("/games/f2")
                .expect("a record")
                .is_empty()
        );
    }

    #[test]
    fn a_mod_no_known_feed_carries_has_no_versions_to_offer() {
        let (backend, _) = backend_with(&[]);
        let err = backend.mod_versions("nobody", None).expect_err("no feed");
        assert!(format!("{err}").contains("No known feed carries"), "{err}");
    }

    #[test]
    fn every_engine_zax_knows_is_listed_against_this_machine() {
        let (backend, _) = backend_with(&[]);
        let listed = backend.machine_engines().expect("a listing");
        assert_eq!(listed.len(), ENGINES.len());
        for one in &listed {
            // Either a build or the sentence saying there is none - never both, and never neither.
            assert_eq!(one.build.is_none(), one.why.is_some(), "{one:?}");
            assert!(one.versions.is_empty(), "nothing has been fetched here");
        }
    }

    #[test]
    fn cancelling_with_nothing_running_is_not_an_error() {
        // A step that finished between the click and this arriving is not an error anyone can act on.
        let (backend, _) = backend_with(&[]);
        backend.cancel();
    }

    #[test]
    fn a_long_operation_reports_its_steps_to_the_shell() {
        let shell = Arc::new(TestShell::default());
        let platform = Arc::new(MemoryPlatform::new(MemoryOptions::default()));
        let backend = Backend::new(
            Arc::clone(&platform) as Arc<dyn Platform>,
            Arc::clone(&shell) as Arc<dyn Shell>,
        );
        // Nothing answers the feed, so the update fails - but the step before it was still reported.
        backend
            .update_sfall(&install(), "4.5")
            .expect_err("nothing serves the archive");
        let said = shell
            .said
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        assert!(
            said.iter().any(|one| one.step.contains("sfall 4.5")),
            "{said:?}"
        );
        assert!(
            said.iter()
                .all(|one| !one.cancellable || one.received.is_some())
        );
    }

    #[test]
    fn the_operation_slot_is_cleared_when_the_operation_ends() {
        let (backend, _) = backend_with(&[]);
        backend
            .update_sfall(&install(), "4.5")
            .expect_err("nothing serves the archive");
        assert!(
            backend
                .running
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .is_none(),
            "a click landing now must not reach a finished operation"
        );
    }

    #[test]
    fn a_folder_the_shell_picked_is_what_comes_back() {
        let platform = Arc::new(MemoryPlatform::new(MemoryOptions::default()));
        let shell = TestShell {
            folder: Some("/games/f2".to_owned()),
            said: StdMutex::new(Vec::new()),
        };
        let backend = Backend::new(platform as Arc<dyn Platform>, Arc::new(shell));
        assert_eq!(
            backend.choose_folder(None).expect("a pick"),
            Some("/games/f2".to_owned())
        );
    }
}

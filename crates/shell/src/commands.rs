//! Every backend operation, as one command apiece.
//!
//! This is the boundary the interface calls across, and the TypeScript's `BACKEND_METHODS` in another
//! form: there, a hand-kept list of names had to be registered on one side and wrapped on the other,
//! and a test asserted it covered the interface. Here the handler list below is the only list, the
//! compiler checks every entry names a real function, and `zax_commands!` makes the list and the
//! registration one declaration - so the two halves cannot drift apart because there is only one half.
//!
//! Every command is `async` so Tauri runs it on the async runtime rather than the thread that draws;
//! each then hands its blocking work to `spawn_blocking`, because the seam under it is synchronous and
//! an install takes minutes.

use std::collections::BTreeMap;
use std::sync::Arc;

use tauri::State;
use zax_core::config_io::{ConfigFileContents, SaveOutcome, SaveRequest};
use zax_core::install::{GameType, Install};
use zax_core::state::{AppState, LoadedState};
use zax_core::updates::ZaxRelease;
use zax_fallout2::backend::{
    Backend, EngineListing, InstallOutcome, InstallPlan, MachineDescription, ModSettingsGroup,
    OpenTarget, WipeTarget,
};
use zax_fallout2::debug_package::DebugPackage;
use zax_fallout2::engine_choice::BuildPick;
use zax_fallout2::engine_release::EngineRelease;
use zax_fallout2::mod_feed::{ModFeedListing, ModInstallState};
use zax_fallout2::mod_install::ModRemoval;
use zax_fallout2::mods::{ModsSaveRequest, ModsSnapshot, OrderSwap};
use zax_fallout2::reconcile_settings::HeldTarget;
use zax_fallout2::records::InstalledEngine;
use zax_fallout2::sfall::{SfallRelease, SfallUpdate};

/// What a command answers with when the operation refused. The interface shows the sentence; the kind
/// does not survive the channel, which is why every refusal in the domain is written for a reader.
pub type Answer<T> = std::result::Result<T, String>;

/// The backend as the commands hold it. One per window, built at startup, and borrowed for the length
/// of the message being answered.
pub type Held<'a> = State<'a, Arc<Backend>>;

/// Runs a blocking operation off the thread that draws, answering with its message where it refused.
///
/// The seam is synchronous by design, so every command that touches it blocks; `spawn_blocking` is
/// where that blocking is allowed to happen. A worker that panicked is reported rather than silently
/// dropped, since the interface is waiting on this.
async fn off_thread<T, F>(backend: &Arc<Backend>, work: F) -> Answer<T>
where
    T: Send + 'static,
    F: FnOnce(&Backend) -> zax_platform::Result<T> + Send + 'static,
{
    let held = Arc::clone(backend);
    match tauri::async_runtime::spawn_blocking(move || work(&held)).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(err)) => Err(err.to_string()),
        Err(err) => Err(format!("The operation stopped unexpectedly: {err}")),
    }
}

/// The same, for an operation that cannot fail. Its answer still crosses the channel, so it still runs
/// off the drawing thread.
async fn off_thread_infallible<T, F>(backend: &Arc<Backend>, work: F) -> Answer<T>
where
    T: Send + 'static,
    F: FnOnce(&Backend) -> T + Send + 'static,
{
    off_thread(backend, move |backend| Ok(work(backend))).await
}

// --- what the machine is ----------------------------------------------------------------------

#[tauri::command]
pub async fn describe(backend: Held<'_>) -> Answer<MachineDescription> {
    off_thread_infallible(&backend, Backend::describe).await
}

#[tauri::command]
pub async fn choose_folder(backend: Held<'_>, holding: Option<String>) -> Answer<Option<String>> {
    off_thread(&backend, move |backend| {
        backend.choose_folder(holding.as_deref())
    })
    .await
}

// --- the application's own state --------------------------------------------------------------

#[tauri::command]
pub async fn load_state(backend: Held<'_>) -> Answer<LoadedState> {
    off_thread(&backend, Backend::load_state).await
}

#[tauri::command]
pub async fn save_state(backend: Held<'_>, state: AppState) -> Answer<()> {
    off_thread(&backend, move |backend| backend.save_state(&state)).await
}

// --- the game's config files --------------------------------------------------------------------

#[tauri::command]
pub async fn load_config_files(
    backend: Held<'_>,
    install_path: String,
) -> Answer<ConfigFileContents> {
    off_thread(&backend, move |backend| {
        backend.load_config_files(&install_path)
    })
    .await
}

#[tauri::command]
pub async fn save_config_files(backend: Held<'_>, request: SaveRequest) -> Answer<SaveOutcome> {
    off_thread(&backend, move |backend| backend.save_config_files(&request)).await
}

#[tauri::command]
pub async fn settings_base(
    backend: Held<'_>,
    install_path: String,
) -> Answer<BTreeMap<String, String>> {
    off_thread(&backend, move |backend| {
        backend.settings_base(&install_path)
    })
    .await
}

#[tauri::command]
pub async fn accept_settings_base(
    backend: Held<'_>,
    install_path: String,
    at: Vec<HeldTarget>,
) -> Answer<()> {
    off_thread(&backend, move |backend| {
        backend.accept_settings_base(&install_path, &at)
    })
    .await
}

// --- the mods folder ------------------------------------------------------------------------------

#[tauri::command]
pub async fn load_mods(backend: Held<'_>, install: Install) -> Answer<ModsSnapshot> {
    off_thread(&backend, move |backend| backend.load_mods(&install)).await
}

#[tauri::command]
pub async fn save_mods(backend: Held<'_>, request: ModsSaveRequest) -> Answer<SaveOutcome> {
    off_thread(&backend, move |backend| backend.save_mods(&request)).await
}

// --- the mods themselves --------------------------------------------------------------------------

#[tauri::command]
pub async fn published_mods(backend: Held<'_>, refresh: Option<bool>) -> Answer<ModFeedListing> {
    off_thread_infallible(&backend, move |backend| {
        backend.published_mods(refresh.unwrap_or(false))
    })
    .await
}

#[tauri::command]
pub async fn mod_install_state(backend: Held<'_>, install: Install) -> Answer<ModInstallState> {
    off_thread(&backend, move |backend| backend.mod_install_state(&install)).await
}

#[tauri::command]
pub async fn plan_mod(
    backend: Held<'_>,
    install: Install,
    mod_id: String,
    choices: Option<Vec<String>>,
    answers: Option<BTreeMap<String, String>>,
    version: Option<String>,
) -> Answer<InstallPlan> {
    off_thread(&backend, move |backend| {
        backend.plan_mod(
            &install,
            &mod_id,
            &choices.unwrap_or_default(),
            &answers.unwrap_or_default(),
            version.as_deref(),
        )
    })
    .await
}

#[tauri::command]
pub async fn install_mod(
    backend: Held<'_>,
    install: Install,
    mod_id: String,
    fingerprint: String,
    choices: Option<Vec<String>>,
    answers: Option<BTreeMap<String, String>>,
    version: Option<String>,
) -> Answer<InstallOutcome> {
    off_thread(&backend, move |backend| {
        backend.install_mod(
            &install,
            &mod_id,
            &fingerprint,
            &choices.unwrap_or_default(),
            &answers.unwrap_or_default(),
            version.as_deref(),
        )
    })
    .await
}

#[tauri::command]
pub async fn mod_versions(
    backend: Held<'_>,
    mod_id: String,
    above: Option<String>,
) -> Answer<Vec<String>> {
    off_thread(&backend, move |backend| {
        backend.mod_versions(&mod_id, above.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn restore_mod(backend: Held<'_>, install: Install, mod_id: String) -> Answer<()> {
    off_thread(&backend, move |backend| {
        backend.restore_mod(&install, &mod_id)
    })
    .await
}

#[tauri::command]
pub async fn remove_mod(backend: Held<'_>, install: Install, mod_id: String) -> Answer<ModRemoval> {
    off_thread(&backend, move |backend| {
        backend.remove_mod(&install, &mod_id)
    })
    .await
}

#[tauri::command]
pub async fn mod_settings(backend: Held<'_>, install: Install) -> Answer<Vec<ModSettingsGroup>> {
    off_thread(&backend, move |backend| backend.mod_settings(&install)).await
}

#[tauri::command]
pub async fn open_mod_file(
    backend: Held<'_>,
    install: Install,
    mod_id: String,
    file: String,
) -> Answer<()> {
    off_thread(&backend, move |backend| {
        backend.open_mod_file(&install, &mod_id, &file)
    })
    .await
}

// --- finding installs -----------------------------------------------------------------------------

#[tauri::command]
pub async fn identify_install(backend: Held<'_>, path: String) -> Answer<Option<GameType>> {
    off_thread_infallible(&backend, move |backend| backend.identify_install(&path)).await
}

#[tauri::command]
pub async fn scan_for_installs(backend: Held<'_>, known: Vec<Install>) -> Answer<Vec<Install>> {
    off_thread_infallible(&backend, move |backend| backend.scan_for_installs(&known)).await
}

// --- sfall ----------------------------------------------------------------------------------------

#[tauri::command]
pub async fn installed_sfall_version(
    backend: Held<'_>,
    install: Install,
) -> Answer<Option<String>> {
    off_thread(&backend, move |backend| {
        backend.installed_sfall_version(&install)
    })
    .await
}

#[tauri::command]
pub async fn latest_sfall(backend: Held<'_>) -> Answer<SfallRelease> {
    off_thread(&backend, Backend::latest_sfall).await
}

#[tauri::command]
pub async fn update_sfall(
    backend: Held<'_>,
    install: Install,
    version: String,
) -> Answer<SfallUpdate> {
    off_thread(&backend, move |backend| {
        backend.update_sfall(&install, &version)
    })
    .await
}

#[tauri::command]
pub async fn list_sfall_versions(backend: Held<'_>) -> Answer<Vec<String>> {
    off_thread(&backend, Backend::list_sfall_versions).await
}

// --- the alternative engines ----------------------------------------------------------------------

#[tauri::command]
pub async fn machine_engines(backend: Held<'_>) -> Answer<Vec<EngineListing>> {
    off_thread(&backend, Backend::machine_engines).await
}

#[tauri::command]
pub async fn deployed_engines(backend: Held<'_>, install: Install) -> Answer<Vec<InstalledEngine>> {
    off_thread(&backend, move |backend| backend.deployed_engines(&install)).await
}

#[tauri::command]
pub async fn engine_releases(backend: Held<'_>, engine_id: String) -> Answer<Vec<EngineRelease>> {
    off_thread(&backend, move |backend| backend.engine_releases(&engine_id)).await
}

#[tauri::command]
pub async fn fetch_engine(
    backend: Held<'_>,
    engine_id: String,
    published: Option<String>,
) -> Answer<EngineRelease> {
    off_thread(&backend, move |backend| {
        backend.fetch_engine(&engine_id, published.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn forget_engine(backend: Held<'_>, engine_id: String, published: String) -> Answer<()> {
    off_thread(&backend, move |backend| {
        backend.forget_engine(&engine_id, &published)
    })
    .await
}

#[tauri::command]
pub async fn use_engine_build(
    backend: Held<'_>,
    install: Install,
    engine_id: String,
    pick: BuildPick,
) -> Answer<()> {
    off_thread(&backend, move |backend| {
        backend.use_engine_build(&install, &engine_id, &pick)
    })
    .await
}

// --- the rest -------------------------------------------------------------------------------------

#[tauri::command]
pub async fn installed_hires_version(
    backend: Held<'_>,
    install: Install,
) -> Answer<Option<String>> {
    off_thread(&backend, move |backend| {
        backend.installed_hires_version(&install)
    })
    .await
}

#[tauri::command]
pub async fn latest_zax(backend: Held<'_>) -> Answer<ZaxRelease> {
    off_thread(&backend, Backend::latest_zax).await
}

#[tauri::command]
pub async fn list_saves(backend: Held<'_>, install: Install) -> Answer<Vec<String>> {
    off_thread(&backend, move |backend| backend.list_saves(&install)).await
}

#[tauri::command]
pub async fn create_debug_package(
    backend: Held<'_>,
    install: Install,
    saves: Vec<String>,
) -> Answer<DebugPackage> {
    off_thread(&backend, move |backend| {
        backend.create_debug_package(&install, &saves)
    })
    .await
}

#[tauri::command]
pub async fn order_swap(
    backend: Held<'_>,
    install: Install,
    engine_id: Option<String>,
) -> Answer<Option<OrderSwap>> {
    off_thread(&backend, move |backend| {
        backend.order_swap(&install, engine_id.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn launch(
    backend: Held<'_>,
    install: Install,
    sfall_version: Option<String>,
    engine_id: Option<String>,
    pick: Option<BuildPick>,
) -> Answer<()> {
    off_thread(&backend, move |backend| {
        backend.launch(
            &install,
            sfall_version.as_deref(),
            engine_id.as_deref(),
            pick.as_ref(),
        )
    })
    .await
}

#[tauri::command]
pub async fn open(backend: Held<'_>, target: OpenTarget) -> Answer<()> {
    off_thread(&backend, move |backend| backend.open(&target)).await
}

#[tauri::command]
pub async fn wipe(backend: Held<'_>, which: WipeTarget) -> Answer<()> {
    off_thread(&backend, move |backend| backend.wipe(which)).await
}

/// Not off the thread and not fallible: it sets a flag the running operation reads, and the whole
/// point is that it answers while that operation is still going.
#[tauri::command]
pub fn cancel(backend: Held<'_>) {
    backend.cancel();
}

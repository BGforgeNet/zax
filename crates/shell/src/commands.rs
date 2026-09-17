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
use zax_core::install::{Theme, WineConfig};
use zax_fallout2::backend::{
    Answered, AppView, Backend, InstallPlan, InstallReport, ModInstallRequest, OpenTarget,
    OrderEdit, SaveRefusal, SettingEdit, Started, WipeTarget,
};
use zax_fallout2::catalog_view::{CatalogView, SearchResults, catalog_view, search_settings};
use zax_fallout2::debug_package::DebugPackage;
use zax_fallout2::engine_choice::BuildPick;
use zax_fallout2::engine_release::EngineRelease;
use zax_fallout2::manifest::ModPart;
use zax_fallout2::mod_choice::{ChoiceGroup, toggle_option};
use zax_fallout2::mods::OrderSwap;
use zax_fallout2::settings_session::Requirement;
use zax_fallout2::sfall::SfallUpdate;
use zax_platform::OperatingSystem;

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

// --- the view -------------------------------------------------------------------------------------

#[tauri::command]
pub async fn start(backend: Held<'_>, version: String) -> Answer<Started> {
    off_thread(&backend, move |backend| backend.start(&version)).await
}

#[tauri::command]
pub async fn view(backend: Held<'_>) -> Answer<AppView> {
    off_thread_infallible(&backend, Backend::view).await
}

/// Not off the thread: it answers from tables built once, and touches nothing.
#[tauri::command]
pub fn catalog() -> CatalogView {
    catalog_view().clone()
}

#[tauri::command]
pub async fn search(backend: Held<'_>, query: String) -> Answer<SearchResults> {
    off_thread_infallible(&backend, move |backend| {
        search_settings(&query, backend.describe().os != OperatingSystem::Windows)
    })
    .await
}

#[tauri::command]
pub async fn choose_folder(backend: Held<'_>, holding: Option<String>) -> Answer<Option<String>> {
    off_thread(&backend, move |backend| {
        backend.choose_folder(holding.as_deref())
    })
    .await
}

// --- the list of installs -------------------------------------------------------------------------

#[tauri::command]
pub async fn select_install(backend: Held<'_>, path: String) -> Answer<AppView> {
    off_thread(&backend, move |backend| backend.select_install(&path)).await
}

#[tauri::command]
pub async fn refresh(backend: Held<'_>) -> Answer<AppView> {
    off_thread(&backend, Backend::refresh).await
}

#[tauri::command]
pub async fn add_install(backend: Held<'_>, path: String) -> Answer<Answered<Option<String>>> {
    off_thread(&backend, move |backend| backend.add_install(&path)).await
}

#[tauri::command]
pub async fn remove_install(backend: Held<'_>, path: String) -> Answer<AppView> {
    off_thread(&backend, move |backend| backend.remove_install(&path)).await
}

#[tauri::command]
pub async fn set_alias(backend: Held<'_>, path: String, name: String) -> Answer<AppView> {
    off_thread(&backend, move |backend| backend.set_alias(&path, &name)).await
}

#[tauri::command]
pub async fn set_wine(backend: Held<'_>, path: String, wine: WineConfig) -> Answer<AppView> {
    off_thread(&backend, move |backend| backend.set_wine(&path, &wine)).await
}

#[tauri::command]
pub async fn set_theme(backend: Held<'_>, theme: Theme) -> Answer<AppView> {
    off_thread(&backend, move |backend| backend.set_theme(theme)).await
}

#[tauri::command]
pub async fn set_autosave(backend: Held<'_>, on: bool) -> Answer<AppView> {
    off_thread(&backend, move |backend| backend.set_autosave(on)).await
}

#[tauri::command]
pub async fn accept_caution(backend: Held<'_>, engine_id: String) -> Answer<AppView> {
    off_thread(&backend, move |backend| backend.accept_caution(&engine_id)).await
}

#[tauri::command]
pub async fn scan(backend: Held<'_>) -> Answer<Answered<usize>> {
    off_thread(&backend, Backend::scan).await
}

// --- editing the selected install -----------------------------------------------------------------

#[tauri::command]
pub async fn set_settings(backend: Held<'_>, edits: Vec<SettingEdit>) -> Answer<AppView> {
    off_thread(&backend, move |backend| backend.set_settings(&edits)).await
}

#[tauri::command]
pub async fn revert_settings(backend: Held<'_>, ids: Vec<String>, all: bool) -> Answer<AppView> {
    off_thread(&backend, move |backend| backend.revert_settings(&ids, all)).await
}

#[tauri::command]
pub async fn apply_action(backend: Held<'_>, action_id: String) -> Answer<AppView> {
    off_thread(&backend, move |backend| backend.apply_action(&action_id)).await
}

#[tauri::command]
pub async fn satisfy_gate(
    backend: Held<'_>,
    id: String,
    group: Option<String>,
) -> Answer<Answered<Vec<Requirement>>> {
    off_thread(&backend, move |backend| {
        backend.satisfy_gate(&id, group.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn choose_linked(backend: Held<'_>, id: String, value: String) -> Answer<AppView> {
    off_thread(&backend, move |backend| backend.choose_linked(&id, &value)).await
}

#[tauri::command]
pub async fn edit_order(backend: Held<'_>, edit: OrderEdit) -> Answer<AppView> {
    off_thread(&backend, move |backend| backend.edit_order(&edit)).await
}

#[tauri::command]
pub async fn save(backend: Held<'_>) -> Answer<Answered<Option<SaveRefusal>>> {
    off_thread(&backend, Backend::save).await
}

// --- what has been published ----------------------------------------------------------------------

#[tauri::command]
pub async fn check_zax(backend: Held<'_>) -> Answer<AppView> {
    off_thread(&backend, Backend::check_zax).await
}

#[tauri::command]
pub async fn check_sfall(backend: Held<'_>) -> Answer<AppView> {
    off_thread(&backend, Backend::check_sfall).await
}

#[tauri::command]
pub async fn check_engine(backend: Held<'_>, engine_id: String) -> Answer<AppView> {
    off_thread(&backend, move |backend| backend.check_engine(&engine_id)).await
}

#[tauri::command]
pub async fn list_sfall_versions(backend: Held<'_>) -> Answer<Vec<String>> {
    off_thread(&backend, Backend::list_sfall_versions).await
}

#[tauri::command]
pub async fn change_sfall(
    backend: Held<'_>,
    version: Option<String>,
) -> Answer<Answered<SfallUpdate>> {
    off_thread(&backend, move |backend| {
        backend.change_sfall(version.as_deref())
    })
    .await
}

// --- mods -----------------------------------------------------------------------------------------

#[tauri::command]
pub async fn read_mod_listing(backend: Held<'_>, refresh: bool) -> Answer<AppView> {
    off_thread(&backend, move |backend| backend.read_mod_listing(refresh)).await
}

#[tauri::command]
pub async fn plan_mod(
    backend: Held<'_>,
    mod_id: String,
    choices: Option<Vec<String>>,
    answers: Option<BTreeMap<String, String>>,
    version: Option<String>,
) -> Answer<InstallPlan> {
    off_thread(&backend, move |backend| {
        backend.plan_selected_mod(
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
    request: ModInstallRequest,
) -> Answer<Answered<InstallReport>> {
    off_thread(&backend, move |backend| {
        backend.install_mod_and_read(&request)
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
pub async fn restore_mod(backend: Held<'_>, mod_id: String) -> Answer<AppView> {
    off_thread(&backend, move |backend| {
        backend.restore_mod_and_read(&mod_id)
    })
    .await
}

#[tauri::command]
pub async fn remove_mod(backend: Held<'_>, mod_id: String) -> Answer<AppView> {
    off_thread(&backend, move |backend| {
        backend.remove_mod_and_read(&mod_id)
    })
    .await
}

#[tauri::command]
pub async fn open_mod_file(backend: Held<'_>, mod_id: String, file: String) -> Answer<()> {
    off_thread(&backend, move |backend| {
        backend.open_selected_mod_file(&mod_id, &file)
    })
    .await
}

/// Not off the thread: a pure rule over what the caller already holds.
#[tauri::command]
pub fn toggle_mod_part(
    groups: Vec<ChoiceGroup<ModPart>>,
    chosen: Vec<String>,
    id: String,
    on: bool,
) -> Vec<String> {
    toggle_option(&groups, &chosen, &id, on)
}

// --- the alternative engines ----------------------------------------------------------------------

#[tauri::command]
pub async fn fetch_engine(
    backend: Held<'_>,
    engine_id: String,
    published: Option<String>,
) -> Answer<Answered<EngineRelease>> {
    off_thread(&backend, move |backend| {
        backend.fetch_engine_and_list(&engine_id, published.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn forget_engine(
    backend: Held<'_>,
    engine_id: String,
    published: String,
) -> Answer<AppView> {
    off_thread(&backend, move |backend| {
        backend.forget_engine_and_list(&engine_id, &published)
    })
    .await
}

#[tauri::command]
pub async fn use_engine_build(
    backend: Held<'_>,
    engine_id: String,
    pick: BuildPick,
) -> Answer<AppView> {
    off_thread(&backend, move |backend| {
        backend.use_engine_build_here(&engine_id, &pick)
    })
    .await
}

#[tauri::command]
pub async fn order_swap(backend: Held<'_>, engine_id: Option<String>) -> Answer<Option<OrderSwap>> {
    off_thread(&backend, move |backend| {
        backend.selected_order_swap(engine_id.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn launch(
    backend: Held<'_>,
    engine_id: Option<String>,
    pick: Option<BuildPick>,
) -> Answer<AppView> {
    off_thread(&backend, move |backend| {
        backend.launch_selected(engine_id.as_deref(), pick.as_ref())
    })
    .await
}

// --- the rest -------------------------------------------------------------------------------------

#[tauri::command]
pub async fn list_saves(backend: Held<'_>) -> Answer<Vec<String>> {
    off_thread(&backend, Backend::selected_saves).await
}

#[tauri::command]
pub async fn create_debug_package(backend: Held<'_>, saves: Vec<String>) -> Answer<DebugPackage> {
    off_thread(&backend, move |backend| {
        backend.selected_debug_package(&saves)
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

/// What the interface says is running, which the window asks about before it closes on it.
#[tauri::command]
pub fn set_busy(busy: State<'_, crate::closing::Busy>, what: Option<String>) {
    busy.set(what.as_deref());
}

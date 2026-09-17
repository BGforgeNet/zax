//! Window lifecycle and the command surface.
//!
//! The Electron main process' counterpart. Nothing domain-shaped lives here: the window is built, the
//! seam and the backend behind it are made once, and every operation the interface can ask for is
//! registered as a command.

pub mod commands;
pub mod shell;

use std::sync::{Arc, OnceLock};

use tauri::Manager as _;
use zax_core::log::{LogLevel, append_log};
use zax_fallout2::backend::{Backend, Shell as _};
use zax_host::HostPlatform;
use zax_host::net::AttemptNote;
use zax_platform::Platform;

use crate::shell::WindowShell;

/// Every command the interface may call.
///
/// One list, named once. The TypeScript kept a list of method names that the main process registered
/// from and the preload wrapped, with a test asserting the list covered the interface; here the
/// generated handler is the registration, and a name that does not resolve to a command is a build
/// failure rather than a channel nobody answers.
macro_rules! zax_commands {
    () => {
        tauri::generate_handler![
            commands::start,
            commands::view,
            commands::catalog,
            commands::search,
            commands::choose_folder,
            commands::select_install,
            commands::refresh,
            commands::add_install,
            commands::remove_install,
            commands::set_alias,
            commands::set_wine,
            commands::set_theme,
            commands::set_autosave,
            commands::accept_caution,
            commands::scan,
            commands::set_setting,
            commands::set_percent,
            commands::revert_settings,
            commands::apply_action,
            commands::satisfy_gate,
            commands::choose_linked,
            commands::edit_order,
            commands::save,
            commands::check_zax,
            commands::check_sfall,
            commands::check_engine,
            commands::list_sfall_versions,
            commands::change_sfall,
            commands::read_mod_listing,
            commands::plan_mod,
            commands::install_mod,
            commands::mod_versions,
            commands::restore_mod,
            commands::remove_mod,
            commands::open_mod_file,
            commands::toggle_mod_part,
            commands::fetch_engine,
            commands::forget_engine,
            commands::use_engine_build,
            commands::order_swap,
            commands::launch,
            commands::list_saves,
            commands::create_debug_package,
            commands::open,
            commands::wipe,
            commands::cancel,
        ]
    };
}

/// One line per download attempt, so a report from a user on a poor connection says which part failed
/// and how far it got. An attempt that did not finish is a warning even though the download as a whole
/// may still succeed: it is the line such a report is read for, and it should not sit among the
/// ordinary ones.
fn download_note(
    platform: Arc<OnceLock<Arc<dyn Platform>>>,
    clock: Arc<WindowShell>,
) -> impl Fn(&AttemptNote) + Send + Sync {
    move |note| {
        let Some(platform) = platform.get() else {
            return;
        };
        let size = note.total.map_or_else(
            || format!("{} bytes", note.received),
            |total| format!("{}/{total} bytes", note.received),
        );
        let resumed = if note.resumed_from > 0 {
            format!(", resumed from {}", note.resumed_from)
        } else {
            String::new()
        };
        let level = if note.outcome == "ok" {
            LogLevel::Info
        } else {
            LogLevel::Warn
        };
        append_log(
            platform.as_ref(),
            level,
            &format!(
                "download {}: {} attempt {}, {size} in {}ms{resumed}",
                note.outcome, note.url, note.attempt, note.millis
            ),
            clock.utc(),
        );
    }
}

/// Builds the application and runs it to completion.
///
/// # Errors
///
/// Returns the Tauri error when the webview cannot be created - on Windows the usual cause is a host
/// with no WebView2 runtime, which is a user-fixable condition rather than a bug.
pub fn run() -> tauri::Result<()> {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // The shell needs the window's handle, and the backend needs the shell, so both are made
            // here rather than before the builder runs.
            let window = Arc::new(WindowShell::new(app.handle().clone()));
            // A download's log line goes through the seam like every other write, and the seam is what
            // is being built - so the sink is handed the platform once it exists. Nothing can download
            // before the window is up, so no note can arrive before it is filled.
            let logging: Arc<OnceLock<Arc<dyn Platform>>> = Arc::new(OnceLock::new());
            let platform: Arc<dyn Platform> = Arc::new(HostPlatform::new(Some(Box::new(
                download_note(Arc::clone(&logging), Arc::clone(&window)),
            ))));
            let _ = logging.set(Arc::clone(&platform));
            app.manage(Arc::new(Backend::new(platform, window)));
            Ok(())
        })
        .invoke_handler(zax_commands!())
        .run(tauri::generate_context!())
}

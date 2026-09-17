//! Window lifecycle and the command surface.
//!
//! The Electron main process' counterpart. Nothing domain-shaped lives here: the window is built, the
//! seam and the backend behind it are made once, and every operation the interface can ask for is
//! registered as a command.

pub mod closing;
pub mod commands;
pub mod shell;
pub mod window;

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
            commands::set_settings,
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
            commands::set_busy,
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

/// A crash takes the window with it, and a release build aborts on panic, so this line in the log is the
/// only trace a bug report can carry. The default hook still runs after it, for a terminal that is watching.
fn log_panics(platform: Arc<dyn Platform>, clock: Arc<WindowShell>) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        append_log(
            platform.as_ref(),
            LogLevel::Error,
            &format!("panic: {info}"),
            clock.utc(),
        );
        previous(info);
    }));
}

/// Builds the application and runs it to completion.
///
/// # Errors
///
/// Returns the Tauri error when the webview cannot be created - on Windows the usual cause is a host
/// with no WebView2 runtime, which is a user-fixable condition rather than a bug.
pub fn run() -> tauri::Result<()> {
    tauri::Builder::default()
        // First, so a second launch is turned away before it builds anything: one instance edits one set of
        // files, and a second would let two windows disagree about what is on disk.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window(window::MAIN) {
                // Best effort: the second launch has already been turned away, which is the part that matters.
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        // No menu is set. Tauri draws none on Windows and Linux, and its macOS default is the standard system
        // bar menus with no devtools or zoom entries - its Edit menu being what Cmd-C and Cmd-V route through.
        .manage(closing::Busy::default())
        .on_window_event(closing::on_window_event)
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
            log_panics(Arc::clone(&platform), Arc::clone(&window));
            crate::window::build(app, &platform, &window)?;
            app.manage(Arc::new(Backend::new(platform, window)));
            Ok(())
        })
        .invoke_handler(zax_commands!())
        .run(tauri::generate_context!())
}

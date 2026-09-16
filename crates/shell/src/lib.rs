//! Window lifecycle and the command surface.

/// Builds the application and runs it to completion.
///
/// # Errors
///
/// Returns the Tauri error when the webview cannot be created - on Windows the usual cause is a
/// host with no WebView2 runtime, which is a user-fixable condition rather than a bug.
pub fn run() -> tauri::Result<()> {
    tauri::Builder::default().run(tauri::generate_context!())
}

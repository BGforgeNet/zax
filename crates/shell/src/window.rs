//! The window, and what it may reach.
//!
//! The interface is local, and the commands answer whatever page the window shows - so the window stays on
//! its own content, and a web link is handed to the desktop's browser rather than loaded in its place.

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{App, Manager as _, Url, WebviewUrl, WebviewWindowBuilder};
use zax_core::log::{LogLevel, append_log};
use zax_fallout2::backend::Shell as _;
use zax_platform::Platform;

use crate::closing::Busy;
use crate::shell::WindowShell;

/// The one window's label, which a second instance looks it up by.
pub const MAIN: &str = "main";

/// Whether a target may be handed to the desktop's own handler. Handing it an arbitrary scheme is how a
/// `file://` path or a registered protocol becomes code execution, so only the two a link can carry are.
#[must_use]
pub fn is_web_url(target: &Url) -> bool {
    matches!(target.scheme(), "https" | "http")
}

/// Whether a target is the interface itself: the dev server's origin when one is serving it, otherwise the
/// address Tauri serves the built files under - `tauri://localhost`, or `http(s)://tauri.localhost` on
/// Windows, as `tauri`'s own manager resolves an app URL.
#[must_use]
pub fn is_own_content(target: &Url, dev_server: Option<&Url>) -> bool {
    if let Some(dev) = dev_server {
        return target.origin() == dev.origin();
    }
    matches!(
        (target.scheme(), target.host_str()),
        ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost"))
    )
}

/// Opens what a link asked for in the browser, or refuses it into the log.
fn hand_outwards(platform: &dyn Platform, clock: &WindowShell, target: &Url, what: &str) {
    if is_web_url(target) {
        if let Err(err) = platform.process().open(Path::new(target.as_str())) {
            append_log(
                platform,
                LogLevel::Warn,
                &format!("could not open {target}: {err}"),
                clock.utc(),
            );
        }
        return;
    }
    append_log(
        platform,
        LogLevel::Warn,
        &format!("refused to {what} {target}"),
        clock.utc(),
    );
}

/// Builds the window with its guards. Hidden until the page has loaded, so it does not flash empty on a
/// slow first paint.
///
/// # Errors
///
/// Returns the Tauri error when the webview cannot be created.
pub fn build(
    app: &App,
    platform: &Arc<dyn Platform>,
    clock: &Arc<WindowShell>,
) -> tauri::Result<()> {
    let dev_server = if tauri::is_dev() {
        app.config().build.dev_url.clone()
    } else {
        None
    };

    let (opening, opening_clock) = (Arc::clone(platform), Arc::clone(clock));
    let (navigating, navigating_clock) = (Arc::clone(platform), Arc::clone(clock));
    let shown = AtomicBool::new(false);

    WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title("ZAX")
        // At default text size the columns stop growing near 1240 and the rest is margin; `--col` in app.css is in
        // rem, so larger text raises that cap, and this default is sized for it.
        .inner_size(1440.0, 900.0)
        // The game list, every tab strip and the save bar fit on one line from about 970 pixels at default text
        // size, and below that the tab strips scroll their tabs out of sight; the floor leaves a fifth over it for
        // fonts wider than the ones it was measured with.
        .min_inner_size(1180.0, 640.0)
        // A settings row gives every surplus pixel to its trailing track, so a wider window shows nothing
        // more - it only pushes each revert link further from its setting. Resizing still works.
        .maximizable(false)
        .visible(false)
        .on_new_window(move |target, _features| {
            hand_outwards(opening.as_ref(), &opening_clock, &target, "open");
            NewWindowResponse::Deny
        })
        .on_navigation(move |target| {
            if is_own_content(target, dev_server.as_ref()) {
                return true;
            }
            hand_outwards(
                navigating.as_ref(),
                &navigating_clock,
                target,
                "navigate to",
            );
            false
        })
        .on_page_load(move |window, payload| {
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            // A page that has just loaded has nothing running, whatever the page before it last said; a
            // reload mid-operation would otherwise leave the window refusing to close over nothing.
            window.state::<Busy>().set(None);
            if !shown.swap(true, Ordering::Relaxed) {
                // Nothing to fall back to: a window that will not show is what the user sees either way.
                let _ = window.show();
            }
        })
        .build()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap_or_else(|err| panic!("{text} is a URL: {err}"))
    }

    #[test]
    fn only_a_web_link_is_handed_outwards() {
        assert!(is_web_url(&url("https://github.com/BGforgeNet/zax")));
        assert!(is_web_url(&url("http://example.com/")));
        assert!(!is_web_url(&url("file:///etc/passwd")));
        assert!(!is_web_url(&url("steam://run/38410")));
    }

    #[test]
    fn the_built_interface_is_own_content_under_either_address_tauri_serves_it_from() {
        assert!(is_own_content(&url("tauri://localhost/index.html"), None));
        assert!(is_own_content(
            &url("http://tauri.localhost/#settings"),
            None
        ));
        assert!(is_own_content(&url("https://tauri.localhost/"), None));
        assert!(!is_own_content(&url("https://example.com/"), None));
        // Close is not the same: a host that merely starts with the name is someone else's.
        assert!(!is_own_content(
            &url("http://tauri.localhost.example.com/"),
            None
        ));
    }

    #[test]
    fn the_window_is_granted_the_progress_subscription_the_interface_takes_out() {
        // Without it `listen` is refused, and the interface's startup - which subscribes before anything
        // else - fails before it draws a single install. Nothing but the real shell enforces the grant.
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities/main.json");
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|err| panic!("{} is readable: {err}", path.display()));
        let capability: serde_json::Value = serde_json::from_str(&text)
            .unwrap_or_else(|err| panic!("{} is JSON: {err}", path.display()));
        assert_eq!(capability["windows"], serde_json::json!([MAIN]));
        let granted = &capability["permissions"];
        for needed in ["core:event:allow-listen", "core:event:allow-unlisten"] {
            assert!(
                granted
                    .as_array()
                    .is_some_and(|all| all.iter().any(|one| one == needed)),
                "{needed} is not granted: {granted}"
            );
        }
    }

    #[test]
    fn under_the_dev_server_only_its_origin_is_own_content() {
        let dev = url("http://localhost:5173/");
        assert!(is_own_content(
            &url("http://localhost:5173/src/App.svelte"),
            Some(&dev)
        ));
        assert!(!is_own_content(&url("http://localhost:5174/"), Some(&dev)));
        assert!(!is_own_content(&url("tauri://localhost/"), Some(&dev)));
    }
}

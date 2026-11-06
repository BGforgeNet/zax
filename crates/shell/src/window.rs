//! The window, and what it may reach.
//!
//! The interface is local, and the commands answer whatever page the window shows - so the window stays on
//! its own content, and a web link is handed to the desktop's browser rather than loaded in its place.

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{
    App, LogicalPosition, LogicalSize, Manager as _, PhysicalSize, Url, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
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

    let window = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title("ZAX")
        // Where no monitor answers; `fit_to_monitor` replaces it.
        .inner_size(WIDTH, 900.0)
        // The game list, every tab strip and the save bar fit on one line from about 970 pixels at default text
        // size, and below that the tab strips scroll their tabs out of sight; the floor leaves a fifth over it for
        // fonts wider than the ones it was measured with.
        .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
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
    fit_to_monitor(&window)
}

/// The width the window opens at: the settings rows' tracks end near 1240 at default text size, and they are in
/// rem, so this leaves room for larger text.
const WIDTH: f64 = 1440.0;
/// The height the window opens at where the screen has room: every settings tab but the few long lists fits
/// without scrolling at default text size.
const HEIGHT: f64 = 1000.0;
const MIN_WIDTH: f64 = 1180.0;
const MIN_HEIGHT: f64 = 640.0;

/// The share of the work area's height the window may take, so it opens as a window with a margin above and
/// below rather than looking maximized.
const MAX_SHARE: f64 = 0.9;

/// A title bar and frame, for a window not yet mapped: GTK reports its outer size equal to its inner one until
/// the window manager has decorated it.
const CHROME: f64 = 48.0;

/// Where the window opens, in logical pixels, on a work area at `area_origin` of `area_size` when the frame
/// takes `chrome`: the usual size where it fits, shorter where the screen is, centred both ways.
#[must_use]
pub fn opening_frame(
    area_origin: LogicalPosition<f64>,
    area_size: LogicalSize<f64>,
    chrome: LogicalSize<f64>,
) -> (LogicalPosition<f64>, LogicalSize<f64>) {
    let chrome_height = chrome.height.max(CHROME);
    let inner = LogicalSize::new(
        WIDTH.min(area_size.width - chrome.width).max(MIN_WIDTH),
        HEIGHT
            .min(area_size.height * MAX_SHARE - chrome_height)
            .max(MIN_HEIGHT),
    );
    let left = area_origin.x + ((area_size.width - inner.width - chrome.width) / 2.0).max(0.0);
    let top = area_origin.y + ((area_size.height - inner.height - chrome_height) / 2.0).max(0.0);
    (LogicalPosition::new(left, top), inner)
}

/// Sizes the hidden window to the monitor it opens on. A machine with no monitor to ask keeps the builder's size.
fn fit_to_monitor(window: &WebviewWindow) -> tauri::Result<()> {
    let Some(monitor) = window.current_monitor()?.or(window.primary_monitor()?) else {
        return Ok(());
    };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let (outer, inner) = (window.outer_size()?, window.inner_size()?);
    let chrome = PhysicalSize::new(
        outer.width.saturating_sub(inner.width),
        outer.height.saturating_sub(inner.height),
    )
    .to_logical::<f64>(scale);
    let (origin, size) = opening_frame(
        area.position.to_logical(scale),
        area.size.to_logical(scale),
        chrome,
    );
    window.set_size(size)?;
    window.set_position(origin)
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
    fn the_window_opens_at_the_usual_size_where_it_fits_and_shorter_where_not_centred_both_ways() {
        // A 1440p monitor with a 48-pixel taskbar along the bottom: room for the usual size.
        let (origin, size) = opening_frame(
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(2560.0, 1392.0),
            LogicalSize::new(2.0, 37.0),
        );
        assert_eq!(size, LogicalSize::new(1440.0, 1000.0));
        assert_eq!(origin, LogicalPosition::new(559.0, 172.0));

        // A 1080p one: nine tenths of the work area, less the frame, so a margin stays above and below.
        let (origin, size) = opening_frame(
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(1920.0, 1032.0),
            LogicalSize::new(2.0, 37.0),
        );
        assert!((size.width - 1440.0).abs() < 1e-9, "{size:?}");
        assert!((size.height - 880.8).abs() < 1e-9, "{size:?}");
        assert!((origin.y - 51.6).abs() < 1e-9, "{origin:?}");

        // A taskbar along the top and a frame that reports nothing yet, as GTK's does before mapping.
        let (origin, size) = opening_frame(
            LogicalPosition::new(0.0, 40.0),
            LogicalSize::new(1366.0, 728.0),
            LogicalSize::new(0.0, 0.0),
        );
        assert_eq!(size, LogicalSize::new(1366.0, MIN_HEIGHT));
        assert_eq!(origin, LogicalPosition::new(0.0, 60.0));

        // Never under the floor, however small the screen.
        let (_, size) = opening_frame(
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(1024.0, 600.0),
            LogicalSize::new(0.0, 0.0),
        );
        assert_eq!(size, LogicalSize::new(MIN_WIDTH, MIN_HEIGHT));
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

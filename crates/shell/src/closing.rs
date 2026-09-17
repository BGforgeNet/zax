//! Asking before the window closes on a running operation.
//!
//! A close during an operation ends ZAX's part of it where it stands, so the window asks first rather than
//! taking the click as the answer. The interface says what is running; this holds that sentence and asks
//! with it.

use std::sync::Mutex;

use tauri::{Manager as _, Runtime, Window, WindowEvent};
use tauri_plugin_dialog::{DialogExt as _, MessageDialogButtons, MessageDialogKind};

/// How much of a label a dialog line can carry. Names arrive from the mod feeds, so both the length and
/// any line breaks in one are a release someone else wrote.
const LABEL_CAP: usize = 80;

/// What the interface says is running, and whether the user has already answered a close.
#[derive(Debug, Default)]
pub struct Busy {
    held: Mutex<BusyState>,
}

#[derive(Debug, Default)]
struct BusyState {
    what: Option<String>,
    /// A dialog is up, so a second click does not stack a second one on it.
    asking: bool,
    /// The user said to close anyway, so the close that follows is let through.
    leaving: bool,
}

impl Busy {
    fn state(&self) -> std::sync::MutexGuard<'_, BusyState> {
        self.held
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Records what is running, or that nothing is.
    pub fn set(&self, what: Option<&str>) {
        self.state().what = what.and_then(busy_label);
    }
}

/// What the interface says it is doing, made fit for a dialog: one line, bounded, and nothing where nothing
/// is running.
#[must_use]
pub fn busy_label(what: &str) -> Option<String> {
    let line = what.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.is_empty() {
        return None;
    }
    if line.chars().count() > LABEL_CAP {
        return Some(format!(
            "{}...",
            line.chars().take(LABEL_CAP).collect::<String>()
        ));
    }
    Some(line)
}

/// The question, in terms of the operation the user started rather than of the window. Waiting is the
/// default and the escape, since it is the answer that loses nothing.
#[must_use]
pub fn close_prompt(what: &str) -> String {
    format!(
        "{what} is still running.\n\nClosing now ends ZAX's part of it where it stands, and an operation that \
         writes to the game folder can leave it part way through."
    )
}

/// Holds a close while something runs, and asks.
pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    let busy = window.state::<Busy>();
    let mut state = busy.state();
    let Some(what) = state.what.clone() else {
        return;
    };
    if state.leaving {
        return;
    }
    api.prevent_close();
    if state.asking {
        return;
    }
    state.asking = true;
    drop(state);

    let closing = window.clone();
    window
        .dialog()
        .message(close_prompt(&what))
        .title("ZAX is working")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Close anyway".to_owned(),
            "Keep ZAX open".to_owned(),
        ))
        .show(move |close| {
            let busy = closing.state::<Busy>();
            let mut state = busy.state();
            state.asking = false;
            state.leaving = close;
            drop(state);
            if close {
                // A window that cannot be closed is worse than one closed mid-operation, which is what the
                // user just chose - so a failure here has nothing further to try.
                let _ = closing.close();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_label_is_one_line_and_bounded() {
        assert_eq!(
            busy_label("Installing\n  RPU").as_deref(),
            Some("Installing RPU")
        );
        assert_eq!(busy_label("   "), None);
        let long = "x".repeat(200);
        let held = busy_label(&long).expect("a label");
        assert_eq!(held.chars().count(), LABEL_CAP + 3);
        assert!(held.ends_with("..."));
    }

    #[test]
    fn the_question_names_the_operation_rather_than_the_window() {
        let asked = close_prompt("Installing RPU");
        assert!(asked.starts_with("Installing RPU is still running."));
        assert!(asked.contains("part way through"));
    }
}

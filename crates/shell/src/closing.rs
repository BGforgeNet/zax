//! Asking before the window closes on a running operation.
//!
//! A close during an operation ends ZAX's part of it where it stands, so the window asks first rather than
//! taking the click as the answer. The interface says what is running; this holds that sentence and asks
//! with it.

use std::sync::Mutex;

use tauri::{Manager as _, Runtime, Window, WindowEvent};
use tauri_plugin_dialog::{DialogExt as _, MessageDialogButtons, MessageDialogKind};
use zax_host::process::Running;

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
///
/// Where a mod's installer is running, closing neither waits for it nor stops it cleanly: an Inno wizard
/// writes to its own log and carries on, while a script writing to the pipe ZAX held can die at its next
/// line. So the question says either may happen, and what the next launch offers.
#[must_use]
pub fn close_prompt(what: &str, installer_running: bool) -> String {
    if installer_running {
        return format!(
            "{what} is still running.\n\nIf ZAX closes now, the mod's installer may carry on without it or stop \
             part way. Either way ZAX will not put your settings back into the files it writes; the next launch \
             offers to retry the install, which runs the installer again and then puts them back."
        );
    }
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

    let installer_running = window
        .try_state::<Running>()
        .is_some_and(|running| running.any());
    let closing = window.clone();
    window
        .dialog()
        .message(close_prompt(&what, installer_running))
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
        let asked = close_prompt("Installing RPU", false);
        assert!(asked.starts_with("Installing RPU is still running."));
        assert!(asked.contains("part way through"));
    }

    #[test]
    fn with_an_installer_running_the_question_says_it_carries_on_and_what_the_next_launch_offers() {
        let asked = close_prompt("Installing RPU 2.3", true);
        assert!(asked.starts_with("Installing RPU 2.3 is still running."));
        assert!(asked.contains("installer may carry on"), "{asked}");
        assert!(asked.contains("retry the install"), "{asked}");
    }
}

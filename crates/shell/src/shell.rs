//! What only the window can do: the folder picker, where progress goes, and the clock.
//!
//! The clock lives here rather than in the platform seam because `stamp` takes the fields rather than
//! reading them - a backup directory's name is something a test has to be able to fix in place - and
//! the host that owns the timezone is the one presenting the window.

use std::sync::mpsc;

use jiff::{Timestamp, Zoned};
use tauri::{AppHandle, Emitter as _};
use tauri_plugin_dialog::DialogExt as _;
use zax_core::stamp::{LocalTime, Utc};
use zax_fallout2::backend::{OperationProgress, Shell};
use zax_platform::{Error, Result};

/// The event a long operation's progress arrives on. One name, because the interface shows one
/// operation at a time.
pub const PROGRESS_EVENT: &str = "zax://progress";

#[derive(Debug)]
pub struct WindowShell {
    app: AppHandle,
}

impl WindowShell {
    #[must_use]
    pub const fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

/// One broken-down instant as `stamp` wants it. The fields are already in range by construction - the
/// date-time they come from is a calendar one - so the conversions below cannot narrow anything away.
fn broken_down(held: jiff::civil::DateTime) -> LocalTime {
    LocalTime {
        year: i32::from(held.year()),
        month: u8::try_from(held.month()).unwrap_or(1),
        day: u8::try_from(held.day()).unwrap_or(1),
        hour: u8::try_from(held.hour()).unwrap_or(0),
        minute: u8::try_from(held.minute()).unwrap_or(0),
        second: u8::try_from(held.second()).unwrap_or(0),
    }
}

fn local_now() -> LocalTime {
    broken_down(Zoned::now().datetime())
}

impl Shell for WindowShell {
    fn choose_folder(&self, holding: Option<&str>) -> Result<Option<String>> {
        // The picker answers on the thread that owns the window, and this call is on a worker: the
        // channel is what carries the answer back.
        let (send, receive) = mpsc::channel();
        let dialog = self.app.dialog().clone();
        match holding {
            // A folder picker hides files, so a user asked for "the folder holding master.dat" has to
            // recognise it by name alone - and the one thing that would settle it is the file they are
            // not allowed to see. Asking for the file and answering with its folder shows it to them.
            Some(named) => {
                dialog
                    .file()
                    .set_title(format!("Choose the folder holding {named}"))
                    .add_filter(named, &[named.rsplit('.').next().unwrap_or(named)])
                    .pick_file(move |held| {
                        let _ = send.send(held.and_then(|at| {
                            at.into_path().ok().and_then(|at| {
                                at.parent().map(|at| at.to_string_lossy().into_owned())
                            })
                        }));
                    });
            }
            None => {
                dialog.file().pick_folder(move |held| {
                    let _ = send.send(held.and_then(|at| {
                        at.into_path()
                            .ok()
                            .map(|at| at.to_string_lossy().into_owned())
                    }));
                });
            }
        }
        receive
            .recv()
            .map_err(|_| Error::Unsupported("The folder picker could not be shown.".to_owned()))
    }

    fn report(&self, progress: &OperationProgress) {
        // A window that has gone is not a failure of the operation reporting to it: the work carries
        // on and its result is what the caller acts on.
        // The domain's own shape, whose binding is what the interface reads the message as.
        let _ = self.app.emit(PROGRESS_EVENT, progress);
    }

    fn now(&self) -> LocalTime {
        local_now()
    }

    fn utc(&self) -> Utc {
        let at = Timestamp::now()
            .to_zoned(jiff::tz::TimeZone::UTC)
            .datetime();
        let held = broken_down(at);
        Utc {
            year: held.year,
            month: held.month,
            day: held.day,
            hour: held.hour,
            minute: held.minute,
            second: held.second,
            millisecond: u16::try_from(at.millisecond()).unwrap_or(0),
        }
    }

    fn millis(&self) -> i64 {
        Timestamp::now().as_millisecond()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_local_clock_answers_a_plausible_wall_time() {
        let held = local_now();
        // Past the release this was written for and inside the ranges `stamp` formats.
        assert!(held.year >= 2024, "{held:?}");
        assert!((1..=12).contains(&held.month), "{held:?}");
        assert!((1..=31).contains(&held.day), "{held:?}");
        assert!(
            held.hour < 24 && held.minute < 60 && held.second < 61,
            "{held:?}"
        );
    }

    #[test]
    fn progress_crosses_with_the_names_and_nulls_the_binding_declares() {
        let held = OperationProgress {
            step: "Downloading sfall 4.5".to_owned(),
            received: Some(1),
            total: None,
            cancellable: true,
        };
        let written = serde_json::to_string(&held).expect("a message the shell writes");
        assert!(written.contains("\"step\""), "{written}");
        assert!(written.contains("\"cancellable\":true"), "{written}");
        // A count the server did not declare is null, which is what the interface's type says it is.
        assert!(written.contains("\"total\":null"), "{written}");
    }
}

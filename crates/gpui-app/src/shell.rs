//! The backend's view of the host window: no folder picker and nowhere to show progress, which this spike's
//! one tab never asks for. The clocks are the Tauri shell's, copied: a native shell that stayed would share
//! them with it rather than keep a second copy.

use jiff::{Timestamp, Zoned};
use zax_core::stamp::{LocalTime, Utc};
use zax_fallout2::backend::{OperationProgress, Shell};
use zax_platform::Result;

#[derive(Debug, Default)]
pub struct SpikeShell;

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

impl Shell for SpikeShell {
    fn choose_folder(&self, _holding: Option<&str>) -> Result<Option<String>> {
        Ok(None)
    }

    fn report(&self, _progress: &OperationProgress) {}

    fn now(&self) -> LocalTime {
        broken_down(Zoned::now().datetime())
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

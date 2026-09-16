//! `2026-08-05_18-30-00`: the name every directory and archive this application creates is stamped
//! with. Sorts chronologically in a file manager, and carries no character a filesystem objects to.
//!
//! Taken as an argument everywhere rather than read from the clock, so what a save or a debug package
//! produces is nameable in a test. The TypeScript took a `Date` and read its local-time fields; this
//! takes the fields themselves, which keeps the clock and the host's timezone in the shell where
//! they belong and leaves this crate free of both.

/// A local wall-clock instant, already broken down by whoever owns the clock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalTime {
    pub year: i32,
    /// 1 to 12.
    pub month: u8,
    /// 1 to 31.
    pub day: u8,
    pub hour: u8,
    pub minute: u8,
    pub second: u8,
}

#[must_use]
pub fn stamp(now: LocalTime) -> String {
    format!(
        "{:04}-{:02}-{:02}_{:02}-{:02}-{:02}",
        now.year, now.month, now.day, now.hour, now.minute, now.second
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_the_documented_shape() {
        let at = LocalTime {
            year: 2026,
            month: 8,
            day: 5,
            hour: 18,
            minute: 30,
            second: 0,
        };
        assert_eq!(stamp(at), "2026-08-05_18-30-00");
    }

    #[test]
    fn pads_every_field_so_the_names_sort_chronologically() {
        let at = LocalTime {
            year: 2026,
            month: 1,
            day: 2,
            hour: 3,
            minute: 4,
            second: 5,
        };
        assert_eq!(stamp(at), "2026-01-02_03-04-05");
    }

    #[test]
    fn sorts_chronologically_as_text() {
        let earlier = stamp(LocalTime {
            year: 2026,
            month: 9,
            day: 30,
            hour: 23,
            minute: 59,
            second: 59,
        });
        let later = stamp(LocalTime {
            year: 2026,
            month: 10,
            day: 1,
            hour: 0,
            minute: 0,
            second: 0,
        });
        assert!(earlier < later, "{earlier} should sort before {later}");
    }
}

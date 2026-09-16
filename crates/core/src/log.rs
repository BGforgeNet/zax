//! The one writer of the log the interface's "open log" button points at.
//!
//! One writer because the file has a format - a timestamp, a level, then the line - and a second
//! place appending to it would drift from that format without anything failing.
//!
//! Lines are UTF-8, like the application's own state file and unlike the game's config files.
//! Latin-1 is there to round-trip a file ZAX did not write, byte for byte, through an encoding
//! nobody declared; this file is ZAX's own, and a line of it carries install paths and whatever the
//! operating system called a failure. Folding those to one byte a code point writes mojibake into
//! the file a person opens to find out what happened.

use zax_platform::Platform;

use crate::directories::log_file;
use crate::stamp::Utc;

/// What a line is about.
///
/// Three rather than the usual half-dozen: the file is read by a person looking for the failure in a
/// bug report, and the only distinction that serves them is whether a line is one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LogLevel {
    Info,
    Warn,
    Error,
}

impl LogLevel {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Info => "INFO",
            Self::Warn => "WARN",
            Self::Error => "ERROR",
        }
    }
}

/// The ceiling, and what survives being trimmed to it.
///
/// Bounded because nothing else prunes this file: it is appended to for the life of an installation,
/// and the path that writes most of it is a download retrying on a connection that keeps dropping -
/// which is exactly the run whose log matters and exactly the one that grows without limit.
const MAX_BYTES: u64 = 1024 * 1024;
const KEEP_BYTES: usize = 512 * 1024;

/// Adds a line, and never fails: this is what reports a failure, so a caller must not have to handle
/// it failing as well. The clock is an argument for the same reason it is in `stamp` - a line is
/// then assertable.
pub fn append_log(platform: &dyn Platform, level: LogLevel, text: &str, now: Utc) {
    let at = log_file(platform);
    trim(platform, &at, now);
    let line = format!("{} {} {text}\n", now.iso8601(), level.as_str());
    // There is nowhere left to report a failure to write the report.
    drop(platform.fs().append(&at, line.as_bytes()));
}

/// Drops the oldest lines once the file is past its ceiling, leaving a note where they were.
fn trim(platform: &dyn Platform, at: &std::path::Path, now: Utc) {
    let Ok(Some(stat)) = platform.fs().stat(at) else {
        return;
    };
    if stat.size <= MAX_BYTES {
        return;
    }
    let Ok(bytes) = platform.fs().read(at) else {
        return;
    };

    // Cut at a newline, which cannot occur inside a UTF-8 sequence, so the surviving bytes still
    // decode. A tail holding no newline is the end of one enormous line, and dropping it whole is
    // the only cut available - keeping it would leave the file over its ceiling and growing.
    let from = bytes.len().saturating_sub(KEEP_BYTES);
    let cut = bytes[from..]
        .iter()
        .position(|b| *b == b'\n')
        .map_or(bytes.len(), |at| from + at + 1);

    // Said in the file rather than silently: a person following a failure backwards has to know
    // where the record stops, or they read the oldest surviving line as the beginning of what
    // happened.
    let mut out = format!(
        "{} INFO log: trimmed, {cut} bytes of older lines dropped\n",
        now.iso8601()
    )
    .into_bytes();
    out.extend_from_slice(&bytes[cut..]);
    drop(platform.fs().write(at, &out));
}

#[cfg(test)]
mod tests {
    use super::*;
    use zax_platform::memory::MemoryPlatform;

    fn at(second: u8) -> Utc {
        Utc {
            year: 2026,
            month: 9,
            day: 16,
            hour: 12,
            minute: 0,
            second,
            millisecond: 0,
        }
    }

    fn log_of(platform: &MemoryPlatform) -> String {
        let path = log_file(platform);
        platform
            .text_at(&path.to_string_lossy())
            .unwrap_or_default()
    }

    #[test]
    fn a_line_carries_the_time_the_level_and_the_text() {
        let platform = MemoryPlatform::default();
        append_log(&platform, LogLevel::Info, "started", at(0));
        assert_eq!(log_of(&platform), "2026-09-16T12:00:00.000Z INFO started\n");
    }

    #[test]
    fn lines_accumulate_in_order() {
        let platform = MemoryPlatform::default();
        append_log(&platform, LogLevel::Info, "first", at(0));
        append_log(&platform, LogLevel::Error, "second", at(1));
        assert_eq!(
            log_of(&platform),
            "2026-09-16T12:00:00.000Z INFO first\n2026-09-16T12:00:01.000Z ERROR second\n"
        );
    }

    #[test]
    fn every_level_is_named_in_upper_case() {
        assert_eq!(LogLevel::Info.as_str(), "INFO");
        assert_eq!(LogLevel::Warn.as_str(), "WARN");
        assert_eq!(LogLevel::Error.as_str(), "ERROR");
    }

    #[test]
    fn a_file_under_the_ceiling_is_left_alone() {
        let platform = MemoryPlatform::default();
        let path = log_file(&platform);
        platform
            .fs()
            .write(&path, b"old line\n")
            .expect("seeding the log");
        append_log(&platform, LogLevel::Info, "new", at(0));
        assert!(log_of(&platform).starts_with("old line\n"));
    }

    #[test]
    fn a_file_past_the_ceiling_is_trimmed_and_says_so() {
        // Nothing else prunes this file, and the run that writes most of it is the one whose log
        // matters.
        let platform = MemoryPlatform::default();
        let path = log_file(&platform);
        let line = "x".repeat(99);
        let bulk = format!("{line}\n").repeat(20_000);
        assert!(
            bulk.len() as u64 > MAX_BYTES,
            "the fixture must exceed the ceiling"
        );
        platform
            .fs()
            .write(&path, bulk.as_bytes())
            .expect("seeding the log");

        append_log(&platform, LogLevel::Info, "after", at(0));

        let held = log_of(&platform);
        assert!(held.contains("log: trimmed"), "no trim note was written");
        assert!(held.ends_with("INFO after\n"), "the new line is missing");
        assert!(
            held.len() < bulk.len(),
            "the file did not shrink: {} vs {}",
            held.len(),
            bulk.len()
        );
        // The cut lands on a line boundary, so no fragment of an older line survives. Skipping the
        // trim note at the front and the line just appended at the back, every line between is a
        // whole one.
        let lines: Vec<&str> = held.lines().collect();
        let survivors = &lines[1..lines.len() - 1];
        assert!(!survivors.is_empty(), "the trim kept nothing to check");
        for kept in survivors {
            assert_eq!(*kept, line, "a partial line survived the cut");
        }
    }

    #[test]
    fn writing_never_fails_even_where_the_log_cannot_be_written() {
        // This is what reports a failure, so it must not become one. The memory platform writes
        // anywhere, so the guarantee is the signature: nothing here returns a Result to ignore.
        let platform = MemoryPlatform::default();
        append_log(&platform, LogLevel::Error, "a failure", at(0));
        assert!(log_of(&platform).contains("a failure"));
    }
}

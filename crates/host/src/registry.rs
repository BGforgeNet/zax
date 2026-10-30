//! The Windows registry, which is read by running `reg query` and reading what it printed.
//!
//! The parsing is the part worth testing on its own; the spawning around it is not.

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use zax_platform::registry::Registry;
use zax_platform::{OperatingSystem, Result};

use crate::process::run_with_timeout;

/// A wedged `reg` must not hold the scan that asked; there is nothing here worth waiting seconds for.
const REGISTRY_TIMEOUT: Duration = Duration::from_secs(5);

/// `reg query <key> /v <name>` prints the key, then one indented line per value: name, type, then the
/// data, separated by runs of spaces. Only the first two are single tokens - the data is a path and
/// holds spaces of its own, so it is whatever remains after the type.
///
/// Names are matched case-insensitively: the registry itself does not distinguish them, so neither can
/// a caller asking for one by name.
#[must_use]
pub fn registry_value(output: &str, wanted: &str) -> Option<String> {
    for line in output.lines() {
        // Indented, which is what separates a value line from the key above it.
        if !line.starts_with([' ', '\t']) {
            continue;
        }
        let mut fields = line.split_whitespace();
        let (Some(name), Some(kind)) = (fields.next(), fields.next()) else {
            continue;
        };
        if !kind.starts_with("REG_") || !name.eq_ignore_ascii_case(wanted) {
            continue;
        }
        // Whatever remains after the type, which is where a path with spaces in it lives.
        let after = line
            .split_once(kind)
            .map(|(_, rest)| rest.trim())
            .unwrap_or_default();
        // An empty value is present but says nothing; a caller wanting a path can do nothing with it.
        return (!after.is_empty()).then(|| after.to_owned());
    }
    None
}

#[derive(Debug)]
pub struct HostRegistry {
    os: OperatingSystem,
}

impl HostRegistry {
    #[must_use]
    pub const fn new(os: OperatingSystem) -> Self {
        Self { os }
    }
}

impl Registry for HostRegistry {
    fn read(&self, key: &str, value: &str) -> Result<Option<String>> {
        // Nothing to read off Windows, and running `reg` elsewhere would either fail or find some other
        // program of that name. The absence is the answer, not a failure to get one.
        if self.os != OperatingSystem::Windows {
            return Ok(None);
        }
        let mut command = Command::new("reg");
        command.args(["query", key, "/v", value]);
        // `reg` exits non-zero for a key that is not there, which is the common case rather than a
        // fault - so every failure here answers with nothing rather than propagating.
        let Ok(outcome) = run_with_timeout(command, Path::new("reg"), Some(REGISTRY_TIMEOUT))
        else {
            return Ok(None);
        };
        if outcome.code != Some(0) {
            return Ok(None);
        }
        Ok(registry_value(&outcome.output, value))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LISTING: &str = "\r\n\
        HKEY_LOCAL_MACHINE\\SOFTWARE\\GOG.com\\Games\\1207658928\r\n\
        \x20   exe    REG_SZ    C:\\Games\\Fallout 2\\fallout2.exe\r\n\
        \x20   path    REG_SZ    C:\\Games\\Fallout 2\r\n\r\n";

    #[test]
    fn a_value_is_whatever_follows_its_type() {
        // The data is a path and holds spaces of its own.
        assert_eq!(
            registry_value(LISTING, "path").as_deref(),
            Some("C:\\Games\\Fallout 2")
        );
        assert_eq!(
            registry_value(LISTING, "exe").as_deref(),
            Some("C:\\Games\\Fallout 2\\fallout2.exe")
        );
    }

    #[test]
    fn a_name_is_matched_the_way_the_registry_matches_it() {
        // The registry does not distinguish case, so neither can a caller asking by name.
        assert_eq!(
            registry_value(LISTING, "PATH").as_deref(),
            Some("C:\\Games\\Fallout 2")
        );
    }

    #[test]
    fn a_name_the_listing_does_not_carry_answers_nothing() {
        assert_eq!(registry_value(LISTING, "nothing"), None);
    }

    #[test]
    fn an_empty_value_is_present_and_says_nothing() {
        let listing = "    path    REG_SZ    \r\n";
        assert_eq!(registry_value(listing, "path"), None);
    }

    #[test]
    fn the_key_line_itself_is_not_a_value() {
        // It is not indented, which is the whole of what separates the two.
        let listing = "HKEY_LOCAL_MACHINE\\SOFTWARE\\REG_SZ\\path\r\n";
        assert_eq!(registry_value(listing, "path"), None);
    }

    #[test]
    fn nothing_is_read_off_windows() {
        let held = HostRegistry::new(OperatingSystem::Linux);
        assert_eq!(held.read("HKLM\\Software", "path").expect("a read"), None);
    }
}

//! The High Resolution Patch: which version an install has.
//!
//! Reading only, unlike sfall. The patch is distributed from a forum thread rather than a release
//! feed, so there is nothing for ZAX to install or update it from - what it can do is say which
//! version is there, which is what a bug report needs and what tells the user whether `f2_res.ini`
//! is being read by anything at all.

use zax_core::install::Install;
use zax_platform::{Platform, Result};

use crate::pe_version::installed_library_version;

/// The patch is this library; `fallout2.exe` is patched to load it, and `f2_res.ini` is what
/// configures it.
const HIRES_LIBRARY: &str = "f2_res.dll";

/// The installed version, or `None` when the install does not have the patch.
///
/// # Errors
///
/// Fails when the library is there but cannot be read.
pub fn installed_hires_version(
    platform: &dyn Platform,
    install: &Install,
) -> Result<Option<String>> {
    installed_library_version(platform, install, HIRES_LIBRARY)
}

#[cfg(test)]
mod tests {
    use super::*;
    use zax_core::install::GameType;
    use zax_platform::memory::MemoryPlatform;

    #[test]
    fn an_install_without_the_patch_has_no_version() {
        let platform = MemoryPlatform::default();
        let install = Install::new("/games/f2", GameType::Fallout2);
        assert_eq!(
            installed_hires_version(&platform, &install).expect("read"),
            None
        );
    }
}

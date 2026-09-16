//! The directories ZAX keeps under the per-user cache.
//!
//! Named in one place because the interface offers to open and to wipe them, and a second spelling
//! of one of these would wipe a directory nothing is written to while the real one grew without
//! bound.

use std::path::PathBuf;

use zax_platform::Platform;

/// Copies of config files taken before each save, and of game files replaced by an sfall update.
#[must_use]
pub fn backup_directory(platform: &dyn Platform) -> PathBuf {
    platform.paths().cache().join("backup")
}

/// Debug archives prepared for bug reports.
#[must_use]
pub fn debug_directory(platform: &dyn Platform) -> PathBuf {
    platform.paths().cache().join("debug")
}

/// Scratch space for downloads and for listings that go into an archive. Safe to remove at any
/// point.
#[must_use]
pub fn temporary_directory(platform: &dyn Platform) -> PathBuf {
    platform.paths().cache().join("tmp")
}

/// Release archives, kept by version.
///
/// They are what a merge reads the previous version's defaults out of, and what makes changing
/// version again cost an extract rather than a download. Genuinely a cache: everything here can be
/// fetched again, which is why emptying it is offered.
#[must_use]
pub fn package_directory(platform: &dyn Platform) -> PathBuf {
    platform.paths().cache().join("packages")
}

#[must_use]
pub fn log_file(platform: &dyn Platform) -> PathBuf {
    platform.paths().cache().join("zax.log")
}

#[cfg(test)]
mod tests {
    use super::*;
    use zax_platform::memory::MemoryPlatform;

    #[test]
    fn every_directory_sits_under_the_cache_and_none_shares_a_name() {
        // A second spelling of one of these would wipe a directory nothing is written to.
        let platform = MemoryPlatform::default();
        let cache = platform.paths().cache().to_path_buf();
        let all = [
            backup_directory(&platform),
            debug_directory(&platform),
            temporary_directory(&platform),
            package_directory(&platform),
            log_file(&platform),
        ];
        let mut seen = std::collections::BTreeSet::new();
        for at in &all {
            assert!(
                at.starts_with(&cache),
                "{} is outside the cache",
                at.display()
            );
            assert!(seen.insert(at.clone()), "{} is named twice", at.display());
        }
    }
}

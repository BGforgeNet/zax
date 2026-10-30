//! Digests of files on disk.

use std::path::Path;

use crate::Result;

pub trait Hashing: Send + Sync {
    /// Lowercase hex SHA-256 of the file at a path - what a release asset's stated digest is
    /// checked against.
    fn sha256(&self, path: &Path) -> Result<String>;

    /// Lowercase hex MD5 of the file at a path - what SourceForge's own file listing publishes per
    /// release.
    fn md5(&self, path: &Path) -> Result<String>;
}

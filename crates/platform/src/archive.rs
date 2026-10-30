//! Reading and writing archives.

use std::path::{Path, PathBuf};

use crate::Result;

/// One file to put in an archive: where it is now, and the path it should have inside.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveEntry {
    pub source: PathBuf,
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ArchiveEntryKind {
    File,
    Dir,
    /// Named so a caller can refuse them - an entry that plants a link and then writes through it
    /// is the classic installer escape, and extraction is too late to find out.
    Link,
}

/// One entry of an archive's directory, read without extracting anything.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveEntryInfo {
    /// The path inside the archive, `/`-separated as archives store it.
    pub name: String,
    pub kind: ArchiveEntryKind,
    /// Declared uncompressed bytes. A declaration to judge - a decompression bomb lies here - not a
    /// fact.
    pub size: u64,
}

#[derive(Debug, Default)]
pub struct ExtractOptions {
    /// Names inside the archive to extract, instead of all of them. Reading one file out of a
    /// release is most of what this is asked for, and unpacking the rest to delete it is work
    /// nobody wanted.
    pub only: Vec<String>,
}

pub trait Archive: Send + Sync {
    /// Extracts an archive. The format is decided by the implementation from the file itself.
    fn extract(&self, archive: &Path, destination: &Path, options: &ExtractOptions) -> Result<()>;

    /// The archive's directory: every entry with its declared size, links flagged. What a mod
    /// install's preflight judges - size ceilings, entry counts, link refusal - before anything is
    /// extracted.
    fn list(&self, archive: &Path) -> Result<Vec<ArchiveEntryInfo>>;

    /// Writes a zip. Only the debug package creates archives, and a zip is what a bug report can
    /// attach.
    fn create_zip(&self, destination: &Path, entries: &[ArchiveEntry]) -> Result<()>;
}

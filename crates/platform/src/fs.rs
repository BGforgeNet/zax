//! Bytes in and bytes out, never decoded text: config files are read as latin1 and application
//! state as UTF-8, and which one applies is the caller's business rather than this layer's.

use std::path::Path;

use crate::Result;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FileKind {
    File,
    Dir,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileStat {
    pub kind: FileKind,
    /// Bytes for a file, unspecified for anything else.
    pub size: u64,
    /// Last modification, in milliseconds since the epoch.
    pub modified: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirEntry {
    pub name: String,
    pub kind: FileKind,
}

pub trait FileSystem: Send + Sync {
    /// Fails when the path does not exist. Use [`FileSystem::stat`] to ask whether it does.
    fn read(&self, path: &Path) -> Result<Vec<u8>>;

    /// Creates parent directories as needed, so a caller never has to order the two calls.
    fn write(&self, path: &Path, bytes: &[u8]) -> Result<()>;

    /// Creates a file only where none is there, answering whether it did. The test and the write
    /// are one operation, which is what makes it usable as a lock: `stat` then `write` is two, and
    /// two processes can both pass the first before either reaches the second. Unlike
    /// [`FileSystem::write`] it does not create parent directories - a claim on a directory that is
    /// not there is a claim on nothing.
    fn create_exclusive(&self, path: &Path, bytes: &[u8]) -> Result<bool>;

    /// Adds to the end of a file, creating it and its parents when absent. Separate from `write`
    /// because the log is appended to a line at a time, and rewriting it whole per line makes its
    /// cost grow with its length.
    fn append(&self, path: &Path, bytes: &[u8]) -> Result<()>;

    /// `None` rather than an error when the path does not exist - absence is an ordinary answer.
    fn stat(&self, path: &Path) -> Result<Option<FileStat>>;

    /// Fails when the path is not a directory.
    fn list(&self, path: &Path) -> Result<Vec<DirEntry>>;

    /// Recursive, and silent when the directory already exists.
    fn mkdir(&self, path: &Path) -> Result<()>;

    fn copy(&self, from: &Path, to: &Path) -> Result<()>;

    /// Recursive, and silent when the path is already gone.
    fn remove(&self, path: &Path) -> Result<()>;

    /// Moves a file or directory. Distinct from copy-and-delete because a rename that only changes
    /// case is not a copy anywhere - on a case-insensitive filesystem the two paths are one file -
    /// and because copying RPU's gigabyte to change a letter is not something to do at all.
    fn rename(&self, from: &Path, to: &Path) -> Result<()>;

    /// Bytes available on the filesystem holding this path, or `None` where the host cannot say. A
    /// check that cannot run is not a check that failed.
    fn free_space(&self, path: &Path) -> Result<Option<u64>>;

    /// Marks a file runnable. Needed because a script that arrives inside an archive may arrive
    /// without its mode, and a mod's installer that cannot be executed is an install that cannot
    /// happen. A no-op where the host has no such bit.
    fn make_executable(&self, path: &Path) -> Result<()>;
}

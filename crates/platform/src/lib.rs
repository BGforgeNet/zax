//! The one interface through which everything outside the process is reached: files, directories,
//! per-user paths, child processes, the network and archives. No other crate calls `std::fs`,
//! `std::process` or an HTTP client directly.
//!
//! Two reasons for the seam. Domain tests run against the in-memory implementation in [`memory`],
//! touching no real filesystem. And the shell that hosts it is replaceable without editing a call
//! site.
//!
//! Every method here is synchronous. The TypeScript seam this replaces was asynchronous because
//! Node's filesystem API is, not because the domain wanted it; in Rust the async version would cost
//! boxed futures at every trait method and `dyn` compatibility with them. The command layer in the
//! shell crate is where blocking work moves off the UI thread.

pub mod archive;
pub mod fs;
pub mod hash;
pub mod memory;
pub mod net;
pub mod paths;
pub mod process;
pub mod registry;

use std::fmt;

/// What a seam operation failed at. Domain code matches on this rather than on a host's own error.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{operation} failed for {path}: {source}")]
    Io {
        operation: &'static str,
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error(transparent)]
    Network(#[from] net::NetworkError),
    #[error("{0}")]
    Archive(String),
    /// The user stopped a long operation. Distinct from a failure: nothing went wrong, nothing is
    /// worth retrying, and a partial file is worth keeping rather than clearing away.
    #[error("Cancelled.")]
    Cancelled,
    /// The host cannot do this at all - the browser preview refusing to start a program, say. A
    /// recorded launch that never happened would read as success.
    #[error("{0}")]
    Unsupported(String),
}

pub type Result<T> = std::result::Result<T, Error>;

/// Spelled across the command boundary the way [`fmt::Display`] spells it, so the interface reads one
/// name for a system rather than one per surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OperatingSystem {
    Windows,
    MacOs,
    Linux,
}

/// The processor a build has to match. `Other` is every architecture ZAX names no build for, which
/// is a real answer rather than a gap: a caller with no build for the pair falls back to a portable
/// one, and a wrong guess here would hand a host a binary it cannot execute.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Architecture {
    X64,
    Arm64,
    Other,
}

impl fmt::Display for OperatingSystem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match self {
            Self::Windows => "windows",
            Self::MacOs => "macos",
            Self::Linux => "linux",
        };
        f.write_str(name)
    }
}

impl fmt::Display for Architecture {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match self {
            Self::X64 => "x64",
            Self::Arm64 => "arm64",
            Self::Other => "other",
        };
        f.write_str(name)
    }
}

/// Everything outside the process, in one handle the domain is given.
pub trait Platform: Send + Sync {
    fn os(&self) -> OperatingSystem;
    fn arch(&self) -> Architecture;
    fn fs(&self) -> &dyn fs::FileSystem;
    fn paths(&self) -> &dyn paths::Paths;
    fn process(&self) -> &dyn process::ProcessLauncher;
    fn net(&self) -> &dyn net::Network;
    fn archive(&self) -> &dyn archive::Archive;
    fn hash(&self) -> &dyn hash::Hashing;
    fn registry(&self) -> &dyn registry::Registry;
}

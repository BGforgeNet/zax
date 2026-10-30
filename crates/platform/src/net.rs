//! Fetching text and downloading files, with the failure named rather than collapsed.

use std::path::Path;
use std::sync::atomic::AtomicBool;

use crate::Result;

/// Why a network operation failed. Carried so a caller can say which of these happened rather than
/// passing on whatever the runtime called it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum NetworkFailure {
    /// The host did not resolve, or refused the connection. Usually no network at all.
    Offline,
    /// Nothing arrived for long enough that the transfer was abandoned.
    Timeout,
    /// The server answered, with something other than success.
    Status,
    /// The body ended before the length the server declared.
    Incomplete,
}

/// A network failure with its cause named. The message is written for the user, because it is the
/// one that reaches them: the command boundary carries an error's text and drops its type.
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct NetworkError {
    pub kind: NetworkFailure,
    pub url: String,
    pub message: String,
    /// The response status, when there was a response at all. Decides whether trying again is worth
    /// anything.
    pub status: Option<u16>,
}

/// How far a download has got. `total` is `None` when the server declared no length.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DownloadProgress {
    pub received: u64,
    pub total: Option<u64>,
}

#[derive(Default)]
pub struct DownloadOptions<'a> {
    /// Called as the body arrives, for an interface that shows how far along a long download is.
    pub on_progress: Option<&'a (dyn Fn(DownloadProgress) + Send + Sync)>,
    /// Stops the transfer where it is, failing with [`crate::Error::Cancelled`] and leaving the
    /// partial file for a later call to resume from. Only the transfer: whatever the caller does
    /// with the file afterwards is its own to abandon or finish.
    pub cancel: Option<&'a AtomicBool>,
}

impl std::fmt::Debug for DownloadOptions<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DownloadOptions")
            .field("on_progress", &self.on_progress.map(|_| "<callback>"))
            .field("cancel", &self.cancel)
            .finish()
    }
}

pub trait Network: Send + Sync {
    fn fetch_text(&self, url: &str) -> Result<String>;

    /// Writes the whole body at the destination, or fails with a [`NetworkError`]. Complete is part
    /// of the contract: a body that stops short of its declared length is a failure here rather
    /// than a short file the caller has to think to check.
    fn download(&self, url: &str, destination: &Path, options: &DownloadOptions<'_>) -> Result<()>;
}

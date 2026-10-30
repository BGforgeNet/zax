//! Where this application's own files live.
//!
//! The TypeScript seam also carried `join`, `dirname`, `basename` and a separator, because its
//! in-memory implementation was deliberately not the host and had no other way to build a path.
//! `std::path` is host-correct without a seam method, so those are gone rather than ported.

use std::path::Path;

pub trait Paths: Send + Sync {
    /// Per-user configuration directory for this application. `zax.yml` sits directly in it.
    fn config(&self) -> &Path;
    /// Per-user cache directory. Backups, debug archives and the log sit under it.
    fn cache(&self) -> &Path;
    fn home(&self) -> &Path;
}

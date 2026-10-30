//! The Windows registry, which is where the launchers record what they installed and where.
//!
//! Part of the seam rather than a shell-out because reading it needs a program's output, and
//! [`crate::process::ProcessLauncher`] deliberately does not offer that - it starts things that
//! outlive the call.
//!
//! Present on every platform and answering `None` off Windows, so a caller asks the same question
//! everywhere instead of branching on the operating system before every read.

use crate::Result;

pub trait Registry: Send + Sync {
    /// A value under a key, or `None` when the key, the value or the registry itself is not there.
    /// Absence is the ordinary answer here: most machines have none of the keys ZAX asks about.
    fn read(&self, key: &str, value: &str) -> Result<Option<String>>;
}

//! The platform seam on a real machine. This is the only crate that reaches the operating system
//! directly: `std::fs`, `std::process`, an HTTP client and the archive readers all live behind it.
//!
//! Everything here is synchronous, as the seam is. The shell crate is where a long call moves off the
//! thread that draws.

pub mod archive;
pub mod fs;
pub mod hash;
pub mod net;
pub mod paths;
pub mod process;
pub mod registry;

use zax_platform::{Architecture, OperatingSystem, Platform};

use crate::archive::HostArchive;
use crate::fs::HostFileSystem;
use crate::hash::HostHashing;
use crate::net::{AttemptSink, DownloadPolicy, HostNetwork};
use crate::paths::HostPaths;
use crate::process::HostProcess;
use crate::registry::HostRegistry;

/// Which system this build is for, decided at compile time. The target is what the binary can actually
/// run, so asking the running system would be asking a question whose answer cannot differ.
#[must_use]
pub const fn operating_system() -> OperatingSystem {
    if cfg!(windows) {
        OperatingSystem::Windows
    } else if cfg!(target_os = "macos") {
        OperatingSystem::MacOs
    } else {
        OperatingSystem::Linux
    }
}

/// Only the two ZAX has builds for. Anything else answers `Other` rather than being rounded to the
/// nearer of them: a 32-bit ARM host told it is `Arm64` gets handed a binary it cannot run, where
/// `Other` gets it the portable route.
#[must_use]
pub const fn architecture() -> Architecture {
    if cfg!(target_arch = "x86_64") {
        Architecture::X64
    } else if cfg!(target_arch = "aarch64") {
        Architecture::Arm64
    } else {
        Architecture::Other
    }
}

#[derive(Debug)]
pub struct HostPlatform {
    os: OperatingSystem,
    arch: Architecture,
    paths: HostPaths,
    fs: HostFileSystem,
    process: HostProcess,
    net: HostNetwork,
    archive: HostArchive,
    hash: HostHashing,
    registry: HostRegistry,
}

impl Default for HostPlatform {
    fn default() -> Self {
        Self::new(None)
    }
}

impl HostPlatform {
    /// The seam for this machine.
    ///
    /// `note` is where a download's per-attempt line goes: a failed or resumed transfer is the one
    /// thing a bug report cannot reconstruct from the interface, so the shell passes a sink for it.
    #[must_use]
    pub fn new(note: Option<AttemptSink>) -> Self {
        let os = operating_system();
        Self {
            os,
            arch: architecture(),
            paths: HostPaths::of_this_machine(os),
            fs: HostFileSystem,
            process: HostProcess::new(os),
            net: HostNetwork::new(DownloadPolicy::default(), note),
            archive: HostArchive,
            hash: HostHashing,
            registry: HostRegistry::new(os),
        }
    }
}

impl Platform for HostPlatform {
    fn os(&self) -> OperatingSystem {
        self.os
    }

    fn arch(&self) -> Architecture {
        self.arch
    }

    fn fs(&self) -> &dyn zax_platform::fs::FileSystem {
        &self.fs
    }

    fn paths(&self) -> &dyn zax_platform::paths::Paths {
        &self.paths
    }

    fn process(&self) -> &dyn zax_platform::process::ProcessLauncher {
        &self.process
    }

    fn net(&self) -> &dyn zax_platform::net::Network {
        &self.net
    }

    fn archive(&self) -> &dyn zax_platform::archive::Archive {
        &self.archive
    }

    fn hash(&self) -> &dyn zax_platform::hash::Hashing {
        &self.hash
    }

    fn registry(&self) -> &dyn zax_platform::registry::Registry {
        &self.registry
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn this_build_names_the_system_it_was_built_for() {
        // The target is what the binary can actually run, so it cannot disagree with the host.
        let held = HostPlatform::default();
        assert_eq!(held.os(), operating_system());
        assert_eq!(held.arch(), architecture());
    }

    #[test]
    fn every_capability_is_reachable_through_the_seam() {
        // What a shell holds is one `dyn Platform`; a missing arm would only show up at first use.
        let held = HostPlatform::default();
        assert!(!held.paths().home().as_os_str().is_empty());
        assert_eq!(held.registry().read("HKLM\\x", "y").expect("a read"), None);
        assert!(
            held.fs()
                .stat(std::path::Path::new("/"))
                .expect("a read")
                .is_some()
        );
    }
}

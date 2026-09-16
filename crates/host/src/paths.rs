//! Where this application keeps its own files on a real machine.
//!
//! A portable copy is the reason this is not simply the per-user directories: ZAX ships as a folder a
//! user can carry on a stick, and one that finds a `data` directory beside its own executable keeps
//! everything there instead. Checked before the per-user locations so a portable copy stays portable
//! whatever the host would otherwise answer.

use std::path::{Path, PathBuf};

use zax_platform::paths::Paths;

const APP_NAME: &str = "zax";

/// The directory a portable copy keeps everything in, beside the program itself.
const PORTABLE: &str = "data";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostPaths {
    home: PathBuf,
    config: PathBuf,
    cache: PathBuf,
}

impl Paths for HostPaths {
    fn home(&self) -> &Path {
        &self.home
    }

    fn config(&self) -> &Path {
        &self.config
    }

    fn cache(&self) -> &Path {
        &self.cache
    }
}

impl HostPaths {
    /// The directories this machine's copy of ZAX uses.
    ///
    /// `program` is where the running executable is, which is what a portable copy is found beside.
    #[must_use]
    pub fn new(program: &Path, home: PathBuf, config: PathBuf, cache: PathBuf) -> Self {
        // Synchronous and before anything else runs: this decides where the process reads its own
        // settings from.
        if let Some(beside) = program.parent().map(|at| at.join(PORTABLE))
            && beside.is_dir()
        {
            return Self {
                home,
                config: beside.clone(),
                cache: beside,
            };
        }
        Self {
            home,
            config,
            cache,
        }
    }

    /// The same, read off this machine.
    ///
    /// Falls back to the home directory where the host names no per-user location, which is a machine
    /// this application can still run on rather than one it should refuse to start on.
    #[must_use]
    pub fn of_this_machine() -> Self {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        let program = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
        let config = dirs::config_dir().unwrap_or_else(|| home.join(".config"));
        let cache = dirs::cache_dir().unwrap_or_else(|| home.join(".cache"));
        Self::new(&program, home, config.join(APP_NAME), cache.join(APP_NAME))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn given(program: &str) -> HostPaths {
        HostPaths::new(
            Path::new(program),
            PathBuf::from("/home/tester"),
            PathBuf::from("/home/tester/.config/zax"),
            PathBuf::from("/home/tester/.cache/zax"),
        )
    }

    #[test]
    fn the_per_user_directories_answer_where_there_is_no_portable_copy() {
        let held = given("/nowhere/zax");
        assert_eq!(held.config(), Path::new("/home/tester/.config/zax"));
        assert_eq!(held.cache(), Path::new("/home/tester/.cache/zax"));
        assert_eq!(held.home(), Path::new("/home/tester"));
    }

    #[test]
    fn a_data_directory_beside_the_program_takes_both() {
        // A copy on a stick keeps everything with it, whatever the host would otherwise answer.
        let held = std::env::temp_dir().join("zax-portable-test");
        let program = held.join("zax");
        std::fs::create_dir_all(held.join(PORTABLE)).expect("a directory the test makes");
        let paths = HostPaths::new(
            &program,
            PathBuf::from("/home/tester"),
            PathBuf::from("/home/tester/.config/zax"),
            PathBuf::from("/home/tester/.cache/zax"),
        );
        assert_eq!(paths.config(), held.join(PORTABLE));
        assert_eq!(paths.cache(), held.join(PORTABLE));
        // The home directory is the user's whatever the copy is: it is where the game folders are.
        assert_eq!(paths.home(), Path::new("/home/tester"));
        std::fs::remove_dir_all(&held).expect("the directory the test made");
    }

    #[test]
    fn a_file_of_that_name_beside_the_program_is_not_a_portable_copy() {
        let held = std::env::temp_dir().join("zax-portable-file-test");
        std::fs::create_dir_all(&held).expect("a directory the test makes");
        std::fs::write(held.join(PORTABLE), b"not a directory").expect("a file the test makes");
        let paths = HostPaths::new(
            &held.join("zax"),
            PathBuf::from("/home/tester"),
            PathBuf::from("/home/tester/.config/zax"),
            PathBuf::from("/home/tester/.cache/zax"),
        );
        assert_eq!(paths.config(), Path::new("/home/tester/.config/zax"));
        std::fs::remove_dir_all(&held).expect("the directory the test made");
    }

    #[test]
    fn this_machines_directories_are_all_named() {
        let held = HostPaths::of_this_machine();
        assert!(!held.home().as_os_str().is_empty());
        assert!(!held.config().as_os_str().is_empty());
        assert!(!held.cache().as_os_str().is_empty());
    }
}

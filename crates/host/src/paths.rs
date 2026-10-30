//! Where this application keeps its own files on a real machine.
//!
//! Every rule here takes the operating system, the environment and the paths it reasons about rather than
//! reading them, so all three platforms are testable from whichever one runs the tests - and joins with the
//! target's separator rather than the host's for the same reason.

use std::path::{Path, PathBuf};

use zax_platform::OperatingSystem;
use zax_platform::paths::Paths;

const APP_NAME: &str = "zax";

/// The directory a portable copy keeps everything in, beside where it was launched from.
const PORTABLE: &str = "data";

/// A variable's value, where it is set to something. An empty value is treated as unset, which is what the
/// XDG specification asks for and what nobody setting one of the others to nothing could have meant.
type Env<'a> = &'a dyn Fn(&str) -> Option<String>;

fn set(env: Env<'_>, name: &str) -> Option<String> {
    env(name).filter(|value| !value.is_empty())
}

const fn separator(os: OperatingSystem) -> &'static str {
    match os {
        OperatingSystem::Windows => "\\",
        OperatingSystem::MacOs | OperatingSystem::Linux => "/",
    }
}

fn join(os: OperatingSystem, parts: &[&str]) -> String {
    parts.join(separator(os))
}

/// A config directory and a cache directory, kept apart so emptying the cache cannot reach the install list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Directories {
    pub config: String,
    pub cache: String,
}

/// Where each desktop keeps a per-user config and cache directory. These are the locations the previous
/// implementations used through `appdirs`, reproduced so an existing `zax.yml` is found where it already sits
/// rather than the application starting over with an empty install list.
#[must_use]
pub fn user_directories(os: OperatingSystem, env: Env<'_>, home: &str, app: &str) -> Directories {
    match os {
        OperatingSystem::Windows => {
            let roaming =
                set(env, "APPDATA").unwrap_or_else(|| join(os, &[home, "AppData", "Roaming"]));
            let local =
                set(env, "LOCALAPPDATA").unwrap_or_else(|| join(os, &[home, "AppData", "Local"]));
            Directories {
                config: join(os, &[&roaming, app]),
                cache: join(os, &[&local, app, "Cache"]),
            }
        }
        OperatingSystem::MacOs => Directories {
            config: join(os, &[home, "Library", "Application Support", app]),
            cache: join(os, &[home, "Library", "Caches", app]),
        },
        OperatingSystem::Linux => {
            let config =
                set(env, "XDG_CONFIG_HOME").unwrap_or_else(|| join(os, &[home, ".config"]));
            let cache = set(env, "XDG_CACHE_HOME").unwrap_or_else(|| join(os, &[home, ".cache"]));
            Directories {
                config: join(os, &[&config, app]),
                cache: join(os, &[&cache, app]),
            }
        }
    }
}

/// `levels` components off the end of a path spelled with the target's separator.
fn up(os: OperatingSystem, path: &str, levels: usize) -> String {
    let parts: Vec<&str> = path.split(separator(os)).collect();
    parts[..parts.len().saturating_sub(levels)].join(separator(os))
}

/// The directory a copy was launched from, which is where a portable one keeps its settings.
///
/// An AppImage hides the executable really running - it mounts itself read-only under `/tmp` - and says in
/// `APPIMAGE` where the image itself is. Otherwise it is the executable's own directory, less the bundle a
/// macOS application is wrapped in: settings belong beside `ZAX.app`, not inside it where moving the
/// application would lose them.
#[must_use]
pub fn launch_directory(os: OperatingSystem, env: Env<'_>, executable: &str) -> String {
    if let Some(image) = set(env, "APPIMAGE") {
        return up(os, &image, 1);
    }
    // `ZAX.app/Contents/MacOS/ZAX` - four levels up is the directory holding the bundle.
    if os == OperatingSystem::MacOs && executable.contains(".app/Contents/MacOS/") {
        return up(os, executable, 4);
    }
    up(os, executable, 1)
}

/// The directory a portable copy keeps everything in, or nothing for an installed one.
///
/// A `data` directory beside the copy is the switch, and it has to be created deliberately: an installed copy
/// must not turn portable because something wrote a directory of that name. `ZAX_DATA_DIR` names one elsewhere,
/// for anyone scripting it.
#[must_use]
pub fn portable_directory(
    os: OperatingSystem,
    env: Env<'_>,
    launched_from: &str,
    is_directory: &dyn Fn(&str) -> bool,
) -> Option<String> {
    if let Some(named) = set(env, "ZAX_DATA_DIR") {
        return Some(named);
    }
    let beside = join(os, &[launched_from, PORTABLE]);
    is_directory(&beside).then_some(beside)
}

/// Where this copy keeps its config and cache: under the portable data directory when there is one, and in the
/// per-user locations otherwise.
///
/// Composes the rules above rather than leaving the caller to, because the order they go in is the part no type
/// catches getting wrong - every one of them takes a path and gives one back.
#[must_use]
pub fn application_directories(
    os: OperatingSystem,
    env: Env<'_>,
    home: &str,
    executable: &str,
    is_directory: &dyn Fn(&str) -> bool,
) -> Directories {
    let launched_from = launch_directory(os, env, executable);
    match portable_directory(os, env, &launched_from, is_directory) {
        Some(portable) => Directories {
            config: join(os, &[&portable, "config"]),
            cache: join(os, &[&portable, "cache"]),
        },
        None => user_directories(os, env, home, APP_NAME),
    }
}

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
    /// The directories this machine's copy of ZAX uses. Read once, before anything else runs, since it decides
    /// where the process reads its own settings from.
    ///
    /// Falls back to the working directory where the host names no home or executable, which is a machine this
    /// application can still run on rather than one it should refuse to start on.
    #[must_use]
    pub fn of_this_machine(os: OperatingSystem) -> Self {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        let executable = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
        let env = |name: &str| std::env::var(name).ok();
        let held = application_directories(
            os,
            &env,
            &home.to_string_lossy(),
            &executable.to_string_lossy(),
            &|path| Path::new(path).is_dir(),
        );
        Self {
            home,
            config: PathBuf::from(held.config),
            cache: PathBuf::from(held.cache),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    const WINDOWS: OperatingSystem = OperatingSystem::Windows;
    const MAC: OperatingSystem = OperatingSystem::MacOs;
    const LINUX: OperatingSystem = OperatingSystem::Linux;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let held: BTreeMap<String, String> = pairs
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect();
        move |name| held.get(name).cloned()
    }

    fn only(directory: &'static str) -> impl Fn(&str) -> bool {
        move |path| path == directory
    }

    fn dirs(config: &str, cache: &str) -> Directories {
        Directories {
            config: config.to_owned(),
            cache: cache.to_owned(),
        }
    }

    // Getting one of these wrong does not fail loudly - it starts with an empty install list and writes a
    // second `zax.yml` beside the one the user already has - so each is pinned by value.

    #[test]
    fn windows_uses_roaming_for_config_and_local_for_cache() {
        let given = env(&[
            ("APPDATA", "C:\\Users\\t\\AppData\\Roaming"),
            ("LOCALAPPDATA", "C:\\Users\\t\\AppData\\Local"),
        ]);
        assert_eq!(
            user_directories(WINDOWS, &given, "C:\\Users\\t", "zax"),
            dirs(
                "C:\\Users\\t\\AppData\\Roaming\\zax",
                "C:\\Users\\t\\AppData\\Local\\zax\\Cache"
            )
        );
    }

    #[test]
    fn windows_falls_back_to_its_standard_layout_when_the_environment_does_not_say() {
        let held = user_directories(WINDOWS, &env(&[]), "C:\\Users\\t", "zax");
        assert_eq!(held.config, "C:\\Users\\t\\AppData\\Roaming\\zax");
    }

    #[test]
    fn macos_uses_application_support_and_caches() {
        assert_eq!(
            user_directories(MAC, &env(&[]), "/Users/t", "zax"),
            dirs(
                "/Users/t/Library/Application Support/zax",
                "/Users/t/Library/Caches/zax"
            )
        );
    }

    #[test]
    fn linux_uses_the_xdg_layout_and_honours_its_overrides() {
        assert_eq!(
            user_directories(LINUX, &env(&[]), "/home/t", "zax"),
            dirs("/home/t/.config/zax", "/home/t/.cache/zax")
        );
        let moved = env(&[
            ("XDG_CONFIG_HOME", "/mnt/cfg"),
            ("XDG_CACHE_HOME", "/mnt/cache"),
        ]);
        assert_eq!(
            user_directories(LINUX, &moved, "/home/t", "zax"),
            dirs("/mnt/cfg/zax", "/mnt/cache/zax")
        );
        // An empty override is no override.
        let blank = env(&[("XDG_CONFIG_HOME", "")]);
        assert_eq!(
            user_directories(LINUX, &blank, "/home/t", "zax").config,
            "/home/t/.config/zax"
        );
    }

    #[test]
    fn a_copy_is_launched_from_the_directory_beside_its_executable() {
        assert_eq!(
            launch_directory(LINUX, &env(&[]), "/opt/zax/zax"),
            "/opt/zax"
        );
        assert_eq!(
            launch_directory(WINDOWS, &env(&[]), "D:\\Portable\\ZAX\\ZAX.exe"),
            "D:\\Portable\\ZAX"
        );
    }

    #[test]
    fn a_macos_copy_steps_out_of_its_bundle() {
        assert_eq!(
            launch_directory(MAC, &env(&[]), "/Volumes/Stick/ZAX.app/Contents/MacOS/ZAX"),
            "/Volumes/Stick"
        );
    }

    #[test]
    fn an_appimage_is_launched_from_where_the_image_is_not_its_mount() {
        let given = env(&[("APPIMAGE", "/media/stick/ZAX-0.8.0.AppImage")]);
        assert_eq!(
            launch_directory(LINUX, &given, "/tmp/.mount_ZAXabc/usr/bin/zax"),
            "/media/stick"
        );
    }

    #[test]
    fn a_data_directory_beside_the_copy_is_the_whole_switch() {
        assert_eq!(
            portable_directory(LINUX, &env(&[]), "/media/stick", &only("/media/stick/data"))
                .as_deref(),
            Some("/media/stick/data")
        );
        assert_eq!(
            portable_directory(LINUX, &env(&[]), "/opt/zax", &|_| false),
            None
        );
        assert_eq!(
            portable_directory(WINDOWS, &env(&[]), "E:\\Stick", &only("E:\\Stick\\data"))
                .as_deref(),
            Some("E:\\Stick\\data")
        );
    }

    #[test]
    fn a_data_directory_can_be_named_outright() {
        let given = env(&[("ZAX_DATA_DIR", "/mnt/elsewhere")]);
        assert_eq!(
            portable_directory(LINUX, &given, "/opt/zax", &|_| false).as_deref(),
            Some("/mnt/elsewhere")
        );
    }

    // The whole decision, end to end: each rule above is right on its own, and these cover their order.

    #[test]
    fn a_portable_copy_keeps_config_and_cache_apart_under_its_data_directory() {
        let held = application_directories(
            LINUX,
            &env(&[]),
            "/home/t",
            "/media/stick/zax",
            &only("/media/stick/data"),
        );
        assert_eq!(
            held,
            dirs("/media/stick/data/config", "/media/stick/data/cache")
        );
    }

    #[test]
    fn an_installed_copy_uses_the_per_user_locations() {
        let held = application_directories(LINUX, &env(&[]), "/home/t", "/opt/zax/zax", &|_| false);
        assert_eq!(held, dirs("/home/t/.config/zax", "/home/t/.cache/zax"));
    }

    #[test]
    fn an_appimage_and_a_bundle_resolve_against_where_they_sit() {
        let image = env(&[("APPIMAGE", "/media/stick/ZAX.AppImage")]);
        let held = application_directories(
            LINUX,
            &image,
            "/home/t",
            "/tmp/.mount_x/usr/bin/zax",
            &only("/media/stick/data"),
        );
        assert_eq!(held.config, "/media/stick/data/config");
        let bundle = "/Volumes/Stick/ZAX.app/Contents/MacOS/ZAX";
        let held = application_directories(
            MAC,
            &env(&[]),
            "/Users/t",
            bundle,
            &only("/Volumes/Stick/data"),
        );
        assert_eq!(held.config, "/Volumes/Stick/data/config");
    }

    #[test]
    fn a_named_data_directory_wins_over_one_beside_the_copy() {
        let given = env(&[("ZAX_DATA_DIR", "/mnt/elsewhere")]);
        let held = application_directories(
            LINUX,
            &given,
            "/home/t",
            "/media/stick/zax",
            &only("/media/stick/data"),
        );
        assert_eq!(held.config, "/mnt/elsewhere/config");
    }

    #[test]
    fn a_file_named_data_is_not_a_portable_copy() {
        // The one rule that touches the disk, against the disk: a directory is the switch, a file is not.
        let held = std::env::temp_dir().join("zax-portable-file-test");
        std::fs::create_dir_all(&held).expect("a directory the test makes");
        std::fs::write(held.join(PORTABLE), b"not a directory").expect("a file the test makes");
        let launched = held.to_string_lossy().into_owned();
        let found = portable_directory(LINUX, &env(&[]), &launched, &|path| {
            Path::new(path).is_dir()
        });
        std::fs::remove_dir_all(&held).expect("the directory the test made");
        assert_eq!(found, None);
    }

    #[test]
    fn this_machines_directories_are_all_named() {
        let held = HostPaths::of_this_machine(crate::operating_system());
        assert!(!held.home().as_os_str().is_empty());
        assert!(!held.config().as_os_str().is_empty());
        assert!(!held.cache().as_os_str().is_empty());
    }
}

//! Starting the game.
//!
//! What to run and with what environment is Fallout 2 knowledge rather than platform knowledge, so
//! the plan is built here and handed to the platform to run - which also makes it assertable without
//! starting anything.

use std::cmp::Ordering;
use std::collections::BTreeMap;

use zax_core::install::Install;
use zax_core::version::compare_versions;
use zax_platform::OperatingSystem;

const EXECUTABLE: &str = "fallout2.exe";

/// The program a started game runs as: an engine's own, or the game's executable - which Wine runs
/// under its own name too, so the launcher that started it is not what the process shows.
#[must_use]
pub fn game_program(engine_program: Option<&str>) -> &str {
    engine_program.unwrap_or(EXECUTABLE)
}

/// Where Wine's own output is kept.
///
/// Beside the game's `debug.log` because that is where a user looks for one, and it is per install
/// for the same reason the config files are.
pub const WINE_LOG: &str = "wine.log";

/// The sfall release from which Wine needs the DLL loaded as builtin as well as native.
const NATIVE_AND_BUILTIN_FROM: &str = "4.1.2";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchPlan {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    /// Added to the inherited environment. Empty on Windows, where the game is started directly.
    pub env: BTreeMap<String, String>,
    /// Where to send what the program prints, for the Wine route, whose output has nowhere else to
    /// go.
    pub log: Option<String>,
}

/// What to run for one install.
///
/// `sfall_version` is what is installed, or `None` when no `ddraw.dll` is there. It decides how Wine
/// is told to load that DLL: sfall replaces DirectDraw, and before 4.1.2 loading the builtin
/// alongside the native one broke it. With no sfall installed there is nothing to override, so the
/// variable is left off entirely.
///
/// `engine_program` is an installed alternative engine's own program, relative to the install, or
/// `None` for the game's own executable. An engine is a native build of this system, so it takes no
/// Wine and no DirectDraw override however the install is configured - both would be claims about a
/// process that is not under Wine.
#[must_use]
pub fn plan_launch(
    os: OperatingSystem,
    install: &Install,
    sfall_version: Option<&str>,
    engine_program: Option<&str>,
) -> LaunchPlan {
    if let Some(engine) = engine_program {
        // Prefixed off Windows because a bare name is a PATH lookup there, and this program is in
        // the install.
        let program = if os == OperatingSystem::Windows {
            engine.to_owned()
        } else {
            format!("./{engine}")
        };
        return LaunchPlan {
            program,
            args: Vec::new(),
            cwd: install.path.clone(),
            env: BTreeMap::new(),
            log: None,
        };
    }

    if os == OperatingSystem::Windows {
        return LaunchPlan {
            program: EXECUTABLE.to_owned(),
            args: Vec::new(),
            cwd: install.path.clone(),
            env: BTreeMap::new(),
            log: None,
        };
    }

    let mut env = BTreeMap::new();
    if let Some(wine) = &install.wine {
        if let Some(prefix) = &wine.prefix {
            env.insert("WINEPREFIX".to_owned(), prefix.clone());
        }
        if let Some(debug) = &wine.debug {
            env.insert("WINEDEBUG".to_owned(), debug.clone());
        }
    }
    if let Some(version) = sfall_version {
        let overrides = if compare_versions(version, NATIVE_AND_BUILTIN_FROM) == Ordering::Less {
            "ddraw.dll=n"
        } else {
            "ddraw.dll=n,b"
        };
        env.insert("WINEDLLOVERRIDES".to_owned(), overrides.to_owned());
    }

    LaunchPlan {
        program: "wine".to_owned(),
        args: vec![EXECUTABLE.to_owned()],
        cwd: install.path.clone(),
        // Always joined with "/": this branch is every machine except Windows.
        log: Some(format!("{}/{WINE_LOG}", install.path)),
        env,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use zax_core::install::{GameType, WineConfig};

    fn install() -> Install {
        Install::new("/games/f2", GameType::Fallout2)
    }

    fn with_wine(prefix: Option<&str>, debug: Option<&str>) -> Install {
        let mut install = install();
        install.wine = Some(WineConfig {
            prefix: prefix.map(ToOwned::to_owned),
            debug: debug.map(ToOwned::to_owned),
        });
        install
    }

    #[test]
    fn windows_starts_the_game_directly() {
        let plan = plan_launch(OperatingSystem::Windows, &install(), Some("4.5"), None);
        assert_eq!(plan.program, EXECUTABLE);
        assert!(plan.args.is_empty());
        assert!(plan.env.is_empty(), "no Wine anywhere on Windows");
        assert_eq!(plan.log, None);
        assert_eq!(plan.cwd, "/games/f2");
    }

    #[test]
    fn elsewhere_the_game_runs_under_wine_with_its_output_kept() {
        let plan = plan_launch(OperatingSystem::Linux, &install(), None, None);
        assert_eq!(plan.program, "wine");
        assert_eq!(plan.args, vec![EXECUTABLE.to_owned()]);
        assert_eq!(plan.log.as_deref(), Some("/games/f2/wine.log"));
    }

    #[test]
    fn with_no_sfall_there_is_nothing_to_override() {
        let plan = plan_launch(OperatingSystem::Linux, &install(), None, None);
        assert!(!plan.env.contains_key("WINEDLLOVERRIDES"));
    }

    #[test]
    fn sfall_before_the_split_release_loads_native_only() {
        // Loading the builtin alongside the native one broke it before 4.1.2.
        let plan = plan_launch(OperatingSystem::Linux, &install(), Some("4.1.1"), None);
        assert_eq!(
            plan.env.get("WINEDLLOVERRIDES").map(String::as_str),
            Some("ddraw.dll=n")
        );
    }

    #[test]
    fn sfall_from_the_split_release_onwards_loads_both() {
        for version in ["4.1.2", "4.5", "5.0"] {
            let plan = plan_launch(OperatingSystem::Linux, &install(), Some(version), None);
            assert_eq!(
                plan.env.get("WINEDLLOVERRIDES").map(String::as_str),
                Some("ddraw.dll=n,b"),
                "for sfall {version}"
            );
        }
    }

    #[test]
    fn the_installs_own_wine_settings_are_passed_through() {
        let install = with_wine(Some("/home/u/.wine"), Some("-all"));
        let plan = plan_launch(OperatingSystem::Linux, &install, None, None);
        assert_eq!(
            plan.env.get("WINEPREFIX").map(String::as_str),
            Some("/home/u/.wine")
        );
        assert_eq!(plan.env.get("WINEDEBUG").map(String::as_str), Some("-all"));
    }

    #[test]
    fn a_wine_field_that_is_not_set_is_left_off() {
        let install = with_wine(None, None);
        let plan = plan_launch(OperatingSystem::Linux, &install, None, None);
        assert!(plan.env.is_empty(), "{:?}", plan.env);
    }

    #[test]
    fn an_engine_takes_no_wine_however_the_install_is_configured() {
        // Both would be claims about a process that is not under Wine.
        let install = with_wine(Some("/home/u/.wine"), Some("-all"));
        let plan = plan_launch(
            OperatingSystem::Linux,
            &install,
            Some("4.5"),
            Some("fallout2-ce"),
        );
        assert_eq!(plan.program, "./fallout2-ce");
        assert!(plan.env.is_empty(), "{:?}", plan.env);
        assert_eq!(plan.log, None);
    }

    #[test]
    fn an_engine_on_windows_is_not_prefixed() {
        // A bare name is a PATH lookup off Windows, and this program is in the install.
        let plan = plan_launch(
            OperatingSystem::Windows,
            &install(),
            None,
            Some("fallout2-ce.exe"),
        );
        assert_eq!(plan.program, "fallout2-ce.exe");
    }
}

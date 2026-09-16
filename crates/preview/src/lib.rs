//! The domain compiled to WebAssembly, over the in-memory machine, for the browser preview.
//!
//! The desktop build reaches the backend through the shell's Tauri commands. The preview reaches the
//! same backend through the dispatcher here, under the same names and with the same argument shapes -
//! so the interface calls one function either way and the cheap host cannot be laxer than the
//! expensive one.
//!
//! What the preview refuses is what cannot be simulated honestly: starting a program, and downloading
//! a file. A recorded launch that never happened and an invented version number both read as success.
//! Everything that only touches files works for real, against the seeded fixture.

pub mod fixture;

use std::sync::{Arc, Mutex};

use serde::Deserialize;
use zax_core::stamp::{LocalTime, Utc};
use zax_fallout2::backend::{Backend, OpenTarget, OperationProgress, Shell, WipeTarget};
use zax_fallout2::engine_choice::BuildPick;
use zax_fallout2::reconcile_settings::HeldTarget;
use zax_platform::{Platform, Result};

use crate::fixture::{PREVIEW_REASON, preview_platform};

/// What the preview's clock says. Fixed rather than read from the host: the interface's own tests drive
/// this machine, and a stamped directory whose name moves between runs is one no test can name.
const PREVIEW_NOW: LocalTime = LocalTime {
    year: 2026,
    month: 9,
    day: 16,
    hour: 12,
    minute: 0,
    second: 0,
};

/// The same instant in milliseconds, so a cached listing's freshness and a lock's age are decided by
/// the same clock the stamps are.
const PREVIEW_MILLIS: i64 = 1_789_000_000_000;

/// Where one long operation's progress goes. Boxed because the desktop's own listener is a callback
/// into the window, and the preview's is one into the page.
type Listener = Box<dyn Fn(&OperationProgress) + Send + Sync>;

/// The preview's window, which has none of the things a window does.
struct PreviewShell {
    listeners: Mutex<Vec<Listener>>,
}

impl std::fmt::Debug for PreviewShell {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PreviewShell").finish_non_exhaustive()
    }
}

impl Shell for PreviewShell {
    fn choose_folder(&self, _holding: Option<&str>) -> Result<Option<String>> {
        // No picker in a browser, and a made-up path would name a folder nobody has.
        Err(zax_platform::Error::Unsupported(PREVIEW_REASON.to_owned()))
    }

    fn report(&self, progress: &OperationProgress) {
        // Reported for real rather than refused: the backend the preview runs is in this process, so
        // the interface's progress display is exercised here and by its tests, instead of only existing
        // on the build that is hardest to drive.
        for listener in self
            .listeners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
        {
            listener(progress);
        }
    }

    fn now(&self) -> LocalTime {
        PREVIEW_NOW
    }

    fn utc(&self) -> Utc {
        Utc {
            year: PREVIEW_NOW.year,
            month: PREVIEW_NOW.month,
            day: PREVIEW_NOW.day,
            hour: PREVIEW_NOW.hour,
            minute: PREVIEW_NOW.minute,
            second: PREVIEW_NOW.second,
            millisecond: 0,
        }
    }

    fn millis(&self) -> i64 {
        PREVIEW_MILLIS
    }
}

/// The machine, the backend over it, and the listeners progress goes to.
#[derive(Debug)]
pub struct Preview {
    backend: Backend,
    shell: Arc<PreviewShell>,
}

/// Every argument shape a command takes, read from the object the interface sends.
///
/// One struct rather than one per command: the fields are optional and a command reads the ones it
/// needs, which is what keeps this from being a third copy of every signature. Unknown fields are
/// refused, so an argument the interface spells wrongly fails here rather than arriving as nothing.
#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
struct Arguments {
    holding: Option<String>,
    state: Option<zax_core::state::AppState>,
    install_path: Option<String>,
    request: Option<serde_json::Value>,
    at: Option<Vec<HeldTarget>>,
    install: Option<zax_core::install::Install>,
    refresh: Option<bool>,
    mod_id: Option<String>,
    choices: Option<Vec<String>>,
    answers: Option<std::collections::BTreeMap<String, String>>,
    version: Option<String>,
    fingerprint: Option<String>,
    above: Option<String>,
    file: Option<String>,
    path: Option<String>,
    known: Option<Vec<zax_core::install::Install>>,
    engine_id: Option<String>,
    published: Option<String>,
    pick: Option<BuildPick>,
    saves: Option<Vec<String>>,
    sfall_version: Option<String>,
    target: Option<OpenTarget>,
    which: Option<WipeTarget>,
}

/// What a command answers with: the value as JSON, or the sentence the interface shows.
type Answer = std::result::Result<serde_json::Value, String>;

fn json<T: serde::Serialize>(value: &T) -> Answer {
    serde_json::to_value(value).map_err(|err| format!("The answer could not be written: {err}"))
}

fn needed<T>(held: Option<T>, name: &str) -> std::result::Result<T, String> {
    held.ok_or_else(|| format!("The preview was called without \"{name}\"."))
}

impl Preview {
    /// A fresh machine, seeded.
    ///
    /// # Errors
    ///
    /// Fails only where the fixture cannot be seeded, which is a fault in this crate.
    pub fn new() -> Result<Self> {
        let shell = Arc::new(PreviewShell {
            listeners: Mutex::new(Vec::new()),
        });
        let platform: Arc<dyn Platform> = Arc::new(preview_platform()?);
        Ok(Self {
            backend: Backend::new(platform, Arc::clone(&shell) as Arc<dyn Shell>),
            shell,
        })
    }

    /// Adds a listener for a long operation's progress.
    pub fn on_progress(&self, listener: Box<dyn Fn(&OperationProgress) + Send + Sync>) {
        self.shell
            .listeners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(listener);
    }

    /// One command, by the name the shell registers it under.
    ///
    /// # Errors
    ///
    /// Answers with the sentence the interface shows: the operation's own refusal, an argument the
    /// preview was not given, or a name it does not register.
    #[expect(
        clippy::too_many_lines,
        reason = "one arm per command, which is the list itself; splitting it would put the surface \
                  the interface calls across out of one reader's sight"
    )]
    pub fn invoke(&self, name: &str, arguments: &str) -> Answer {
        let held: Arguments = if arguments.trim().is_empty() {
            Arguments::default()
        } else {
            serde_json::from_str(arguments)
                .map_err(|err| format!("The preview could not read the arguments: {err}"))?
        };
        let backend = &self.backend;
        let said = |err: zax_platform::Error| err.to_string();
        match name {
            "describe" => json(&backend.describe()),
            "choose_folder" => backend
                .choose_folder(held.holding.as_deref())
                .map_err(said)
                .and_then(|at| json(&at)),
            "load_state" => backend.load_state().map_err(said).and_then(|at| json(&at)),
            "save_state" => backend
                .save_state(&needed(held.state, "state")?)
                .map_err(said)
                .and_then(|()| json(&())),
            "load_config_files" => backend
                .load_config_files(&needed(held.install_path, "installPath")?)
                .map_err(said)
                .and_then(|at| json(&at)),
            "save_config_files" => {
                let request = serde_json::from_value(needed(held.request, "request")?)
                    .map_err(|err| format!("The preview could not read the request: {err}"))?;
                backend
                    .save_config_files(&request)
                    .map_err(said)
                    .and_then(|at| json(&at))
            }
            "settings_base" => backend
                .settings_base(&needed(held.install_path, "installPath")?)
                .map_err(said)
                .and_then(|at| json(&at)),
            "accept_settings_base" => backend
                .accept_settings_base(
                    &needed(held.install_path, "installPath")?,
                    &needed(held.at, "at")?,
                )
                .map_err(said)
                .and_then(|()| json(&())),
            "load_mods" => backend
                .load_mods(&needed(held.install, "install")?)
                .map_err(said)
                .and_then(|at| json(&at)),
            "save_mods" => {
                let request = serde_json::from_value(needed(held.request, "request")?)
                    .map_err(|err| format!("The preview could not read the request: {err}"))?;
                backend
                    .save_mods(&request)
                    .map_err(said)
                    .and_then(|at| json(&at))
            }
            "published_mods" => json(&backend.published_mods(held.refresh.unwrap_or(false))),
            "mod_install_state" => backend
                .mod_install_state(&needed(held.install, "install")?)
                .map_err(said)
                .and_then(|at| json(&at)),
            "plan_mod" => backend
                .plan_mod(
                    &needed(held.install, "install")?,
                    &needed(held.mod_id, "modId")?,
                    &held.choices.unwrap_or_default(),
                    &held.answers.unwrap_or_default(),
                    held.version.as_deref(),
                )
                .map_err(said)
                .and_then(|at| json(&at)),
            "install_mod" => backend
                .install_mod(
                    &needed(held.install, "install")?,
                    &needed(held.mod_id, "modId")?,
                    &needed(held.fingerprint, "fingerprint")?,
                    &held.choices.unwrap_or_default(),
                    &held.answers.unwrap_or_default(),
                    held.version.as_deref(),
                )
                .map_err(said)
                .and_then(|at| json(&at)),
            "mod_versions" => backend
                .mod_versions(&needed(held.mod_id, "modId")?, held.above.as_deref())
                .map_err(said)
                .and_then(|at| json(&at)),
            "restore_mod" => backend
                .restore_mod(
                    &needed(held.install, "install")?,
                    &needed(held.mod_id, "modId")?,
                )
                .map_err(said)
                .and_then(|()| json(&())),
            "remove_mod" => backend
                .remove_mod(
                    &needed(held.install, "install")?,
                    &needed(held.mod_id, "modId")?,
                )
                .map_err(said)
                .and_then(|at| json(&at)),
            "mod_settings" => backend
                .mod_settings(&needed(held.install, "install")?)
                .map_err(said)
                .and_then(|at| json(&at)),
            "open_mod_file" => backend
                .open_mod_file(
                    &needed(held.install, "install")?,
                    &needed(held.mod_id, "modId")?,
                    &needed(held.file, "file")?,
                )
                .map_err(said)
                .and_then(|()| json(&())),
            "identify_install" => json(&backend.identify_install(&needed(held.path, "path")?)),
            "scan_for_installs" => {
                json(&backend.scan_for_installs(&held.known.unwrap_or_default()))
            }
            "installed_sfall_version" => backend
                .installed_sfall_version(&needed(held.install, "install")?)
                .map_err(said)
                .and_then(|at| json(&at)),
            "latest_sfall" => backend
                .latest_sfall()
                .map_err(said)
                .and_then(|at| json(&at)),
            "update_sfall" => backend
                .update_sfall(
                    &needed(held.install, "install")?,
                    &needed(held.version, "version")?,
                )
                .map_err(said)
                .and_then(|at| json(&at)),
            "list_sfall_versions" => backend
                .list_sfall_versions()
                .map_err(said)
                .and_then(|at| json(&at)),
            "machine_engines" => backend
                .machine_engines()
                .map_err(said)
                .and_then(|at| json(&at)),
            "deployed_engines" => backend
                .deployed_engines(&needed(held.install, "install")?)
                .map_err(said)
                .and_then(|at| json(&at)),
            "engine_releases" => backend
                .engine_releases(&needed(held.engine_id, "engineId")?)
                .map_err(said)
                .and_then(|at| json(&at)),
            "fetch_engine" => backend
                .fetch_engine(
                    &needed(held.engine_id, "engineId")?,
                    held.published.as_deref(),
                )
                .map_err(said)
                .and_then(|at| json(&at)),
            "forget_engine" => backend
                .forget_engine(
                    &needed(held.engine_id, "engineId")?,
                    &needed(held.published, "published")?,
                )
                .map_err(said)
                .and_then(|()| json(&())),
            "use_engine_build" => backend
                .use_engine_build(
                    &needed(held.install, "install")?,
                    &needed(held.engine_id, "engineId")?,
                    &needed(held.pick, "pick")?,
                )
                .map_err(said)
                .and_then(|()| json(&())),
            "installed_hires_version" => backend
                .installed_hires_version(&needed(held.install, "install")?)
                .map_err(said)
                .and_then(|at| json(&at)),
            "latest_zax" => backend.latest_zax().map_err(said).and_then(|at| json(&at)),
            "list_saves" => backend
                .list_saves(&needed(held.install, "install")?)
                .map_err(said)
                .and_then(|at| json(&at)),
            "create_debug_package" => backend
                .create_debug_package(
                    &needed(held.install, "install")?,
                    &held.saves.unwrap_or_default(),
                )
                .map_err(said)
                .and_then(|at| json(&at)),
            "order_swap" => backend
                .order_swap(&needed(held.install, "install")?, held.engine_id.as_deref())
                .map_err(said)
                .and_then(|at| json(&at)),
            "launch" => backend
                .launch(
                    &needed(held.install, "install")?,
                    held.sfall_version.as_deref(),
                    held.engine_id.as_deref(),
                    held.pick.as_ref(),
                )
                .map_err(said)
                .and_then(|()| json(&())),
            "open" => backend
                .open(&needed(held.target, "target")?)
                .map_err(said)
                .and_then(|()| json(&())),
            "wipe" => backend
                .wipe(needed(held.which, "which")?)
                .map_err(said)
                .and_then(|()| json(&())),
            "cancel" => {
                backend.cancel();
                json(&())
            }
            other => Err(format!("The preview does not answer \"{other}\".")),
        }
    }
}

/// The names the dispatcher answers, which is what a test compares against the shell's own list.
pub const PREVIEW_COMMANDS: &[&str] = &[
    "describe",
    "choose_folder",
    "load_state",
    "save_state",
    "load_config_files",
    "save_config_files",
    "settings_base",
    "accept_settings_base",
    "load_mods",
    "save_mods",
    "published_mods",
    "mod_install_state",
    "plan_mod",
    "install_mod",
    "mod_versions",
    "restore_mod",
    "remove_mod",
    "mod_settings",
    "open_mod_file",
    "identify_install",
    "scan_for_installs",
    "installed_sfall_version",
    "latest_sfall",
    "update_sfall",
    "list_sfall_versions",
    "machine_engines",
    "deployed_engines",
    "engine_releases",
    "fetch_engine",
    "forget_engine",
    "use_engine_build",
    "installed_hires_version",
    "latest_zax",
    "list_saves",
    "create_debug_package",
    "order_swap",
    "launch",
    "open",
    "wipe",
    "cancel",
];

#[cfg(target_arch = "wasm32")]
mod browser {
    use wasm_bindgen::prelude::*;

    /// The preview as the interface holds it: made once, then called by name.
    #[wasm_bindgen]
    pub struct ZaxPreview {
        held: super::Preview,
    }

    #[wasm_bindgen]
    impl ZaxPreview {
        /// A fresh machine, seeded.
        ///
        /// # Errors
        ///
        /// Fails only where the fixture cannot be seeded.
        #[wasm_bindgen(constructor)]
        pub fn new() -> Result<ZaxPreview, JsValue> {
            super::Preview::new()
                .map(|held| Self { held })
                .map_err(|err| JsValue::from_str(&err.to_string()))
        }

        /// One command, by the name the shell registers it under, with its arguments as JSON.
        ///
        /// # Errors
        ///
        /// Answers with the sentence the interface shows.
        pub fn invoke(&self, name: &str, arguments: &str) -> Result<String, JsValue> {
            match self.held.invoke(name, arguments) {
                Ok(value) => Ok(value.to_string()),
                Err(said) => Err(JsValue::from_str(&said)),
            }
        }

        /// Where a long operation's progress goes, as the JSON one message carries.
        #[wasm_bindgen(js_name = onProgress)]
        pub fn on_progress(&self, listener: js_sys::Function) {
            self.held.on_progress(Box::new(move |progress| {
                let Ok(said) = serde_json::to_string(progress) else {
                    return;
                };
                // A listener that throws is the interface's problem, not the operation's.
                let _ = listener.call1(&JsValue::NULL, &JsValue::from_str(&said));
            }));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn preview() -> Preview {
        Preview::new().expect("the fixture seeds")
    }

    #[test]
    fn the_machine_describes_itself() {
        let held = preview().invoke("describe", "").expect("an answer");
        assert_eq!(held["os"], "linux");
        assert!(
            held["logFile"]
                .as_str()
                .is_some_and(|at| at.contains("preview")),
            "{held}"
        );
    }

    #[test]
    fn the_state_the_interface_opens_on_comes_back() {
        let held = preview().invoke("load_state", "{}").expect("an answer");
        let installs = held["state"]["installs"].as_array().expect("a list");
        assert_eq!(installs.len(), 6);
        assert_eq!(installs[0]["path"], fixture::PREVIEW_INSTALL);
        assert_eq!(installs[0]["type"], "fallout2up");
    }

    #[test]
    fn a_command_the_preview_does_not_answer_says_so() {
        let err = preview()
            .invoke("nothing_of_the_sort", "{}")
            .expect_err("no such command");
        assert!(err.contains("does not answer"), "{err}");
    }

    #[test]
    fn an_argument_the_command_needs_is_named_when_it_is_missing() {
        let err = preview().invoke("load_mods", "{}").expect_err("no install");
        assert!(err.contains("\"install\""), "{err}");
    }

    #[test]
    fn an_argument_spelled_wrongly_fails_rather_than_arriving_as_nothing() {
        let err = preview()
            .invoke("load_mods", r#"{"instal":{"path":"x","type":"fallout2"}}"#)
            .expect_err("an unknown field");
        assert!(err.contains("could not read the arguments"), "{err}");
    }

    #[test]
    fn the_mods_folder_is_read_for_real() {
        let held = preview()
            .invoke(
                "load_mods",
                &format!(
                    r#"{{"install":{{"path":"{}","type":"fallout2up"}}}}"#,
                    fixture::PREVIEW_INSTALL
                ),
            )
            .expect("an answer");
        assert_eq!(held["format"], "sfall");
        assert!(
            held["text"]
                .as_str()
                .is_some_and(|at| at.contains("fo2tweaks.dat"))
        );
    }

    #[test]
    fn what_cannot_be_simulated_honestly_is_refused() {
        // A recorded launch that never happened reads as success.
        let err = preview()
            .invoke(
                "launch",
                &format!(
                    r#"{{"install":{{"path":"{}","type":"fallout2up"}},"sfallVersion":null,"engineId":null,"pick":null}}"#,
                    fixture::PREVIEW_INSTALL
                ),
            )
            .expect_err("nothing to start");
        assert!(!err.is_empty());
        // And so is a folder picker a browser does not have.
        let err = preview()
            .invoke("choose_folder", "{}")
            .expect_err("no picker");
        assert!(err.contains("browser preview"), "{err}");
    }

    #[test]
    fn the_feeds_are_read_for_real_from_the_captured_listings() {
        // A listing states what exists and does nothing with it, so a real capture of one is not the
        // invented version number the rest of this seam refuses to produce.
        let held = preview().invoke("published_mods", "{}").expect("an answer");
        let published = held["published"].as_array().expect("a list");
        assert!(!published.is_empty(), "{held}");
        assert!(
            published.iter().any(|one| one["id"] == "fo2tweaks"),
            "{held}"
        );
    }

    #[test]
    fn every_name_the_shell_registers_is_one_the_preview_answers() {
        // The two hosts are one interface; a command only the desktop answers is a button the preview
        // silently cannot press.
        let shell = include_str!("../../shell/src/lib.rs");
        let list = shell
            .split_once("generate_handler![")
            .and_then(|(_, rest)| rest.split_once(']'))
            .map(|(held, _)| held)
            .expect("the shell's handler list");
        let mut registered: Vec<&str> = list
            .split("commands::")
            .skip(1)
            .filter_map(|held| held.split(&[',', '\n', ' '][..]).next())
            .filter(|held| !held.is_empty())
            .collect();
        registered.sort_unstable();
        let mut answered: Vec<&str> = PREVIEW_COMMANDS.to_vec();
        answered.sort_unstable();
        assert_eq!(answered, registered);
    }

    #[test]
    fn the_clock_does_not_move_between_runs() {
        // A stamped directory whose name moves is one no test can name.
        assert_eq!(preview().shell.now(), PREVIEW_NOW);
        assert_eq!(preview().shell.millis(), PREVIEW_MILLIS);
    }
}

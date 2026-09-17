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
#[cfg(test)]
mod session_tests;

use std::sync::{Arc, Mutex};

use serde::Deserialize;
use zax_core::stamp::{LocalTime, Utc};
use zax_fallout2::backend::{
    Backend, ModInstallRequest, OpenTarget, OperationProgress, OrderEdit, SettingEdit, Shell,
    WipeTarget,
};
use zax_fallout2::catalog_view::{catalog_view, search_settings};
use zax_fallout2::engine_choice::BuildPick;
use zax_fallout2::manifest::ModPart;
use zax_fallout2::mod_choice::{ChoiceGroup, toggle_option};
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
    /// The machine itself, for a test that changes a file underneath the interface.
    platform: Arc<fixture::PreviewPlatform>,
}

/// Every argument shape a command takes, read from the object the interface sends.
///
/// One struct rather than one per command: the fields are optional and a command reads the ones it
/// needs, which is what keeps this from being a third copy of every signature. Unknown fields are
/// refused, so an argument the interface spells wrongly fails here rather than arriving as nothing.
#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
struct Arguments {
    version: Option<String>,
    query: Option<String>,
    holding: Option<String>,
    path: Option<String>,
    name: Option<String>,
    wine: Option<zax_core::install::WineConfig>,
    theme: Option<zax_core::install::Theme>,
    on: Option<bool>,
    engine_id: Option<String>,
    id: Option<String>,
    value: Option<String>,
    edits: Option<Vec<SettingEdit>>,
    ids: Option<Vec<String>>,
    all: Option<bool>,
    action_id: Option<String>,
    group: Option<String>,
    edit: Option<OrderEdit>,
    refresh: Option<bool>,
    mod_id: Option<String>,
    choices: Option<Vec<String>>,
    answers: Option<std::collections::BTreeMap<String, String>>,
    request: Option<ModInstallRequest>,
    above: Option<String>,
    file: Option<String>,
    groups: Option<Vec<ChoiceGroup<ModPart>>>,
    chosen: Option<Vec<String>>,
    published: Option<String>,
    pick: Option<BuildPick>,
    saves: Option<Vec<String>>,
    target: Option<OpenTarget>,
    which: Option<WipeTarget>,
    what: Option<String>,
}

/// What a command answers with: the value as JSON, or the sentence the interface shows.
type Answer = std::result::Result<serde_json::Value, String>;

fn json<T: serde::Serialize>(value: &T) -> Answer {
    serde_json::to_value(value).map_err(|err| format!("The answer could not be written: {err}"))
}

fn needed<T>(held: Option<T>, name: &str) -> std::result::Result<T, String> {
    held.ok_or_else(|| format!("The preview was called without \"{name}\"."))
}

/// An operation's answer as JSON, or its refusal as the sentence the interface shows.
fn answered<T: serde::Serialize>(outcome: Result<T>) -> Answer {
    outcome
        .map_err(|err| err.to_string())
        .and_then(|value| json(&value))
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
        let machine = Arc::new(preview_platform()?);
        let platform: Arc<dyn Platform> = Arc::clone(&machine) as Arc<dyn Platform>;
        Ok(Self {
            backend: Backend::new(platform, Arc::clone(&shell) as Arc<dyn Shell>),
            shell,
            platform: machine,
        })
    }

    /// Writes a file on the in-memory disk, as something outside ZAX would - a text editor, an engine's
    /// own first run. What the interface's tests change underneath it.
    ///
    /// # Errors
    ///
    /// Fails where the disk refuses the write.
    pub fn write_file(&self, path: &str, bytes: &[u8]) -> Result<()> {
        self.platform.fs().write(std::path::Path::new(path), bytes)
    }

    /// # Errors
    ///
    /// Fails where there is no such file.
    pub fn read_file(&self, path: &str) -> Result<Vec<u8>> {
        self.platform.fs().read(std::path::Path::new(path))
    }

    /// # Errors
    ///
    /// Fails where the disk refuses the removal.
    pub fn remove_file(&self, path: &str) -> Result<()> {
        self.platform.fs().remove(std::path::Path::new(path))
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
        let wine = backend.describe().os != zax_platform::OperatingSystem::Windows;
        match name {
            "start" => answered(backend.start(&needed(held.version, "version")?)),
            "view" => json(&backend.view()),
            "catalog" => json(catalog_view()),
            "search" => json(&search_settings(&needed(held.query, "query")?, wine)),
            "choose_folder" => answered(backend.choose_folder(held.holding.as_deref())),
            "select_install" => answered(backend.select_install(&needed(held.path, "path")?)),
            "refresh" => answered(backend.refresh()),
            "add_install" => answered(backend.add_install(&needed(held.path, "path")?)),
            "remove_install" => answered(backend.remove_install(&needed(held.path, "path")?)),
            "set_alias" => answered(
                backend.set_alias(&needed(held.path, "path")?, &needed(held.name, "name")?),
            ),
            "set_wine" => {
                answered(backend.set_wine(&needed(held.path, "path")?, &needed(held.wine, "wine")?))
            }
            "set_theme" => answered(backend.set_theme(needed(held.theme, "theme")?)),
            "set_autosave" => answered(backend.set_autosave(needed(held.on, "on")?)),
            "accept_caution" => {
                answered(backend.accept_caution(&needed(held.engine_id, "engineId")?))
            }
            "scan" => answered(backend.scan()),
            "set_settings" => answered(backend.set_settings(&needed(held.edits, "edits")?)),
            "revert_settings" => answered(
                backend.revert_settings(&held.ids.unwrap_or_default(), needed(held.all, "all")?),
            ),
            "apply_action" => answered(backend.apply_action(&needed(held.action_id, "actionId")?)),
            "satisfy_gate" => {
                answered(backend.satisfy_gate(&needed(held.id, "id")?, held.group.as_deref()))
            }
            "choose_linked" => answered(
                backend.choose_linked(&needed(held.id, "id")?, &needed(held.value, "value")?),
            ),
            "edit_order" => answered(backend.edit_order(&needed(held.edit, "edit")?)),
            "save" => answered(backend.save()),
            "check_zax" => answered(backend.check_zax()),
            "check_sfall" => answered(backend.check_sfall()),
            "check_engine" => answered(backend.check_engine(&needed(held.engine_id, "engineId")?)),
            "list_sfall_versions" => answered(backend.list_sfall_versions()),
            "change_sfall" => answered(backend.change_sfall(held.version.as_deref())),
            "read_mod_listing" => {
                answered(backend.read_mod_listing(needed(held.refresh, "refresh")?))
            }
            "plan_mod" => answered(backend.plan_selected_mod(
                &needed(held.mod_id, "modId")?,
                &held.choices.unwrap_or_default(),
                &held.answers.unwrap_or_default(),
                held.version.as_deref(),
            )),
            "install_mod" => {
                answered(backend.install_mod_and_read(&needed(held.request, "request")?))
            }
            "mod_versions" => answered(
                backend.mod_versions(&needed(held.mod_id, "modId")?, held.above.as_deref()),
            ),
            "restore_mod" => answered(backend.restore_mod_and_read(&needed(held.mod_id, "modId")?)),
            "remove_mod" => answered(backend.remove_mod_and_read(&needed(held.mod_id, "modId")?)),
            "open_mod_file" => answered(backend.open_selected_mod_file(
                &needed(held.mod_id, "modId")?,
                &needed(held.file, "file")?,
            )),
            "toggle_mod_part" => json(&toggle_option(
                &needed(held.groups, "groups")?,
                &needed(held.chosen, "chosen")?,
                &needed(held.id, "id")?,
                needed(held.on, "on")?,
            )),
            "fetch_engine" => answered(backend.fetch_engine_and_list(
                &needed(held.engine_id, "engineId")?,
                held.published.as_deref(),
            )),
            "forget_engine" => answered(backend.forget_engine_and_list(
                &needed(held.engine_id, "engineId")?,
                &needed(held.published, "published")?,
            )),
            "use_engine_build" => answered(backend.use_engine_build_here(
                &needed(held.engine_id, "engineId")?,
                &needed(held.pick, "pick")?,
            )),
            "order_swap" => answered(backend.selected_order_swap(held.engine_id.as_deref())),
            "launch" => {
                answered(backend.launch_selected(held.engine_id.as_deref(), held.pick.as_ref()))
            }
            "list_saves" => answered(backend.selected_saves()),
            "create_debug_package" => {
                answered(backend.selected_debug_package(&held.saves.unwrap_or_default()))
            }
            "open" => answered(backend.open(&needed(held.target, "target")?)),
            "wipe" => answered(backend.wipe(needed(held.which, "which")?)),
            "cancel" => {
                backend.cancel();
                json(&())
            }
            // A page has no window to close on an operation, so there is nothing to hold.
            "set_busy" => json(&()),
            other => Err(format!("The preview does not answer \"{other}\".")),
        }
    }
}

/// The names the dispatcher answers, which is what a test compares against the shell's own list.
pub const PREVIEW_COMMANDS: &[&str] = &[
    "start",
    "view",
    "catalog",
    "search",
    "choose_folder",
    "select_install",
    "refresh",
    "add_install",
    "remove_install",
    "set_alias",
    "set_wine",
    "set_theme",
    "set_autosave",
    "accept_caution",
    "scan",
    "set_settings",
    "revert_settings",
    "apply_action",
    "satisfy_gate",
    "choose_linked",
    "edit_order",
    "save",
    "check_zax",
    "check_sfall",
    "check_engine",
    "list_sfall_versions",
    "change_sfall",
    "read_mod_listing",
    "plan_mod",
    "install_mod",
    "mod_versions",
    "restore_mod",
    "remove_mod",
    "open_mod_file",
    "toggle_mod_part",
    "fetch_engine",
    "forget_engine",
    "use_engine_build",
    "order_swap",
    "launch",
    "list_saves",
    "create_debug_package",
    "open",
    "wipe",
    "cancel",
    "set_busy",
];

#[cfg(target_arch = "wasm32")]
mod browser {
    use wasm_bindgen::prelude::*;

    /// The preview as the interface holds it: made once, then called by name.
    #[wasm_bindgen]
    #[derive(Debug)]
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

        /// Writes a file on the in-memory disk.
        ///
        /// # Errors
        ///
        /// Answers with the refusal.
        #[wasm_bindgen(js_name = writeFile)]
        pub fn write_file(&self, path: &str, bytes: &[u8]) -> Result<(), JsValue> {
            self.held
                .write_file(path, bytes)
                .map_err(|err| JsValue::from_str(&err.to_string()))
        }

        /// # Errors
        ///
        /// Answers with the refusal.
        #[wasm_bindgen(js_name = readFile)]
        pub fn read_file(&self, path: &str) -> Result<Vec<u8>, JsValue> {
            self.held
                .read_file(path)
                .map_err(|err| JsValue::from_str(&err.to_string()))
        }

        /// # Errors
        ///
        /// Answers with the refusal.
        #[wasm_bindgen(js_name = removeFile)]
        pub fn remove_file(&self, path: &str) -> Result<(), JsValue> {
            self.held
                .remove_file(path)
                .map_err(|err| JsValue::from_str(&err.to_string()))
        }

        /// A library recording this file version, for a test that plants `ddraw.dll` or `f2_res.dll`.
        #[wasm_bindgen(js_name = versionedLibrary)]
        #[must_use]
        pub fn versioned_library(version: &str) -> Vec<u8> {
            zax_fallout2::pe_fixture::library(&[("FileVersion", version)])
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
        let held = preview().invoke("view", "").expect("an answer")["machine"].clone();
        assert_eq!(held["os"], "linux");
        assert!(
            held["logFile"]
                .as_str()
                .is_some_and(|at| at.contains("preview")),
            "{held}"
        );
    }

    /// A preview that has started, as the interface leaves it after its first call.
    fn started() -> (Preview, serde_json::Value) {
        let held = preview();
        let view = held
            .invoke("start", r#"{"version":"0.8.0"}"#)
            .expect("a start")["view"]
            .clone();
        (held, view)
    }

    #[test]
    fn starting_opens_on_the_first_install_with_its_files_read() {
        let (_, view) = started();
        let installs = view["installs"].as_array().expect("a list");
        assert_eq!(installs.len(), 6);
        assert_eq!(view["selected"], fixture::PREVIEW_INSTALL);
        assert_eq!(installs[0]["type"], "fallout2up");
        let reading = &view["reading"];
        assert_eq!(reading["path"], fixture::PREVIEW_INSTALL);
        assert!(
            reading["files"]
                .as_array()
                .is_some_and(|files| files.iter().any(|one| one == "ddraw.ini")),
            "{reading}"
        );
        assert_eq!(reading["order"]["format"], "sfall");
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
        let err = preview()
            .invoke("select_install", "{}")
            .expect_err("no path");
        assert!(err.contains("\"path\""), "{err}");
    }

    #[test]
    fn an_argument_spelled_wrongly_fails_rather_than_arriving_as_nothing() {
        let err = preview()
            .invoke("select_install", r#"{"pth":"x"}"#)
            .expect_err("an unknown field");
        assert!(err.contains("could not read the arguments"), "{err}");
    }

    #[test]
    fn what_cannot_be_simulated_honestly_is_refused() {
        // A recorded launch that never happened reads as success.
        let (held, _) = started();
        let err = held
            .invoke("launch", r#"{"engineId":null,"pick":null}"#)
            .expect_err("nothing to start");
        assert!(!err.is_empty());
        // And so is a folder picker a browser does not have.
        let err = held.invoke("choose_folder", "{}").expect_err("no picker");
        assert!(err.contains("browser preview"), "{err}");
    }

    #[test]
    fn the_feeds_are_read_for_real_from_the_captured_listings() {
        // A listing states what exists and does nothing with it, so a real capture of one is not the
        // invented version number the rest of this seam refuses to produce.
        let (held, _) = started();
        let view = held
            .invoke("read_mod_listing", r#"{"refresh":false}"#)
            .expect("an answer");
        let offers = view["reading"]["modListing"]["offers"]
            .as_array()
            .expect("a listing");
        assert!(offers.iter().any(|one| one["id"] == "fo2tweaks"), "{view}");
    }

    #[test]
    fn a_later_answer_carries_a_higher_revision() {
        let (held, first) = started();
        let second = held.invoke("view", "{}").expect("a view");
        assert!(second["revision"].as_u64() > first["revision"].as_u64());
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

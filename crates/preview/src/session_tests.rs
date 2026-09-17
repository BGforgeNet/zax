//! What the interface relies on the held state for, driven the way the interface drives it: by command
//! name, with JSON arguments, against the seeded preview machine.
//!
//! These were the store's own tests while the state lived in the interface. They run here now because
//! the rules they pin down do, and through the dispatcher rather than the backend's methods so the
//! argument shapes the interface sends are exercised with them.

use std::path::Path;

use serde_json::{Value, json};
use zax_platform::Platform as _;

use crate::Preview;
use crate::fixture::PREVIEW_INSTALL;

const BARTER: &str = "sfall.Interface.ExpandBarter";
const MUSIC: &str = "game.sound.music";
const PINNED: &str = "hires.MAIN.UAC_AWARE";
const ORDER_FILE: &str = "fixtures/f2up/mods/mods_order.txt";
const MOD_INI: &str = "fixtures/f2up/mods/fo2tweaks.ini";
const FALLOUT2_CFG: &str = include_str!("../../../fixtures/f2up/fallout2.cfg");
const DDRAW_INI: &str = include_str!("../../../fixtures/f2up/ddraw.ini");
const F2_RES_INI: &str = include_str!("../../../fixtures/f2up/f2_res.ini");

/// The preview as the interface holds it once started, and the view it last answered.
struct Machine {
    preview: Preview,
    view: Value,
}

impl Machine {
    fn started() -> Self {
        let preview = Preview::new().expect("the fixture seeds");
        let mut machine = Self {
            preview,
            view: Value::Null,
        };
        machine.start();
        machine
    }

    /// Starts again over the same disk, as a restart of the application would, and comes back to the
    /// install these tests are about. A restart opens on the first install listed, and a state file
    /// written since the seed lists them in its own order.
    fn start(&mut self) {
        let started = self.call("start", &json!({ "version": "0.8.0" }))["view"].clone();
        self.accept(started);
        if self.view["selected"] != PREVIEW_INSTALL {
            self.act("select_install", &json!({ "path": PREVIEW_INSTALL }));
        }
    }

    fn call(&self, name: &str, arguments: &Value) -> Value {
        self.preview
            .invoke(name, &arguments.to_string())
            .unwrap_or_else(|err| panic!("{name} refused: {err}"))
    }

    fn refused(&self, name: &str, arguments: &Value) -> String {
        match self.preview.invoke(name, &arguments.to_string()) {
            Ok(answer) => panic!("{name} answered where it should have refused: {answer}"),
            Err(said) => said,
        }
    }

    /// Takes a view as the interface does: rows sent as changes are laid over the rows held, where they
    /// are changes against the view held, and a whole view is asked for where they are not.
    fn accept(&mut self, mut view: Value) {
        let since = view["reading"]["since"].as_u64();
        if let Some(since) = since {
            if self.view["revision"].as_u64() != Some(since) {
                self.view = self.call("view", &json!({}));
                return;
            }
            let held = &self.view["reading"];
            let mut rows = held["rows"].as_object().cloned().unwrap_or_default();
            for (id, row) in view["reading"]["rows"]
                .as_object()
                .cloned()
                .unwrap_or_default()
            {
                rows.insert(id, row);
            }
            let reading = &mut view["reading"];
            reading["rows"] = Value::Object(rows);
            reading["discovered"] = held["discovered"].clone();
            reading["modSettings"] = held["modSettings"].clone();
            reading["since"] = Value::Null;
        }
        self.view = view;
    }

    /// Runs a command answering the view, and keeps it.
    fn act(&mut self, name: &str, arguments: &Value) -> &Value {
        let view = self.call(name, arguments);
        self.accept(view);
        &self.view
    }

    /// Runs a command answering the view beside something else, keeps the view, and answers the rest.
    fn answer(&mut self, name: &str, arguments: &Value) -> Value {
        let held = self.call(name, arguments);
        self.accept(held["view"].clone());
        held["answer"].clone()
    }

    fn set(&mut self, id: &str, value: &str) {
        self.act("set_setting", &json!({ "id": id, "value": value }));
    }

    fn save(&mut self) -> Value {
        self.answer("save", &json!({}))
    }

    fn revert_all(&mut self) {
        self.act("revert_settings", &json!({ "ids": [], "all": true }));
    }

    fn set_autosave(&mut self, on: bool) {
        self.act("set_autosave", &json!({ "on": on }));
    }

    fn row(&self, id: &str) -> &Value {
        &self.view["reading"]["rows"][id]
    }

    fn value_of(&self, id: &str) -> Option<&str> {
        self.row(id)["value"].as_str()
    }

    fn modified(&self, id: &str) -> bool {
        self.row(id)["modified"] == true
    }

    fn reading(&self) -> &Value {
        &self.view["reading"]
    }

    fn write(&self, path: &str, text: &str) {
        self.preview
            .platform
            .fs()
            .write(Path::new(path), text.as_bytes())
            .expect("a file the test writes");
    }

    fn read(&self, path: &str) -> String {
        let bytes = self
            .preview
            .platform
            .fs()
            .read(Path::new(path))
            .expect("a file the test reads");
        bytes.iter().map(|byte| char::from(*byte)).collect()
    }

    fn installs(&self) -> Vec<&str> {
        self.view["installs"]
            .as_array()
            .expect("a list")
            .iter()
            .filter_map(|one| one["path"].as_str())
            .collect()
    }
}

fn install_file(name: &str) -> String {
    format!("{PREVIEW_INSTALL}/{name}")
}

#[test]
fn an_edit_sends_only_the_rows_it_changed_and_a_view_out_of_step_is_sent_whole() {
    let mut held = Machine::started();
    let whole = held.reading()["rows"]
        .as_object()
        .map_or(0, serde_json::Map::len);
    let flipped = if held.value_of(MUSIC) == Some("1") {
        "0"
    } else {
        "1"
    };
    let patch = held.call("set_setting", &json!({ "id": MUSIC, "value": flipped }));
    let sent = patch["reading"]["rows"]
        .as_object()
        .map_or(0, serde_json::Map::len);
    assert!(
        sent >= 1 && sent < whole,
        "{sent} of {whole} rows were sent"
    );
    assert_eq!(patch["reading"]["since"], held.view["revision"]);
    assert!(patch["reading"]["rows"][MUSIC]["modified"] == true);

    // A view nobody applied leaves the next patch based on a revision the interface does not hold.
    let unapplied = held.call("set_setting", &json!({ "id": MUSIC, "value": "0" }));
    held.act("set_setting", &json!({ "id": MUSIC, "value": flipped }));
    assert!(unapplied["revision"].as_u64() < held.view["revision"].as_u64());
    assert_eq!(held.value_of(MUSIC), Some(flipped));
    assert_eq!(
        held.reading()["rows"]
            .as_object()
            .map_or(0, serde_json::Map::len),
        whole,
        "the whole view was asked for rather than a patch laid over the wrong base"
    );
}

#[test]
fn starts_on_the_seeded_install_with_its_config_files_read() {
    let held = Machine::started();
    assert_eq!(held.view["selected"], PREVIEW_INSTALL);
    // Read from the fixture rather than defaulted: everything below distinguishes a value from its
    // absence.
    assert_eq!(held.value_of("sfall.Misc.ProcessorIdle"), Some("-1"));
    assert_eq!(
        held.value_of("hires.OTHER_SETTINGS.CPU_USAGE_FIX"),
        Some("0")
    );
}

mod linked {
    use super::*;

    /// An install whose engines have each written their own settings, saving by hand.
    fn with_engines() -> Machine {
        let mut held = Machine::started();
        held.write(
            &install_file("fallout2.cfg"),
            &format!("{FALLOUT2_CFG}\n[ui]\nextend_ap_bar=0\nexpand_barter_window=0\n"),
        );
        held.write(
            &install_file("fission.cfg"),
            "[enhancements]\nEnhancedBarter=0\n",
        );
        held.set_autosave(false);
        held.start();
        held
    }

    /// ZAX wrote 0 everywhere, then an engine's own screen moved its copy to `moved`.
    fn with_carry(moved: &str) -> Machine {
        let mut held = with_engines();
        held.set(BARTER, "0");
        held.save();
        held.write(
            &install_file("fission.cfg"),
            &format!("[enhancements]\nEnhancedBarter={moved}\n"),
        );
        held.start();
        held
    }

    fn with_both_moved() -> Machine {
        let mut held = with_engines();
        held.set(BARTER, "0");
        held.save();
        held.write(
            &install_file("fission.cfg"),
            "[enhancements]\nEnhancedBarter=1\n",
        );
        held.write(
            &install_file("ddraw.ini"),
            &format!("{DDRAW_INI}\n[Interface]\nExpandBarter=2\n"),
        );
        held.start();
        held
    }

    fn choices(held: &Machine) -> Vec<&str> {
        held.reading()["choices"]
            .as_array()
            .expect("a list")
            .iter()
            .filter_map(|one| one["id"].as_str())
            .collect()
    }

    #[test]
    fn writes_one_edit_to_every_engine_that_has_run_under_each_of_their_own_names() {
        let mut held = with_engines();
        held.set(BARTER, "1");
        assert_eq!(
            held.save(),
            Value::Null,
            "a save that worked has nothing to report"
        );
        assert!(
            held.read(&install_file("ddraw.ini"))
                .contains("ExpandBarter=1")
        );
        assert!(
            held.read(&install_file("fallout2.cfg"))
                .contains("expand_barter_window=1")
        );
        assert!(
            held.read(&install_file("fission.cfg"))
                .contains("EnhancedBarter=1")
        );
    }

    #[test]
    fn leaves_the_keys_of_an_engine_that_has_never_run_alone() {
        let mut held = Machine::started();
        held.write(
            &install_file("fission.cfg"),
            "[enhancements]\nEnhancedBarter=0\n",
        );
        held.start();
        held.set(BARTER, "1");
        held.save();
        assert!(
            held.read(&install_file("ddraw.ini"))
                .contains("ExpandBarter=1")
        );
        assert!(
            held.read(&install_file("fission.cfg"))
                .contains("EnhancedBarter=1")
        );
        // The seeded fixture is vanilla, so fallout2-ce has written nothing and neither does ZAX.
        let game = held.read(&install_file("fallout2.cfg"));
        assert!(!game.contains("expand_barter_window"));
        assert!(!game.contains("[ui]"));
    }

    #[test]
    fn carries_a_value_changed_inside_an_engine_across_and_says_where_it_came_from() {
        let held = with_carry("1");
        assert_eq!(held.value_of(BARTER), Some("1"), "the newer value won");
        assert!(
            held.modified(BARTER),
            "left pending rather than written during a load"
        );
        assert_eq!(held.row(BARTER)["carriedFrom"], "fission.cfg");
        assert!(held.reading()["carry"].is_string());
    }

    #[test]
    fn writes_the_carry_instead_of_queueing_it_when_autosave_is_on() {
        let mut held = with_engines();
        held.set(BARTER, "0");
        held.save();
        held.set_autosave(true);
        held.write(
            &install_file("fission.cfg"),
            "[enhancements]\nEnhancedBarter=1\n",
        );
        held.start();

        assert_eq!(held.value_of(BARTER), Some("1"));
        assert!(
            !held.modified(BARTER),
            "it reached the files rather than the Save button"
        );
        assert_eq!(held.reading()["modifiedCount"], 0);
        assert!(
            held.read(&install_file("ddraw.ini"))
                .contains("ExpandBarter=1")
        );
        assert_eq!(
            held.reading()["carry"],
            "One setting was changed outside ZAX and carried across to the other engines."
        );
    }

    #[test]
    fn leaves_a_reverted_carry_alone_on_every_later_read_of_the_install() {
        let mut held = with_carry("1");
        held.revert_all();
        assert!(!held.modified(BARTER), "the carried edit is gone");
        assert!(held.row(BARTER)["carriedFrom"].is_null());
        assert!(
            held.reading()["carry"].is_null(),
            "and the note that asked about it"
        );

        held.act("select_install", &json!({ "path": "fixtures/f2" }));
        held.act("select_install", &json!({ "path": PREVIEW_INSTALL }));

        assert!(
            held.reading()["carry"].is_null(),
            "nothing is left to raise"
        );
        assert!(!held.modified(BARTER));
        assert!(
            held.read(&install_file("fission.cfg"))
                .contains("EnhancedBarter=1")
        );
        assert!(
            held.read(&install_file("ddraw.ini"))
                .contains("ExpandBarter=0")
        );
    }

    #[test]
    fn carries_a_further_change_inside_an_engine_measured_from_the_accepted_base() {
        let mut held = with_carry("1");
        held.revert_all();
        held.write(
            &install_file("fission.cfg"),
            "[enhancements]\nEnhancedBarter=2\n",
        );
        held.start();
        assert_eq!(
            held.value_of(BARTER),
            Some("2"),
            "accepting one is not agreeing to the next"
        );
        assert_eq!(held.row(BARTER)["carriedFrom"], "fission.cfg");
    }

    #[test]
    fn asks_rather_than_choosing_when_two_engines_have_both_moved() {
        let held = with_both_moved();
        assert!(held.row(BARTER)["carriedFrom"].is_null());
        assert!(choices(&held).contains(&BARTER));
    }

    #[test]
    fn stops_asking_once_an_answered_choice_has_been_reverted() {
        let mut held = with_both_moved();
        held.act("choose_linked", &json!({ "id": BARTER, "value": "1" }));
        assert!(held.modified(BARTER));
        held.revert_all();
        held.start();
        assert!(
            choices(&held).is_empty(),
            "the question was answered and the answer undone"
        );
        assert!(held.reading()["carry"].is_null());
    }

    #[test]
    fn leaves_an_unanswered_question_standing_through_a_revert() {
        let mut held = with_both_moved();
        held.set("game.preferences.running", "1");
        held.revert_all();
        assert!(choices(&held).contains(&BARTER));
    }

    #[test]
    fn answering_with_the_value_the_own_address_holds_still_reaches_the_other_engine() {
        let mut held = with_both_moved();
        assert_eq!(
            held.value_of(BARTER),
            Some("2"),
            "what the control was showing"
        );
        held.act("choose_linked", &json!({ "id": BARTER, "value": "2" }));
        assert!(
            held.modified(BARTER),
            "fission.cfg still holds something else"
        );
        assert_eq!(held.reading()["modifiedCount"], 1);
        held.save();
        assert!(
            held.read(&install_file("fission.cfg"))
                .contains("EnhancedBarter=2")
        );
        assert!(
            held.read(&install_file("ddraw.ini"))
                .contains("ExpandBarter=2")
        );
        assert!(
            choices(&held).is_empty(),
            "the question is settled for good"
        );
    }

    #[test]
    fn marks_a_carried_row_modified_even_where_the_address_that_moved_is_on_screen() {
        let mut held = with_engines();
        held.set(BARTER, "0");
        held.save();
        held.write(
            &install_file("ddraw.ini"),
            &format!("{DDRAW_INI}\n[Interface]\nExpandBarter=1\n"),
        );
        held.start();
        assert_eq!(held.row(BARTER)["carriedFrom"], "ddraw.ini");
        assert_eq!(held.value_of(BARTER), Some("1"));
        assert!(
            held.modified(BARTER),
            "so the row is marked and offers its revert"
        );
    }

    #[test]
    fn asks_again_when_an_engine_moves_once_more_after_an_answer_was_reverted() {
        let mut held = with_both_moved();
        held.act("choose_linked", &json!({ "id": BARTER, "value": "1" }));
        held.revert_all();
        held.write(
            &install_file("fission.cfg"),
            "[enhancements]\nEnhancedBarter=3\n",
        );
        held.start();
        assert_eq!(held.value_of(BARTER), Some("3"));
    }

    #[test]
    fn a_linked_setting_under_the_engines_own_key_is_not_a_second_row() {
        let mut held = Machine::started();
        held.write(
            &install_file("fallout2.cfg"),
            &format!("{FALLOUT2_CFG}\n[ui]\nexpand_barter_window=1\n"),
        );
        held.write(
            &install_file("ddraw.ini"),
            &format!("{DDRAW_INI}\n[Interface]\nExpandBarter=0\n"),
        );
        held.start();
        let ids: Vec<&str> = held.reading()["discovered"]
            .as_array()
            .expect("a list")
            .iter()
            .filter_map(|one| one["id"].as_str())
            .collect();
        assert!(!ids.contains(&"raw.fallout2.cfg.ui.expand_barter_window"));
        assert_eq!(ids.iter().filter(|id| **id == BARTER).count(), 1);
    }
}

mod installs {
    use super::*;

    #[test]
    fn removing_the_selected_install_moves_the_selection_rather_than_stranding_it() {
        let mut held = Machine::started();
        held.act("remove_install", &json!({ "path": PREVIEW_INSTALL }));
        assert_eq!(held.view["selected"], "fixtures/f2");
        assert_eq!(held.reading()["path"], "fixtures/f2");
    }

    #[test]
    fn removing_an_install_that_is_not_selected_leaves_the_selection_alone() {
        let mut held = Machine::started();
        held.act("remove_install", &json!({ "path": "fixtures/f2" }));
        assert_eq!(held.view["selected"], PREVIEW_INSTALL);
    }

    #[test]
    fn removing_the_last_install_leaves_nothing_selected_rather_than_a_stale_path() {
        let mut held = Machine::started();
        for path in held
            .installs()
            .into_iter()
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>()
        {
            held.act("remove_install", &json!({ "path": path }));
        }
        assert_eq!(held.view["selected"], "");
        assert!(held.reading().is_null());
    }

    #[test]
    fn wine_settings_attach_to_one_install_and_survive_a_change_to_the_other() {
        let mut held = Machine::started();
        held.act(
            "set_wine",
            &json!({ "path": PREVIEW_INSTALL, "wine": { "prefix": "/home/u/.wine-a" } }),
        );
        held.act(
            "set_wine",
            &json!({ "path": "fixtures/f2", "wine": { "debug": "-all" } }),
        );
        let wine_of = |path: &str| {
            held.view["installs"]
                .as_array()
                .expect("a list")
                .iter()
                .find(|one| one["path"] == path)
                .map(|one| one["wine"].clone())
        };
        assert_eq!(
            wine_of(PREVIEW_INSTALL),
            Some(json!({ "prefix": "/home/u/.wine-a" }))
        );
        assert_eq!(wine_of("fixtures/f2"), Some(json!({ "debug": "-all" })));
    }

    #[test]
    fn an_install_added_by_pointing_at_it_starts_with_wine_silenced() {
        let mut held = Machine::started();
        held.write("/elsewhere/Fallout 2/fallout2.exe", "MZ");
        let refusal = held.answer("add_install", &json!({ "path": "/elsewhere/Fallout 2" }));
        assert!(refusal.is_null(), "{refusal}");
        let added = held.view["installs"]
            .as_array()
            .expect("a list")
            .iter()
            .find(|one| one["path"] == "/elsewhere/Fallout 2")
            .cloned()
            .expect("the added install");
        assert_eq!(added["wine"], json!({ "debug": "-all" }));

        held.start();
        assert!(
            held.installs().contains(&"/elsewhere/Fallout 2"),
            "and it survives a restart"
        );
    }

    #[test]
    fn refuses_a_directory_that_does_not_hold_a_game_naming_it() {
        let mut held = Machine::started();
        let before = held.installs().len();
        let refusal = held.answer("add_install", &json!({ "path": "/elsewhere/not-a-game" }));
        assert!(
            refusal
                .as_str()
                .is_some_and(|said| said.contains("/elsewhere/not-a-game")),
            "{refusal}"
        );
        assert_eq!(held.installs().len(), before);
    }

    #[test]
    fn refuses_one_already_on_the_list_rather_than_listing_it_twice() {
        let mut held = Machine::started();
        let before = held.installs().len();
        let refusal = held.answer("add_install", &json!({ "path": PREVIEW_INSTALL }));
        assert!(refusal.is_string());
        assert_eq!(held.installs().len(), before);
    }
}

mod actions {
    use super::*;

    fn applied(held: &Machine, id: &str) -> bool {
        held.reading()["actions"]
            .as_array()
            .expect("a list")
            .iter()
            .find(|one| one["id"] == id)
            .is_some_and(|one| one["applied"] == true)
    }

    fn wine(held: &Machine) -> Value {
        held.view["installs"][0]["wine"].clone()
    }

    #[test]
    fn enabling_debugging_clears_winedebug_and_turning_it_off_silences_wine_again() {
        let mut held = Machine::started();
        held.act(
            "set_wine",
            &json!({ "path": PREVIEW_INSTALL, "wine": { "debug": "-all" } }),
        );
        assert!(
            !applied(&held, "debug.enable"),
            "silenced Wine leaves the action still to do"
        );

        held.act("apply_action", &json!({ "actionId": "debug.enable" }));
        assert!(wine(&held)["debug"].is_null(), "{}", wine(&held));

        held.act("apply_action", &json!({ "actionId": "debug.disable" }));
        assert_eq!(wine(&held)["debug"], "-all");
    }

    #[test]
    fn leaves_a_prefix_the_user_set_alone_while_changing_the_logging() {
        let mut held = Machine::started();
        held.act(
            "set_wine",
            &json!({ "path": PREVIEW_INSTALL, "wine": { "prefix": "/home/u/.wine-f2", "debug": "-all" } }),
        );
        held.act("apply_action", &json!({ "actionId": "debug.enable" }));
        assert_eq!(wine(&held), json!({ "prefix": "/home/u/.wine-f2" }));
    }
}

mod rows {
    use super::*;

    fn gate_active(held: &Machine, id: &str) -> bool {
        let row = held.row(id);
        row["groups"][row["ownGroup"].as_str().expect("a group")]["gate"]["active"] == true
    }

    #[test]
    fn a_gate_on_a_key_binding_opens_only_once_a_key_is_actually_bound() {
        let mut held = Machine::started();
        let gated = "sfall.Input.FastMoveFromContainer";
        assert!(!gate_active(&held, gated));
        held.set("sfall.Input.ItemFastMoveKey", "30");
        assert!(gate_active(&held, gated));
        held.set("sfall.Input.ItemFastMoveKey", "0");
        assert!(!gate_active(&held, gated));
    }

    #[test]
    fn the_merged_resolution_keys_carry_the_gate_the_pair_control_renders() {
        let mut held = Machine::started();
        assert!(!gate_active(&held, "sfall.Graphics.GraphicsWidth"));
        held.set("sfall.Graphics.Mode", "4");
        assert!(gate_active(&held, "sfall.Graphics.GraphicsWidth"));
    }

    #[test]
    fn a_conflict_stays_quiet_until_both_settings_are_in_the_states_that_clash() {
        let mut held = Machine::started();
        let fix = "hires.OTHER_SETTINGS.CPU_USAGE_FIX";
        let idle = "sfall.Misc.ProcessorIdle";
        assert!(held.row(fix)["conflict"].is_null());
        held.set(fix, "1");
        assert!(
            held.row(fix)["conflict"].is_null(),
            "one side alone is not a clash"
        );
        held.set(idle, "0");
        assert_eq!(held.row(fix)["conflict"]["other"], idle);
        // And on the half that does not carry the declaration.
        assert_eq!(held.row(idle)["conflict"]["other"], fix);
        held.set(idle, "-1");
        assert!(held.row(fix)["conflict"].is_null());
    }

    #[test]
    fn a_cross_file_gate_resolves_its_controller_in_the_catalog() {
        let held = Machine::started();
        let row = held.row("fo2tweaks.main.damage_mod");
        let gate = &row["groups"][row["ownGroup"].as_str().expect("a group")]["gate"];
        assert_eq!(gate["controller"], "sfall.Misc.DamageFormula");
        assert_eq!(
            gate["active"] == true,
            held.value_of("sfall.Misc.DamageFormula") == Some("0")
        );
    }

    #[test]
    fn one_click_sets_the_whole_chain_a_gated_setting_waits_on() {
        let mut held = Machine::started();
        let dude = "fo2tweaks.run_speed.dude";
        let set = held.answer("satisfy_gate", &json!({ "id": dude, "group": null }));
        let named: Vec<(&str, &str)> = set
            .as_array()
            .expect("a list")
            .iter()
            .filter_map(|one| Some((one["id"].as_str()?, one["value"].as_str()?)))
            .collect();
        assert_eq!(
            named,
            [
                ("fo2tweaks.main.run_speed", "1"),
                ("sfall.Misc.UseFileSystemOverride", "1")
            ]
        );
        assert_eq!(held.value_of("sfall.Misc.UseFileSystemOverride"), Some("1"));
        assert!(gate_active(&held, dude));
    }

    #[test]
    fn offers_nothing_where_the_gate_names_no_one_value_to_write() {
        let held = Machine::started();
        let row = held.row("sfall.Input.FastMoveFromContainer");
        let address = &row["groups"][row["ownGroup"].as_str().expect("a group")];
        assert_eq!(address["gate"]["active"], false);
        assert!(address["requirements"].is_null());
    }

    #[test]
    fn an_installed_mods_schema_loads_with_its_values_read_from_its_own_ini() {
        let held = Machine::started();
        let groups = held.reading()["modSettings"].as_array().expect("a list");
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0]["name"], "FO2tweaks");
        assert_eq!(groups[0]["files"], json!(["mods/fo2tweaks.ini"]));
        assert_eq!(held.value_of("fo2tweaks.main.autodoors"), Some("1"));
        assert_eq!(held.value_of("fo2tweaks.main.max_knockback"), Some("-1"));
    }

    #[test]
    fn a_mod_setting_saves_through_the_lossless_path() {
        let mut held = Machine::started();
        held.set("fo2tweaks.main.autodoors", "2");
        assert_eq!(held.reading()["modSettingsChanged"], true);
        held.save();
        let written = held.read(MOD_INI);
        assert!(written.contains("autodoors=2"));
        assert!(
            written.contains("; Automatically open/walk through unlocked doors when not in combat")
        );
        assert!(!held.modified("fo2tweaks.main.autodoors"));
        assert_eq!(held.value_of("fo2tweaks.main.autodoors"), Some("2"));
    }
}

mod saving {
    use super::*;

    fn flipped(held: &Machine) -> &'static str {
        if held.value_of(MUSIC) == Some("1") {
            "0"
        } else {
            "1"
        }
    }

    #[test]
    fn writes_the_pending_edits_to_the_installs_own_files_and_clears_them() {
        let mut held = Machine::started();
        let wanted = flipped(&held);
        held.set(MUSIC, wanted);
        assert!(held.modified(MUSIC));
        assert_eq!(held.save(), Value::Null);
        assert!(!held.modified(MUSIC));
        held.start();
        assert_eq!(held.value_of(MUSIC), Some(wanted));
    }

    #[test]
    fn leaves_every_other_line_of_the_file_exactly_as_it_was() {
        let mut held = Machine::started();
        let wanted = flipped(&held);
        held.set(MUSIC, wanted);
        held.save();
        let written = held.read(&install_file("fallout2.cfg"));
        let changed: Vec<&str> = written
            .split('\n')
            .zip(FALLOUT2_CFG.split('\n'))
            .filter(|(now, was)| now != was)
            .map(|(now, _)| now)
            .collect();
        assert_eq!(changed.len(), 1, "{changed:?}");
        assert!(changed[0].starts_with("music="));
    }

    #[test]
    fn refuses_and_writes_nothing_when_the_file_changed_underneath() {
        let mut held = Machine::started();
        held.set(MUSIC, flipped(&held));
        held.write(
            &install_file("fallout2.cfg"),
            &format!("{FALLOUT2_CFG}\n; edited elsewhere\n"),
        );
        let refusal = held.save();
        assert!(
            refusal["text"]
                .as_str()
                .is_some_and(|said| said.contains("fallout2.cfg")),
            "{refusal}"
        );
        assert!(
            held.modified(MUSIC),
            "the edit is kept so the user can decide"
        );
        assert!(
            held.read(&install_file("fallout2.cfg"))
                .contains("; edited elsewhere")
        );
    }

    #[test]
    fn the_unsaved_marks_move_with_an_edit_and_do_not_answer_for_each_other() {
        let mut held = Machine::started();
        assert_eq!(held.reading()["settingsChanged"], false);
        held.set(MUSIC, flipped(&held));
        assert_eq!(held.reading()["settingsChanged"], true);
        let game = held.reading()["groups"]
            .as_array()
            .expect("a list")
            .iter()
            .find(|one| one["id"] == "fallout2.cfg")
            .cloned()
            .expect("the game's own group");
        assert_eq!(game["modified"], 1);
        held.act("revert_settings", &json!({ "ids": [MUSIC], "all": false }));
        assert_eq!(held.reading()["settingsChanged"], false);

        held.act(
            "edit_order",
            &json!({ "edit": { "edit": "shift", "name": "hero_appearance", "by": -1 } }),
        );
        assert_eq!(held.reading()["order"]["changed"], true);
        assert_eq!(
            held.reading()["settingsChanged"],
            false,
            "a mod that moved is not a settings edit"
        );
    }
}

mod pins {
    use super::*;

    #[test]
    fn is_written_on_load_rather_than_counted_as_an_unsaved_change() {
        let held = Machine::started();
        assert_eq!(held.value_of(PINNED), Some("0"));
        assert!(!held.modified(PINNED));
        assert_eq!(held.reading()["modifiedCount"], 0);
        assert!(
            held.read(&install_file("f2_res.ini"))
                .contains("UAC_AWARE=0")
        );
    }

    #[test]
    fn is_written_whether_or_not_autosave_is_on() {
        let mut held = Machine::started();
        held.set_autosave(false);
        held.write(&install_file("f2_res.ini"), F2_RES_INI);
        assert!(
            held.read(&install_file("f2_res.ini"))
                .contains("UAC_AWARE=1")
        );
        held.start();
        assert_eq!(held.view["autosave"], false);
        assert!(
            held.read(&install_file("f2_res.ini"))
                .contains("UAC_AWARE=0")
        );
        assert_eq!(held.reading()["modifiedCount"], 0);
    }

    #[test]
    fn queues_nothing_once_its_file_is_gone() {
        let mut held = Machine::started();
        held.preview
            .platform
            .fs()
            .remove(Path::new(&install_file("f2_res.ini")))
            .expect("a removal");
        held.start();
        assert!(
            !held.reading()["files"]
                .as_array()
                .expect("a list")
                .iter()
                .any(|one| one == "f2_res.ini")
        );
        assert!(!held.modified(PINNED));
        assert_eq!(held.reading()["modifiedCount"], 0);
    }
}

mod order {
    use super::*;

    fn shown(held: &Machine) -> Vec<String> {
        held.reading()["order"]["mods"]
            .as_array()
            .expect("a list")
            .iter()
            .map(|one| {
                format!(
                    "{}{}",
                    if one["enabled"] == true { "+" } else { "-" },
                    one["name"].as_str().unwrap_or_default()
                )
            })
            .collect()
    }

    fn edit(held: &mut Machine, edit: &Value) {
        held.act("edit_order", &json!({ "edit": edit }));
    }

    const AS_READ: [&str; 10] = [
        "+weapon_sounds.dat",
        "-extra_music.dat",
        "+hero_appearance",
        "+old_patch.dat",
        "+old_music.dat",
        "+InventoryFilter.dat",
        "+fo2tweaks.dat",
        "+mod_combat_speed.dat",
        "-mod_dialog_fix.dat",
        "-barter_prices.dat",
    ];

    #[test]
    fn lists_what_the_order_file_names_then_what_the_folder_holds_and_it_does_not() {
        let held = Machine::started();
        assert_eq!(shown(&held), AS_READ);
        let kinds: Vec<&str> = held.reading()["order"]["mods"]
            .as_array()
            .expect("a list")
            .iter()
            .filter_map(|one| one["kind"].as_str())
            .collect();
        assert_eq!(
            kinds,
            [
                "dat", "dat", "folder", "missing", "missing", "dat", "dat", "dat", "dat", "dat"
            ]
        );
    }

    #[test]
    fn names_the_mods_loading_against_the_recommendation_and_sorting_puts_just_those_right() {
        let mut held = Machine::started();
        assert_eq!(
            held.reading()["order"]["against"],
            json!(["InventoryFilter.dat", "fo2tweaks.dat"])
        );
        edit(&mut held, &json!({ "edit": "sort" }));
        assert_eq!(held.reading()["order"]["against"], json!([]));
        assert_eq!(held.reading()["order"]["changed"], true);
        held.save();
        assert!(
            held.read(ORDER_FILE)
                .contains("old_music.dat\nfo2tweaks.dat\nInventoryFilter.dat\n")
        );
    }

    #[test]
    fn counts_the_whole_order_as_one_unsaved_change_however_far_a_mod_moves() {
        let mut held = Machine::started();
        edit(
            &mut held,
            &json!({ "edit": "shift", "name": "hero_appearance", "by": -1 }),
        );
        edit(
            &mut held,
            &json!({ "edit": "shift", "name": "hero_appearance", "by": -1 }),
        );
        assert_eq!(shown(&held)[0], "+hero_appearance");
        assert_eq!(held.reading()["modifiedCount"], 1);
    }

    #[test]
    fn comments_a_mod_out_in_place_rather_than_dropping_its_line() {
        let mut held = Machine::started();
        edit(
            &mut held,
            &json!({ "edit": "toggle", "name": "weapon_sounds.dat" }),
        );
        assert_eq!(held.save(), Value::Null);
        assert!(held.read(ORDER_FILE).contains("; weapon_sounds.dat"));
        assert_eq!(shown(&held)[0], "-weapon_sounds.dat");
    }

    #[test]
    fn forgetting_the_missing_drops_every_dead_line_and_nothing_else() {
        let mut held = Machine::started();
        assert_eq!(
            held.reading()["order"]["missing"],
            json!(["old_patch.dat", "old_music.dat"])
        );
        edit(&mut held, &json!({ "edit": "forgetMissing" }));
        held.save();
        let written = held.read(ORDER_FILE);
        assert!(!written.contains("old_patch") && !written.contains("old_music"));
        assert!(written.contains("weapon_sounds.dat\n"));
        assert!(written.contains("; barter_prices.dat\n"));
    }

    #[test]
    fn a_second_save_lands_rather_than_being_refused_as_a_foreign_edit() {
        let mut held = Machine::started();
        edit(
            &mut held,
            &json!({ "edit": "toggle", "name": "extra_music.dat" }),
        );
        held.save();
        assert_eq!(held.reading()["order"]["changed"], false);
        edit(
            &mut held,
            &json!({ "edit": "shift", "name": "extra_music.dat", "by": -1 }),
        );
        assert_eq!(held.save(), Value::Null);
        assert!(
            held.read(ORDER_FILE)
                .contains("above it.\nextra_music.dat\nweapon_sounds.dat")
        );
    }

    #[test]
    fn refuses_and_writes_nothing_when_the_order_changed_underneath() {
        let mut held = Machine::started();
        edit(
            &mut held,
            &json!({ "edit": "toggle", "name": "weapon_sounds.dat" }),
        );
        held.write(ORDER_FILE, "someone_else.dat\n");
        let refusal = held.save();
        assert!(
            refusal["text"]
                .as_str()
                .is_some_and(|said| said.contains("mods/mods_order.txt")),
            "{refusal}"
        );
        assert_eq!(held.read(ORDER_FILE), "someone_else.dat\n");
        assert_eq!(held.reading()["order"]["changed"], true);
    }

    #[test]
    fn reverting_restores_the_order_as_it_was_read() {
        let mut held = Machine::started();
        edit(
            &mut held,
            &json!({ "edit": "toggle", "name": "hero_appearance" }),
        );
        edit(
            &mut held,
            &json!({ "edit": "shift", "name": "hero_appearance", "by": -1 }),
        );
        held.revert_all();
        assert_eq!(shown(&held), AS_READ);
    }

    #[test]
    fn an_order_in_fissions_format_closes_the_tab() {
        let mut held = Machine::started();
        held.act("select_install", &json!({ "path": "fixtures/f2rpu" }));
        assert_eq!(held.reading()["order"]["format"], "fission");
        assert!(
            held.reading()["order"]["closed"]
                .as_str()
                .is_some_and(|said| said.contains("Fission's format"))
        );
    }
}

mod flows {
    use super::*;

    #[test]
    fn nothing_changes_mods_over_unsaved_edits() {
        let mut held = Machine::started();
        held.set("fo2tweaks.main.autodoors", "2");
        for (name, arguments) in [
            ("plan_mod", json!({ "modId": "fo2tweaks" })),
            ("restore_mod", json!({ "modId": "fo2tweaks" })),
            ("remove_mod", json!({ "modId": "fo2tweaks" })),
        ] {
            let said = held.refused(name, &arguments);
            assert!(said.contains("unsaved"), "{name}: {said}");
        }
    }

    #[test]
    fn what_the_preview_cannot_do_is_refused_rather_than_pretended() {
        let held = Machine::started();
        assert!(held.refused("launch", &json!({})).contains("desktop build"));
        assert!(!held.refused("check_sfall", &json!({})).is_empty());
        assert!(
            held.refused(
                "open_mod_file",
                &json!({ "modId": "fo2tweaks", "file": "mods/fo2tweaks.ini" })
            )
            .contains("desktop build")
        );
    }

    #[test]
    fn the_settings_tabs_offer_an_installed_engine_and_refuse_it_until_it_has_written_its_settings()
    {
        let mut held = Machine::started();
        let fission = |held: &Machine| {
            held.reading()["groups"]
                .as_array()
                .expect("a list")
                .iter()
                .find(|one| one["id"] == "fission")
                .cloned()
        };
        let offered = fission(&held).expect("fission is deployed in the fixture");
        assert!(offered["refusal"].is_string(), "{offered}");
        held.write(
            &install_file("fission.cfg"),
            "[enhancements]\nEnhancedBarter=0\n",
        );
        held.start();
        assert!(fission(&held).is_some_and(|one| one["refusal"].is_null()));
        held.act("select_install", &json!({ "path": "fixtures/f2" }));
        assert!(
            fission(&held).is_none(),
            "not on an install that has no Fission"
        );
    }
}

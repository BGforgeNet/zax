//! One install's settings as the interface edits them: the files as read, the edits waiting to be
//! written, and every answer a row needs about a setting.
//!
//! Edits are held as a sparse map of overrides rather than applied to the parsed documents, which keeps
//! "what did I change" and a revert trivial. Everything a row draws is worked out here and handed over
//! whole, so the interface computes no rule of its own and cannot come to disagree with what a save
//! writes.

use std::collections::{BTreeMap, BTreeSet};

use zax_core::action::{Action, WINE_DEBUG_ID, is_applied, pending_targets};
use zax_core::catalog::{
    SettingDef, SettingKind, SettingTarget, Targets, ValueTest, describe_value_test, display_value,
    matches_value_test, scale_to_percent, sentinel_label, value_label, value_satisfying,
};
use zax_core::config_io::{ConfigChange, ConfigFileContents};
use zax_core::ini::IniDocument;
use zax_core::text::latin1;
use zax_core::validate::validate;

use crate::actions::actions;
use crate::backend::ModSettingsGroup;
use crate::catalog::{setting, settings};
use crate::engine_config::{live_targets_among, minted_engines};
use crate::engines::ENGINES;
use crate::files::CONFIG_FILES;
use crate::layout::{group_for, layout};
use crate::reconcile_settings::{Divergence, HeldTarget, reconcile_settings};
use crate::records::InstalledEngine;

/// The values on disk and every key the files hold, for one reading of one install's files.
#[derive(Debug, Clone, Default, PartialEq)]
struct Indexed {
    /// Keys the files hold that the catalog does not describe, as settings of their own.
    discovered: Vec<SettingDef>,
    /// A catalog or mod setting's value at its own address.
    baseline: BTreeMap<String, Option<String>>,
    /// The same for a discovered key.
    raw_baseline: BTreeMap<String, Option<String>>,
}

impl Indexed {
    fn baseline_of(&self, id: &str) -> Option<&str> {
        self.baseline
            .get(id)
            .or_else(|| self.raw_baseline.get(id))
            .and_then(Option::as_deref)
    }
}

fn document(contents: &ConfigFileContents, file: &str) -> IniDocument {
    IniDocument::parse(contents.get(file).and_then(Option::as_deref).unwrap_or(b""))
}

/// Whether a raw value reads as a whole number, which is what makes a discovered key a number box
/// rather than a text field.
fn integral(value: &str) -> bool {
    let digits = value.strip_prefix('-').unwrap_or(value);
    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
}

/// Every key the game's own config files actually contain. The catalog curates a few hundred of them;
/// sfall's `ddraw.ini` alone holds more, most documented only by the comment above them, which becomes
/// the help text for free.
///
/// A key a catalog setting writes under any of its addresses is that setting, seen from another file:
/// indexing only the first address would invent a second row for it.
fn discover(contents: &ConfigFileContents) -> Vec<SettingDef> {
    let curated: BTreeMap<String, &SettingDef> = settings()
        .iter()
        .flat_map(|def| {
            def.targets.iter().map(move |at| {
                (
                    format!("{}|{}|{}", at.file, at.section, at.key).to_lowercase(),
                    def,
                )
            })
        })
        .collect();
    let mut out: Vec<SettingDef> = Vec::new();
    for file in CONFIG_FILES {
        for entry in document(contents, file).entries() {
            let key = format!("{file}|{}|{}", entry.section, entry.key).to_lowercase();
            if let Some(def) = curated.get(&key) {
                // Once per setting rather than once per address it was found under.
                if !out.iter().any(|seen| seen.id == def.id) {
                    out.push((*def).clone());
                }
                continue;
            }
            out.push(SettingDef {
                id: format!("raw.{file}.{}.{}", entry.section, entry.key).to_lowercase(),
                targets: Targets::new(SettingTarget {
                    file: (*file).to_owned(),
                    section: entry.section.clone(),
                    key: entry.key.clone(),
                    engine: None,
                    gated_by: None,
                }),
                kind: if integral(&entry.value) {
                    SettingKind::Int(zax_core::catalog::NumericKind::default())
                } else {
                    SettingKind::Text { path: false }
                },
                label: entry.key.clone(),
                help: entry.comment.clone(),
                conflicts_with: None,
                managed: None,
            });
        }
    }
    out
}

fn index_for(contents: &ConfigFileContents, mod_defs: &[&SettingDef]) -> Indexed {
    let mut documents: BTreeMap<String, IniDocument> = BTreeMap::new();
    let mut value_of = |def: &SettingDef| {
        let at = def.targets.own();
        documents
            .entry(at.file.clone())
            .or_insert_with(|| document(contents, &at.file))
            .get(&at.section, &at.key)
            .map(latin1)
    };
    // Read at the setting's own address. Reconciling a linked setting's addresses against each other
    // needs the record of what ZAX last wrote, which no file here carries.
    let baseline = settings()
        .iter()
        .chain(mod_defs.iter().copied())
        .map(|def| (def.id.clone(), value_of(def)))
        .collect();
    let discovered = discover(contents);
    let raw_baseline = discovered
        .iter()
        .map(|def| (def.id.clone(), value_of(def)))
        .collect();
    Indexed {
        discovered,
        baseline,
        raw_baseline,
    }
}

/// Values ZAX pins regardless of what the file says, which the file does not already carry.
///
/// Not for a file the install does not have: a pending change there would put the config file of an
/// uninstalled component into the game folder on the next save, the opposite of pinning a value.
fn pins_for(contents: &ConfigFileContents, index: &Indexed) -> BTreeMap<String, String> {
    settings()
        .iter()
        .filter(|def| {
            contents
                .get(&def.targets.own().file)
                .is_some_and(Option::is_some)
        })
        .filter_map(|def| {
            let managed = def.managed.as_ref()?;
            (index.baseline_of(&def.id) != Some(managed.value.as_str()))
                .then(|| (def.id.clone(), managed.value.clone()))
        })
        .collect()
}

/// An answer this reading put in front of the user, and everything undoing it needs to know.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct Reconciled {
    /// The file a carried value came from, which the row names. Absent where the user picked between
    /// two that had both moved: they know where their own answer came from.
    pub from: Option<String>,
    /// Every address weighed, as it then read - the base a revert of the answer accepts.
    pub at: Vec<HeldTarget>,
}

/// What reconciling one reading's linked settings produced.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Linked {
    /// The overrides with every carry folded in.
    pub overrides: BTreeMap<String, String>,
    pub carried: BTreeMap<String, Reconciled>,
    /// The disagreements only the user can settle.
    pub choices: Vec<Divergence>,
    /// Every setting whose addresses disagree, accepted or not - what makes an edit to one count.
    pub split: BTreeSet<String>,
}

/// Weighs each engine's copy of a linked setting against its base, and queues what ZAX can settle.
///
/// A carry is queued rather than written here: it is a value the user set somewhere else, so it is put
/// in front of them as an edit they can undo rather than applied during a load they only meant as one.
#[must_use]
pub fn reconcile_linked(
    contents: &ConfigFileContents,
    overrides: &BTreeMap<String, String>,
    base: &BTreeMap<String, String>,
) -> Linked {
    let found = reconcile_settings(settings(), contents, base);
    let mut out = Linked {
        overrides: overrides.clone(),
        ..Linked::default()
    };
    for one in found {
        out.split.insert(one.id.clone());
        if let Some(settle) = &one.settle {
            out.overrides.insert(one.id.clone(), settle.value.clone());
            out.carried.insert(
                one.id.clone(),
                Reconciled {
                    from: Some(settle.target.file.clone()),
                    at: one.at.clone(),
                },
            );
        }
        if one.choose.is_some() {
            out.choices.push(one);
        }
    }
    out
}

/// A gate as a row states it: whether it holds, what it waits on, and in what words.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct GateView {
    pub active: bool,
    pub controller: String,
    pub controller_label: String,
    /// Where the controller lives, at the address its own row on this tab shows.
    pub controller_file: String,
    /// The values the gate accepts, phrased for a note.
    pub wants: String,
    /// Whether the gate names exactly one value, which is what lets a fix say only "set it".
    pub single: bool,
}

/// One setting that has to change before another takes effect.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct Requirement {
    pub id: String,
    pub label: String,
    pub file: String,
    pub value: String,
    pub value_label: String,
    pub wants: String,
}

/// Another address a row's value is written to, and whether an edit reaches it now.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct LinkedAddress {
    pub at: SettingTarget,
    pub live: bool,
}

/// A row as one group of tabs shows it. A linked setting is a different key, under a different gate,
/// on each component's tab.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct AddressView {
    pub target: SettingTarget,
    /// Whether the install has the file this address is in.
    pub has_file: bool,
    pub gate: Option<GateView>,
    /// Everything the gate waits on, nearest first, or `None` where one of them cannot be set from
    /// here - a pinned value, a missing file, a gate naming no single value, or a cycle.
    pub requirements: Option<Vec<Requirement>>,
    pub linked: Vec<LinkedAddress>,
}

/// A pairing in effect that the engine handles badly.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct ConflictView {
    pub other: String,
    pub other_label: String,
    pub note: String,
}

/// Everything one row draws about one setting.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct RowView {
    /// The value the control shows: the pending edit where there is one, the file's otherwise.
    pub value: Option<String>,
    pub modified: bool,
    /// The key is not in the file at all, so the component uses its own default.
    pub absent: bool,
    pub display: String,
    /// The value as its slider's percentage, for a scale setting.
    #[ts(type = "number | null")]
    pub percent: Option<i64>,
    pub sentinel: Option<String>,
    /// Why the value is not one the component accepts.
    pub invalid: Option<String>,
    pub carried_from: Option<String>,
    pub conflict: Option<ConflictView>,
    /// The group whose address is the setting's own, which is what a row outside any group shows.
    pub own_group: String,
    /// Keyed by group: the setting's own, and every other group holding one of its addresses.
    pub groups: BTreeMap<String, AddressView>,
}

/// A group of settings tabs the install offers, and why its rows take no input where they do not.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct GroupView {
    pub id: String,
    pub refusal: Option<String>,
    /// Unsaved edits to settings with an address on this group's tabs.
    pub modified: usize,
}

/// A one-click fix as its card draws it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct ActionView {
    pub id: String,
    pub applied: bool,
    /// How many of its targets do not yet hold what it writes.
    pub pending: usize,
}

/// One install's settings, as read and as edited since.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SettingsSession {
    pub install_path: String,
    /// Contents of the install's config files exactly as they were read.
    pub contents: ConfigFileContents,
    pub mod_settings: Vec<ModSettingsGroup>,
    index: Indexed,
    pub overrides: BTreeMap<String, String>,
    pub reconciled: BTreeMap<String, Reconciled>,
    pub choices: Vec<Divergence>,
    split: BTreeSet<String>,
    /// What is deployed in the folder, by engine id.
    pub engines: BTreeMap<String, InstalledEngine>,
    /// Which engines have written their own settings into the files held, worked out once per reading.
    minted: BTreeSet<&'static str>,
}

/// Each setting a conflict is declared against, with the setting declaring it - so the half that does
/// not carry the declaration finds its partner without a scan of the catalog per row.
fn declared_against() -> &'static BTreeMap<&'static str, &'static SettingDef> {
    static BUILT: std::sync::OnceLock<BTreeMap<&'static str, &'static SettingDef>> =
        std::sync::OnceLock::new();
    BUILT.get_or_init(|| {
        settings()
            .iter()
            .filter_map(|def| Some((def.conflicts_with.as_ref()?.id.as_str(), def)))
            .collect()
    })
}

/// The value a gate fix writes and what it wants, before it is phrased.
struct GateAt<'a> {
    active: bool,
    controller: &'a SettingDef,
    test: &'a ValueTest,
}

impl SettingsSession {
    /// A reading of files already read. The overrides are whatever this reading queues: pins that did
    /// not take, and carries.
    #[must_use]
    pub fn new(
        install_path: &str,
        contents: ConfigFileContents,
        mod_settings: Vec<ModSettingsGroup>,
        engines: BTreeMap<String, InstalledEngine>,
    ) -> Self {
        let mut out = Self {
            install_path: install_path.to_owned(),
            contents,
            mod_settings,
            engines,
            ..Self::default()
        };
        out.reindex();
        out
    }

    /// Recomputes the values on disk from the contents held.
    fn reindex(&mut self) {
        let defs: Vec<&SettingDef> = self
            .mod_settings
            .iter()
            .flat_map(|group| group.settings.iter().map(|one| &one.def))
            .collect();
        self.index = index_for(&self.contents, &defs);
        self.minted = minted_engines(&self.contents);
    }

    /// The files as read again, keeping the edits and answers already held.
    pub fn reread(&mut self, contents: ConfigFileContents) {
        self.contents = contents;
        self.reindex();
    }

    /// The pins this install does not already carry.
    #[must_use]
    pub fn pins(&self) -> BTreeMap<String, String> {
        pins_for(&self.contents, &self.index)
    }

    /// Folds a reconciliation into the reading.
    pub fn apply_linked(&mut self, linked: Linked) {
        self.overrides = linked.overrides;
        self.reconciled = linked.carried;
        self.choices = linked.choices;
        self.split = linked.split;
    }

    #[must_use]
    pub fn discovered(&self) -> &[SettingDef] {
        &self.index.discovered
    }

    /// A catalog setting, an installed mod's, or a key only this install's files hold.
    #[must_use]
    pub fn def_of(&self, id: &str) -> Option<&SettingDef> {
        setting(id)
            .or_else(|| {
                self.mod_settings
                    .iter()
                    .flat_map(|group| &group.settings)
                    .map(|one| &one.def)
                    .find(|def| def.id == id)
            })
            .or_else(|| self.index.discovered.iter().find(|def| def.id == id))
    }

    #[must_use]
    pub fn baseline_of(&self, id: &str) -> Option<&str> {
        self.index.baseline_of(id)
    }

    #[must_use]
    pub fn value_of(&self, id: &str) -> Option<&str> {
        self.overrides
            .get(id)
            .map(String::as_str)
            .or_else(|| self.baseline_of(id))
    }

    #[must_use]
    pub fn has_file(&self, file: &str) -> bool {
        self.contents.get(file).is_some_and(Option::is_some)
    }

    /// Whether this edit is one. A setting whose addresses disagree always has something to write, even
    /// when the value matches the one address the control shows.
    #[must_use]
    pub fn is_modified(&self, id: &str) -> bool {
        self.overrides.get(id).is_some_and(|value| {
            self.split.contains(id) || Some(value.as_str()) != self.baseline_of(id)
        })
    }

    /// Queues an edit, or drops one that would write nothing.
    pub fn set(&mut self, id: &str, value: &str) {
        if Some(value) == self.baseline_of(id) && !self.split.contains(id) {
            self.overrides.remove(id);
        } else {
            self.overrides.insert(id.to_owned(), value.to_owned());
        }
    }

    /// Drops the edits named, answering the addresses whose base has to move so the revert sticks - a
    /// carry or an answered choice, which the next read would otherwise reach again.
    pub fn revert(&mut self, ids: &[String]) -> Vec<HeldTarget> {
        let mut accepted = Vec::new();
        for id in ids {
            self.overrides.remove(id);
            if let Some(answer) = self.reconciled.get(id) {
                accepted.extend(answer.at.iter().cloned());
            }
        }
        accepted
    }

    /// Drops every edit. Pinned values are ZAX's rather than the user's, so they come back.
    pub fn revert_all(&mut self) -> Vec<HeldTarget> {
        let ids: Vec<String> = self.overrides.keys().cloned().collect();
        let accepted = self.revert(&ids);
        self.overrides = self.pins();
        accepted
    }

    /// Records that those answers were reverted and their bases accepted.
    pub fn forget_answers(&mut self, ids: &[String]) {
        for id in ids {
            self.reconciled.remove(id);
        }
    }

    /// Answers one of the choices: the value picked becomes an ordinary pending edit, and the answer
    /// joins the carries as something a revert accepts rather than merely undoes.
    pub fn choose_linked(&mut self, id: &str, value: &str) {
        let answered = self.choices.iter().position(|one| one.id == id);
        self.set(id, value);
        if let Some(at) = answered {
            let choice = self.choices.remove(at);
            self.reconciled.insert(
                id.to_owned(),
                Reconciled {
                    from: None,
                    at: choice.at,
                },
            );
        }
    }

    /// Writes every target of an action as one edit each.
    pub fn apply_action(&mut self, action: &Action) {
        for (id, want) in &action.targets {
            if Some(want.as_str()) == self.baseline_of(id) {
                self.overrides.remove(id);
            } else {
                self.overrides.insert(id.clone(), want.clone());
            }
        }
    }

    /// The config changes some values amount to: every address of each that is writable here.
    #[must_use]
    pub fn changes_for(&self, values: &BTreeMap<String, String>) -> Vec<ConfigChange> {
        let mut out = Vec::new();
        for (id, value) in values {
            let Some(def) = self.def_of(id) else {
                continue;
            };
            for at in live_targets_among(def, &self.minted) {
                out.push(ConfigChange {
                    file: at.file.clone(),
                    section: at.section.clone(),
                    key: at.key.clone(),
                    value: value.clone(),
                });
            }
        }
        out
    }

    #[must_use]
    pub fn pending_changes(&self) -> Vec<ConfigChange> {
        self.changes_for(&self.overrides)
    }

    /// The address a row on a group's tabs shows, or the setting's own where that group holds none.
    fn target_for<'a>(def: &'a SettingDef, group: Option<&str>) -> &'a SettingTarget {
        group
            .and_then(|group| def.targets.iter().find(|at| group_for(at) == group))
            .unwrap_or_else(|| def.targets.own())
    }

    fn gate_at<'a>(&'a self, def: &'a SettingDef, group: Option<&str>) -> Option<GateAt<'a>> {
        // The gate of the address this row shows: a prerequisite can hold for one engine and not the
        // next.
        let gate = Self::target_for(def, group).gated_by.as_ref()?;
        let controller = self.def_of(&gate.id)?;
        Some(GateAt {
            active: matches_value_test(controller, self.value_of(&controller.id), &gate.test),
            controller,
            test: &gate.test,
        })
    }

    /// Everything `def` waits on, nearest first. Each controller's own gate is followed too, since
    /// setting one that is itself inert writes a value the game goes on ignoring.
    fn requirements_for(&self, def: &SettingDef, group: Option<&str>) -> Option<Vec<Requirement>> {
        let mut out = Vec::new();
        let mut seen = vec![def.id.as_str()];
        let mut current = def;
        loop {
            let Some(gate) = self.gate_at(current, group) else {
                return Some(out);
            };
            if gate.active {
                return Some(out);
            }
            let controller = gate.controller;
            if seen.contains(&controller.id.as_str()) {
                return None;
            }
            seen.push(&controller.id);
            let file = &Self::target_for(controller, group).file;
            if controller.managed.is_some() || !self.has_file(file) {
                return None;
            }
            let value = value_satisfying(controller, gate.test)?;
            out.push(Requirement {
                id: controller.id.clone(),
                label: controller.label.clone(),
                file: file.clone(),
                value_label: value_label(controller, &value),
                value,
                wants: describe_value_test(controller, gate.test),
            });
            current = controller;
        }
    }

    /// Sets everything a gated row waits on, answering what was set so the change can be reported: the
    /// settings changed can sit on another tab, where nothing on screen would show it.
    pub fn satisfy_gate(&mut self, id: &str, group: Option<&str>) -> Vec<Requirement> {
        let Some(def) = self.def_of(id) else {
            return Vec::new();
        };
        let needed = self.requirements_for(def, group).unwrap_or_default();
        for one in &needed {
            self.set(&one.id, &one.value);
        }
        needed
    }

    /// The warning for a bad pairing, read from both halves: whoever flips the half that does not carry
    /// the declaration would otherwise get no warning at all.
    fn conflict_of(&self, def: &SettingDef) -> Option<ConflictView> {
        let clashing = |a: &SettingDef, a_test: &ValueTest, b: &SettingDef, b_test: &ValueTest| {
            matches_value_test(a, self.value_of(&a.id), a_test)
                && matches_value_test(b, self.value_of(&b.id), b_test)
        };
        if let Some(own) = &def.conflicts_with
            && let Some(other) = setting(&own.id)
            && clashing(def, &own.self_test, other, &own.other_test)
        {
            return Some(ConflictView {
                other: other.id.clone(),
                other_label: other.label.clone(),
                note: own.note.clone(),
            });
        }
        let from = *declared_against().get(def.id.as_str())?;
        let back = from.conflicts_with.as_ref()?;
        clashing(from, &back.self_test, def, &back.other_test).then(|| ConflictView {
            other: from.id.clone(),
            other_label: from.label.clone(),
            note: back.note.clone(),
        })
    }

    /// Every other address the value reaches, on the components this install has. An engine that is
    /// installed but has not yet written its settings is named and marked rather than dropped: the link
    /// is real and about to matter.
    fn linked_to(&self, def: &SettingDef, here: &SettingTarget) -> Vec<LinkedAddress> {
        if def.targets.len() < 2 {
            return Vec::new();
        }
        let live = live_targets_among(def, &self.minted);
        def.targets
            .iter()
            .filter(|at| *at != here)
            .filter(|at| {
                at.engine
                    .as_ref()
                    .is_none_or(|engine| self.engines.contains_key(engine))
            })
            .map(|at| LinkedAddress {
                at: at.clone(),
                live: live.contains(&at),
            })
            .collect()
    }

    fn address_view(&self, def: &SettingDef, group: Option<&str>) -> AddressView {
        let target = Self::target_for(def, group);
        let gate = self.gate_at(def, group).map(|gate| GateView {
            active: gate.active,
            controller: gate.controller.id.clone(),
            controller_label: gate.controller.label.clone(),
            controller_file: Self::target_for(gate.controller, group).file.clone(),
            wants: describe_value_test(gate.controller, gate.test),
            single: matches!(gate.test, ValueTest::Is(values) if values.len() == 1),
        });
        AddressView {
            target: target.clone(),
            has_file: self.has_file(&target.file),
            gate,
            requirements: self.requirements_for(def, group),
            linked: self.linked_to(def, target),
        }
    }

    #[must_use]
    pub fn row(&self, def: &SettingDef) -> RowView {
        let value = self.value_of(&def.id).map(ToOwned::to_owned);
        let own_group = group_for(def.targets.own()).to_owned();
        let mut groups = BTreeMap::new();
        groups.insert(own_group.clone(), self.address_view(def, None));
        for at in def.targets.iter() {
            let group = group_for(at);
            if !groups.contains_key(group) {
                groups.insert(group.to_owned(), self.address_view(def, Some(group)));
            }
        }
        RowView {
            modified: self.is_modified(&def.id),
            absent: self.baseline_of(&def.id).is_none(),
            display: display_value(def, value.as_deref()),
            percent: match (&def.kind, value.as_deref()) {
                (SettingKind::Scale { max }, Some(raw)) => Some(scale_to_percent(raw, *max)),
                _ => None,
            },
            sentinel: sentinel_label(def, value.as_deref()),
            invalid: validate(def, value.as_deref())
                .reason()
                .map(ToOwned::to_owned),
            carried_from: self
                .reconciled
                .get(&def.id)
                .and_then(|answer| answer.from.clone()),
            conflict: self.conflict_of(def),
            value,
            own_group,
            groups,
        }
    }

    /// Every row the install has: the catalog's, the installed mods', and the keys only its files hold.
    #[must_use]
    pub fn rows(&self) -> BTreeMap<String, RowView> {
        let mods = self
            .mod_settings
            .iter()
            .flat_map(|group| &group.settings)
            .map(|one| &one.def);
        settings()
            .iter()
            .chain(mods)
            .chain(&self.index.discovered)
            .map(|def| (def.id.clone(), self.row(def)))
            .collect()
    }

    /// The groups of tabs to offer, in the layout's order: the game's own always, an engine's only where
    /// that engine is installed here - refused, with what to do, until it has written its settings.
    #[must_use]
    pub fn groups(&self) -> Vec<GroupView> {
        layout()
            .iter()
            .filter_map(|group| {
                let refusal = match &group.engine {
                    None => None,
                    Some(id) => {
                        let engine = ENGINES.iter().find(|one| one.id == id)?;
                        if !self.engines.contains_key(id.as_str()) {
                            return None;
                        }
                        (!self.minted.contains(engine.id)).then(|| {
                            format!(
                                "Run the game once with {} - it writes these settings itself.",
                                engine.short
                            )
                        })
                    }
                };
                // By the addresses the group shows, so an edit to a shared setting is marked on every
                // tab its row is drawn on.
                let modified = settings()
                    .iter()
                    .filter(|def| {
                        def.targets.iter().any(|at| group_for(at) == group.id)
                            && self.is_modified(&def.id)
                    })
                    .count();
                Some(GroupView {
                    id: group.id.clone(),
                    refusal,
                    modified,
                })
            })
            .collect()
    }

    /// Whether any catalog setting holds an unsaved edit.
    #[must_use]
    pub fn settings_changed(&self) -> bool {
        settings().iter().any(|def| self.is_modified(&def.id))
    }

    /// Whether any installed mod's setting does.
    #[must_use]
    pub fn mod_settings_changed(&self) -> bool {
        self.mod_settings
            .iter()
            .flat_map(|group| &group.settings)
            .any(|one| self.is_modified(&one.def.id))
    }

    /// Every one-click fix, and whether it is already in place. `wine_debug` is the install's own value,
    /// or `None` on a machine with no Wine, where that half must not keep an action unapplied.
    #[must_use]
    pub fn actions(&self, wine_debug: Option<&str>) -> Vec<ActionView> {
        let value_of = |id: &str| self.value_of(id).map(ToOwned::to_owned);
        actions()
            .iter()
            .map(|action| ActionView {
                id: action.id.clone(),
                applied: is_applied(action, value_of, wine_debug),
                pending: pending_targets(action, value_of, wine_debug)
                    .iter()
                    .filter(|one| one.id != WINE_DEBUG_ID || wine_debug.is_some())
                    .count(),
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn contents(pairs: &[(&str, &str)]) -> ConfigFileContents {
        pairs
            .iter()
            .map(|(name, text)| ((*name).to_owned(), Some(text.as_bytes().to_vec())))
            .collect()
    }

    fn session(pairs: &[(&str, &str)]) -> SettingsSession {
        SettingsSession::new("/games/f2", contents(pairs), Vec::new(), BTreeMap::new())
    }

    /// A catalog setting read from the catalog itself, so a renamed id fails here rather than passing
    /// against a copy.
    fn catalog_setting(id: &str) -> &'static SettingDef {
        setting(id).unwrap_or_else(|| panic!("{id} is not in the catalog"))
    }

    #[test]
    fn an_edit_matching_the_file_is_no_edit() {
        let mut held = session(&[("fallout2.cfg", "[preferences]\ncombat_speed=50\n")]);
        let id = "game.preferences.combat_speed";
        catalog_setting(id);
        held.set(id, "40");
        assert!(held.is_modified(id));
        assert_eq!(held.value_of(id), Some("40"));
        held.set(id, "50");
        assert!(!held.is_modified(id));
        assert!(held.overrides.is_empty());
    }

    #[test]
    fn a_key_the_catalog_does_not_describe_is_listed_as_its_own_row() {
        let held = session(&[("ddraw.ini", "[Misc]\n; What it does\nSomethingNew=3\n")]);
        let found = held
            .discovered()
            .iter()
            .find(|def| def.id == "raw.ddraw.ini.misc.somethingnew")
            .expect("the uncatalogued key");
        assert_eq!(found.help.as_deref(), Some("What it does"));
        assert!(matches!(found.kind, SettingKind::Int(_)));
        assert_eq!(held.value_of(&found.id), Some("3"));
    }

    #[test]
    fn a_key_a_linked_setting_also_writes_is_that_setting_rather_than_a_second_row() {
        let linked = settings()
            .iter()
            .find(|def| {
                def.targets.len() > 1
                    && CONFIG_FILES
                        .contains(&def.targets.iter().nth(1).map_or("", |at| at.file.as_str()))
            })
            .expect("a linked setting with a second address in the game's own files");
        let at = linked.targets.iter().nth(1).expect("its second address");
        let held = session(&[(&at.file, &format!("[{}]\n{}=1\n", at.section, at.key))]);
        assert_eq!(
            held.discovered()
                .iter()
                .filter(|def| def.id == linked.id)
                .count(),
            1
        );
        assert!(
            !held
                .discovered()
                .iter()
                .any(|def| def.id.starts_with("raw.")
                    && def.targets.own().key.eq_ignore_ascii_case(&at.key))
        );
    }

    #[test]
    fn a_pin_is_queued_only_for_a_file_the_install_has() {
        let pinned = settings()
            .iter()
            .find(|def| def.managed.is_some())
            .expect("a pinned setting");
        let file = &pinned.targets.own().file;
        let without = session(&[]);
        assert!(without.pins().is_empty());
        let with = session(&[(file, "")]);
        assert_eq!(
            with.pins().get(&pinned.id),
            pinned.managed.as_ref().map(|one| &one.value)
        );
    }

    #[test]
    fn reverting_everything_brings_the_pins_back() {
        let pinned = settings()
            .iter()
            .find(|def| def.managed.is_some())
            .expect("a pinned setting");
        let mut held = session(&[(&pinned.targets.own().file, "")]);
        held.overrides = held.pins();
        held.set("game.preferences.combat_speed", "10");
        held.revert_all();
        assert_eq!(held.overrides, held.pins());
    }

    #[test]
    fn a_row_outside_any_tab_shows_the_settings_own_address() {
        let held = session(&[]);
        let def = catalog_setting("game.preferences.combat_speed");
        let row = held.row(def);
        assert_eq!(row.own_group, "fallout2.cfg");
        assert_eq!(row.groups[&row.own_group].target, *def.targets.own());
        assert!(row.absent);
        assert!(!row.groups[&row.own_group].has_file);
    }

    #[test]
    fn a_gate_names_what_it_waits_on_and_the_fix_sets_the_whole_chain() {
        let gated = settings()
            .iter()
            .find(|def| {
                def.targets.own().gated_by.as_ref().is_some_and(|gate| {
                    setting(&gate.id).is_some_and(|controller| {
                        controller.managed.is_none()
                            && controller.targets.own().gated_by.is_none()
                            && matches!(&gate.test, ValueTest::Is(values) if values.len() == 1)
                    })
                })
            })
            .expect("a setting gated on one value of an ungated controller");
        let gate = gated.targets.own().gated_by.as_ref().expect("its gate");
        let controller = catalog_setting(&gate.id);
        let files: Vec<(&str, &str)> = [gated, controller]
            .iter()
            .map(|def| (def.targets.own().file.as_str(), ""))
            .collect();
        let mut held = session(&files);
        let row = held.row(gated);
        let address = &row.groups[&row.own_group];
        let shown = address.gate.as_ref().expect("the gate");
        assert!(!shown.active);
        assert!(shown.single);
        assert_eq!(shown.controller, controller.id);
        let needed = address.requirements.as_ref().expect("a settable chain");
        assert_eq!(needed.len(), 1);

        let set = held.satisfy_gate(&gated.id, None);
        assert_eq!(set.len(), 1);
        let after = held.row(gated);
        assert!(
            after.groups[&after.own_group]
                .gate
                .as_ref()
                .is_some_and(|gate| gate.active)
        );
    }

    #[test]
    fn a_conflict_warns_on_both_halves_and_only_while_both_are_in_their_states() {
        let declaring = settings()
            .iter()
            .find(|def| def.conflicts_with.is_some())
            .expect("a declared conflict");
        let conflict = declaring.conflicts_with.as_ref().expect("its declaration");
        let other = catalog_setting(&conflict.id);
        let mut held = session(&[
            (&declaring.targets.own().file, ""),
            (&other.targets.own().file, ""),
        ]);
        assert!(held.row(declaring).conflict.is_none());
        let ValueTest::Is(mine) = &conflict.self_test else {
            return;
        };
        let ValueTest::Is(theirs) = &conflict.other_test else {
            return;
        };
        held.set(&declaring.id, &mine[0]);
        assert!(held.row(declaring).conflict.is_none());
        held.set(&other.id, &theirs[0]);
        assert_eq!(
            held.row(declaring).conflict.map(|one| one.other),
            Some(other.id.clone())
        );
        assert_eq!(
            held.row(other).conflict.map(|one| one.other),
            Some(declaring.id.clone())
        );
    }

    #[test]
    fn an_action_counts_what_it_would_change_and_reads_applied_once_it_has() {
        let action = &actions()[0];
        let mut held = session(
            &CONFIG_FILES
                .iter()
                .map(|file| (*file, ""))
                .collect::<Vec<_>>(),
        );
        let before = held
            .actions(None)
            .into_iter()
            .find(|one| one.id == action.id)
            .expect("the action");
        assert!(!before.applied);
        assert_eq!(before.pending, action.targets.len());
        held.apply_action(action);
        let after = held
            .actions(None)
            .into_iter()
            .find(|one| one.id == action.id)
            .expect("the action");
        assert!(after.applied);
        assert_eq!(after.pending, 0);
    }
}

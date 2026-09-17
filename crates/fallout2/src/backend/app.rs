//! What the interface is showing, held on this side of the boundary.
//!
//! The interface draws a view and sends intentions; the state and every rule applied to it live here.
//! Each operation answers the whole view afresh, stamped with a revision, so a slow answer that arrives
//! after a newer one can be told apart and dropped rather than put a state nobody is in back on screen.

use std::collections::BTreeMap;

use zax_core::catalog::SettingDef;
use zax_core::config_io::{SaveOutcome, SaveRequest};
use zax_core::install::{
    GameType, Install, Theme, WineConfig, add_install, remove_install, set_alias, set_wine,
};
use zax_core::state::AppState;
use zax_core::version::compare_versions;
use zax_platform::{Error, Result};

use super::{Backend, EngineListing, MachineDescription, ModSettingsGroup};
use crate::actions::actions;
use crate::engine_install::installed_engines;
use crate::engine_release::{EngineRelease, engine_outdated};
use crate::engines::ENGINES;
use crate::hires::installed_hires_version;
use crate::mod_created::creates_in_place;
use crate::mod_feed::{ModInstallState, ModListing, listing_from};
use crate::mods::{MODS_ORDER_PATH, ModsSaveRequest, read_mods};
use crate::order_session::{OrderSession, OrderView};
use crate::reconcile_settings::{Divergence, HeldTarget};
use crate::records::InstalledEngine;
use crate::settings_session::{
    ActionView, GroupView, Linked, Requirement, RowView, SettingsSession, reconcile_linked,
};
use crate::sfall::{SfallRelease, installed_sfall_version};

/// One whole reading of the selected install and what has been edited since.
#[derive(Debug, Clone)]
struct Reading {
    install: Install,
    settings: SettingsSession,
    order: OrderSession,
    /// The note a carry raised, while any carried value is still standing.
    carry: Option<String>,
    sfall: Option<String>,
    hires: Option<String>,
    /// Where the game stands against the published mods, once the feeds have been read.
    standing: Option<ModInstallState>,
    /// Which reading this is. Rows are only ever sent as changes against a view of the same one.
    generation: u64,
}

/// Everything held between operations.
#[derive(Debug, Default)]
pub(super) struct Held {
    state: AppState,
    selected: String,
    engines: Vec<EngineListing>,
    engine_latest: BTreeMap<String, EngineRelease>,
    sfall_latest: Option<SfallRelease>,
    zax_latest: Option<String>,
    /// The version of the interface that started, which a found release is compared against.
    current_version: String,
    reading: Option<Reading>,
    revision: u64,
    /// How many readings have been taken, which is what numbers the next one.
    readings: u64,
    /// The rows the last view carried, which the next one is sent as changes against.
    sent: Option<SentRows>,
}

/// The rows as of one view.
#[derive(Debug)]
struct SentRows {
    revision: u64,
    generation: u64,
    rows: BTreeMap<String, RowView>,
}

/// The selected install as the interface draws it.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct ReadingView {
    pub path: String,
    /// The config files this install has.
    pub files: Vec<String>,
    /// Where this is set, `rows` holds only the rows that changed since the view of that revision, and
    /// `discovered` and `mod_settings` are absent, having not changed. A caller that does not hold that
    /// view asks for a whole one.
    pub since: Option<u64>,
    /// Keys the files hold that the catalog does not describe.
    pub discovered: Option<Vec<SettingDef>>,
    pub mod_settings: Option<Vec<ModSettingsGroup>>,
    pub rows: BTreeMap<String, RowView>,
    pub groups: Vec<GroupView>,
    pub actions: Vec<ActionView>,
    /// Linked settings whose engines have each moved, so which value survives is the user's call.
    pub choices: Vec<ChoiceView>,
    pub carry: Option<String>,
    /// Unsaved edits, the mod order counting once however much of it moved.
    pub modified_count: usize,
    pub settings_changed: bool,
    pub mod_settings_changed: bool,
    pub order: OrderView,
    pub sfall: Option<String>,
    /// Whether a newer sfall has been found than the one installed.
    pub sfall_outdated: bool,
    pub hires: Option<String>,
    /// What is deployed in the folder, by engine id.
    pub engines: BTreeMap<String, InstalledEngine>,
    /// Whether the deployed build is behind what a check found, by engine id.
    pub engine_outdated: BTreeMap<String, bool>,
    /// The published mods against this install, once the feeds have been read.
    pub mod_listing: Option<ModListing>,
    /// Offers whose install is this installation itself rather than a folder inside it.
    pub creates_in_place: Vec<String>,
}

/// Everything the interface draws, as of one revision.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct AppView {
    /// Higher is newer. An answer carrying a lower one than the view on screen is stale.
    pub revision: u64,
    pub machine: MachineDescription,
    pub installs: Vec<Install>,
    pub theme: Theme,
    pub autosave: bool,
    pub accepted_cautions: Vec<String>,
    /// The selected install's path, or empty with none.
    pub selected: String,
    pub engines: Vec<EngineListing>,
    pub engine_latest: BTreeMap<String, EngineRelease>,
    pub sfall_latest: Option<SfallRelease>,
    pub zax_latest: Option<String>,
    /// Whether the release found is newer than the ZAX that is running.
    pub zax_outdated: bool,
    pub reading: Option<ReadingView>,
}

/// The view, and a sentence about what the operation refused or reported.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct Answered<T> {
    pub view: AppView,
    pub answer: T,
}

impl Backend {
    fn held(&self) -> std::sync::MutexGuard<'_, Held> {
        self.held
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The view, with its rows sent as changes against the last view where that was of this reading.
    /// An edit changes a few rows of several hundred, and the whole set is most of what a view weighs.
    fn view_of(&self, held: &mut Held) -> AppView {
        self.build_view(held, false)
    }

    fn build_view(&self, held: &mut Held, whole: bool) -> AppView {
        held.revision += 1;
        let previous = held.sent.take();
        let mut sent = None;
        let wine = self.platform().os() != zax_platform::OperatingSystem::Windows;
        let reading = held.reading.as_ref().map(|reading| {
            let settings = &reading.settings;
            let order = reading.order.view(reading.install.game_type);
            // `None` on Windows, where the field is hidden and an action must not sit unapplied over
            // something the user cannot reach.
            let own_debug = wine.then(|| {
                reading
                    .install
                    .wine
                    .as_ref()
                    .and_then(|wine| wine.debug.clone())
                    .unwrap_or_default()
            });
            let listing = self
                .feeds_if_read()
                .zip(reading.standing.as_ref())
                .map(|(feeds, standing)| listing_from(&feeds.listing, standing));
            let rows = settings.rows();
            let base = previous
                .as_ref()
                .filter(|one| !whole && one.generation == reading.generation);
            let changed = base.map(|base| {
                rows.iter()
                    .filter(|(id, row)| base.rows.get(*id) != Some(row))
                    .map(|(id, row)| (id.clone(), row.clone()))
                    .collect::<BTreeMap<_, _>>()
            });
            let since = base.map(|base| base.revision);
            sent = Some(SentRows {
                revision: held.revision,
                generation: reading.generation,
                rows: rows.clone(),
            });
            ReadingView {
                since,
                path: reading.install.path.clone(),
                files: settings
                    .contents
                    .iter()
                    .filter(|(_, held)| held.is_some())
                    .map(|(name, _)| name.clone())
                    .collect(),
                discovered: since.is_none().then(|| settings.discovered().to_vec()),
                mod_settings: since.is_none().then(|| settings.mod_settings.clone()),
                rows: changed.unwrap_or(rows),
                groups: settings.groups(),
                actions: settings.actions(own_debug.as_deref()),
                choices: settings
                    .choices
                    .iter()
                    .filter_map(|choice| choice_view(settings, choice))
                    .collect(),
                carry: reading.carry.clone(),
                modified_count: settings.overrides.len() + usize::from(order.changed),
                settings_changed: settings.settings_changed(),
                mod_settings_changed: settings.mod_settings_changed(),
                sfall_outdated: match (&reading.sfall, &held.sfall_latest) {
                    (Some(have), Some(latest)) => {
                        compare_versions(have, &latest.version) == std::cmp::Ordering::Less
                    }
                    _ => false,
                },
                sfall: reading.sfall.clone(),
                hires: reading.hires.clone(),
                engine_outdated: settings
                    .engines
                    .iter()
                    .filter_map(|(id, deployed)| {
                        let latest = held.engine_latest.get(id)?;
                        let engine = ENGINES.iter().find(|one| one.id == id)?;
                        Some((id.clone(), engine_outdated(engine, deployed, latest)))
                    })
                    .collect(),
                engines: settings.engines.clone(),
                mod_listing: listing.clone(),
                creates_in_place: listing
                    .iter()
                    .flat_map(|held| &held.offers)
                    .filter(|offer| {
                        creates_in_place(
                            reading.install.game_type,
                            offer.becomes,
                            offer.creates.is_some(),
                        )
                    })
                    .map(|offer| offer.id.clone())
                    .collect(),
                order,
            }
        });
        held.sent = sent;
        AppView {
            revision: held.revision,
            machine: self.describe(),
            installs: held.state.installs.clone(),
            theme: held.state.theme,
            autosave: held.state.autosave,
            accepted_cautions: held.state.accepted_cautions.clone(),
            selected: held.selected.clone(),
            engines: held.engines.clone(),
            engine_latest: held.engine_latest.clone(),
            sfall_latest: held.sfall_latest.clone(),
            zax_latest: held.zax_latest.clone(),
            zax_outdated: held.zax_latest.as_ref().is_some_and(|latest| {
                compare_versions(&held.current_version, latest) == std::cmp::Ordering::Less
            }),
            reading,
        }
    }

    fn persist(&self, held: &Held) -> Result<()> {
        self.save_state(&held.state)
    }

    /// Writes some values of a reading at once, answering whether the write landed.
    fn write_values(
        &self,
        settings: &SettingsSession,
        values: &BTreeMap<String, String>,
    ) -> Result<SaveOutcome> {
        self.save_config_files(&SaveRequest {
            install_path: settings.install_path.clone().into(),
            original: settings.contents.clone(),
            changes: settings.changes_for(values),
            paths: zax_core::config_io::ConfigFilePaths::new(),
        })
    }

    /// One whole reading of an install: its files with the pins written, its linked settings reconciled,
    /// and everything else the pane draws.
    fn read_install(&self, install: &Install, autosave: bool) -> Result<Reading> {
        let path = install.path.as_str();
        let deployed = installed_engines(self.platform(), install)?
            .into_iter()
            .map(|one| (one.id.clone(), one))
            .collect();
        let mut settings = SettingsSession::new(
            path,
            self.load_config_files(path)?,
            self.installed_mod_settings(path)?,
            deployed,
        );

        // A pin is ZAX's own rather than the user's, so it is written on sight rather than queued behind
        // Save and counted as an unsaved change - whatever autosave says, since that governs edits. A pin
        // that does not take stays queued, visible rather than retried in a loop against a file that will
        // not hold it.
        let wanted = settings.pins();
        let mut overrides = BTreeMap::new();
        if !wanted.is_empty() {
            if matches!(
                self.write_values(&settings, &wanted)?,
                SaveOutcome::Written(_)
            ) {
                settings.reread(self.load_config_files(path)?);
                overrides = settings.pins();
            } else {
                overrides = wanted;
            }
        }

        let mut linked =
            reconcile_linked(&settings.contents, &overrides, &self.settings_base(path)?);
        let mut carry = None;
        let count = linked.carried.len();
        if count > 0 {
            let what = if count == 1 {
                "One setting was".to_owned()
            } else {
                format!("{count} settings were")
            };
            let said =
                format!("{what} changed outside ZAX and carried across to the other engines.");
            // Written rather than queued under autosave: there is no Save to press and no revert drawn,
            // so a queued carry there is an edit nobody can act on - and it blocks every mod flow.
            let written = autosave && self.write_carried(&mut settings, &linked)?;
            if written {
                let kept: BTreeMap<String, String> = linked
                    .overrides
                    .iter()
                    .filter(|(id, _)| !linked.carried.contains_key(*id))
                    .map(|(id, value)| (id.clone(), value.clone()))
                    .collect();
                linked = reconcile_linked(&settings.contents, &kept, &self.settings_base(path)?);
                carry = Some(said);
            } else {
                carry = Some(format!("{said} Save to keep them, or revert."));
            }
        }
        settings.apply_linked(linked);

        let snapshot = read_mods(self.platform(), install)?;
        let standing = match self.feeds_if_read() {
            Some(_) => Some(self.mod_install_state(install)?),
            None => None,
        };
        Ok(Reading {
            install: install.clone(),
            order: OrderSession::new(&snapshot),
            carry,
            sfall: installed_sfall_version(self.platform(), install)?,
            hires: installed_hires_version(self.platform(), install)?,
            standing,
            settings,
            generation: 0,
        })
    }

    /// Writes the values just carried across, answering whether they landed. A refusal leaves them
    /// queued, which is the state the note then describes.
    fn write_carried(&self, settings: &mut SettingsSession, linked: &Linked) -> Result<bool> {
        let values: BTreeMap<String, String> = linked
            .overrides
            .iter()
            .filter(|(id, _)| linked.carried.contains_key(*id))
            .map(|(id, value)| (id.clone(), value.clone()))
            .collect();
        if !matches!(
            self.write_values(settings, &values)?,
            SaveOutcome::Written(_)
        ) {
            return Ok(false);
        }
        settings.reread(self.load_config_files(&settings.install_path)?);
        Ok(true)
    }

    /// Reads the selected install again, or clears the reading where nothing is selected.
    fn reread(&self, held: &mut Held) -> Result<()> {
        let install = held
            .state
            .installs
            .iter()
            .find(|one| one.path == held.selected)
            .cloned();
        held.readings += 1;
        held.reading = match install {
            Some(install) => {
                let mut reading = self.read_install(&install, held.state.autosave)?;
                reading.generation = held.readings;
                Some(reading)
            }
            None => None,
        };
        Ok(())
    }

    fn reading_mut(held: &mut Held) -> Result<&mut Reading> {
        held.reading
            .as_mut()
            .ok_or_else(|| Error::Unsupported("No game is selected.".to_owned()))
    }

    /// The machine's builds, read again. Cheap: the catalog and a directory listing.
    fn reread_engines(&self, held: &mut Held) -> Result<()> {
        held.engines = self.machine_engines()?;
        Ok(())
    }
}

/// What starting up found.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct Started {
    pub view: AppView,
    /// Why the state file could not be read, when it could not be.
    pub problem: Option<String>,
}

/// What a save did not write, and why, where it wrote nothing.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct SaveRefusal {
    pub text: String,
}

// --- the operations the interface calls ------------------------------------------------------

impl Backend {
    /// Reads the state file, the machine's builds, and the first install on the list. `version` is the
    /// running interface's, which a release found later is compared against.
    ///
    /// # Errors
    ///
    /// Fails where the state file is there but cannot be read, or where the install cannot be.
    pub fn start(&self, version: &str) -> Result<Started> {
        let loaded = self.load_state()?;
        let mut held = self.held();
        version.clone_into(&mut held.current_version);
        held.selected = loaded
            .state
            .installs
            .first()
            .map(|one| one.path.clone())
            .unwrap_or_default();
        held.state = loaded.state;
        self.reread_engines(&mut held)?;
        self.reread(&mut held)?;
        Ok(Started {
            view: self.build_view(&mut held, true),
            problem: loaded.problem,
        })
    }

    /// The whole view as it stands, for a caller that changed nothing or holds no view to apply changes
    /// to.
    #[must_use]
    pub fn view(&self) -> AppView {
        self.build_view(&mut self.held(), true)
    }

    /// # Errors
    ///
    /// Fails where the install cannot be read.
    pub fn select_install(&self, path: &str) -> Result<AppView> {
        let mut held = self.held();
        held.selected = path.to_owned();
        self.reread(&mut held)?;
        Ok(self.view_of(&mut held))
    }

    /// Reads the selected install again - what an operation that changed the folder asks for.
    ///
    /// # Errors
    ///
    /// Fails where the install cannot be read.
    pub fn refresh(&self) -> Result<AppView> {
        let mut held = self.held();
        self.reread(&mut held)?;
        Ok(self.view_of(&mut held))
    }

    /// Applies edits in the order given. Several at once because the interface sends what piled up while
    /// the previous answer was on its way: sent one by one, two edits can reach this lock in either order,
    /// and a slider would settle on whichever value arrived last rather than the one it was left at.
    ///
    /// # Errors
    ///
    /// Fails where no install is selected, or a percentage names a setting that is not a scale. Edits
    /// before the refused one stay applied, and the view that comes back says so.
    pub fn set_settings(&self, edits: &[SettingEdit]) -> Result<AppView> {
        let mut held = self.held();
        let settings = &mut Self::reading_mut(&mut held)?.settings;
        for edit in edits {
            let value = match &edit.to {
                SettingValue::Raw(value) => value.clone(),
                SettingValue::Percent(percent) => {
                    let Some(zax_core::catalog::SettingKind::Scale { max }) =
                        settings.def_of(&edit.id).map(|def| &def.kind)
                    else {
                        return Err(Error::Unsupported(format!(
                            "{} is not set as a percentage.",
                            edit.id
                        )));
                    };
                    zax_core::catalog::percent_to_scale(*percent, *max)
                }
            };
            settings.set(&edit.id, &value);
        }
        Ok(self.view_of(&mut held))
    }

    /// Drops the edits named. An answer ZAX carried or the user picked is accepted as well as dropped,
    /// by moving the bases of its addresses, or the next read reaches the same answer again.
    ///
    /// # Errors
    ///
    /// Fails where no install is selected, or where the bases cannot be recorded - the edits are dropped
    /// either way, and the rows keep saying where their value came from, since that is still true.
    pub fn revert_settings(&self, ids: &[String], all: bool) -> Result<AppView> {
        let mut held = self.held();
        let reading = Self::reading_mut(&mut held)?;
        let answered: Vec<String> = if all {
            reading.settings.reconciled.keys().cloned().collect()
        } else {
            ids.iter()
                .filter(|id| reading.settings.reconciled.contains_key(*id))
                .cloned()
                .collect()
        };
        let accepted: Vec<HeldTarget> = if all {
            reading.order.revert();
            reading.settings.revert_all()
        } else {
            reading.settings.revert(ids)
        };
        let path = reading.install.path.clone();
        if !accepted.is_empty() {
            self.accept_settings_base(&path, &accepted).map_err(|err| {
                Error::Unsupported(format!("The revert could not be recorded: {err}"))
            })?;
        }
        let reading = Self::reading_mut(&mut held)?;
        reading.settings.forget_answers(&answered);
        let carries = reading
            .settings
            .reconciled
            .values()
            .any(|one| one.from.is_some());
        if !carries {
            reading.carry = None;
        }
        Ok(self.view_of(&mut held))
    }

    /// # Errors
    ///
    /// Fails where no install is selected or the action is unknown.
    pub fn apply_action(&self, action_id: &str) -> Result<AppView> {
        let Some(action) = actions().iter().find(|one| one.id == action_id) else {
            return Err(Error::Unsupported(format!(
                "No action is called {action_id}."
            )));
        };
        let mut held = self.held();
        let reading = Self::reading_mut(&mut held)?;
        reading.settings.apply_action(action);
        // The install's own record is written straight away where the config targets wait for a save:
        // it lives in the state file, which has no pending layer for an edit to sit in.
        if let Some(wine) = &action.wine
            && self.platform().os() != zax_platform::OperatingSystem::Windows
        {
            let path = reading.install.path.clone();
            let mut next = reading.install.wine.clone().unwrap_or_default();
            next.debug = Some(wine.debug.clone());
            set_wine(&mut held.state.installs, &path, &next);
            self.persist(&held)?;
            if let Some(install) = held
                .state
                .installs
                .iter()
                .find(|one| one.path == path)
                .cloned()
                && let Some(reading) = held.reading.as_mut()
            {
                reading.install = install;
            }
        }
        Ok(self.view_of(&mut held))
    }

    /// Sets everything a gated row waits on, answering what was set.
    ///
    /// # Errors
    ///
    /// Fails where no install is selected.
    pub fn satisfy_gate(
        &self,
        id: &str,
        group: Option<&str>,
    ) -> Result<Answered<Vec<Requirement>>> {
        let mut held = self.held();
        let set = Self::reading_mut(&mut held)?
            .settings
            .satisfy_gate(id, group);
        Ok(Answered {
            view: self.view_of(&mut held),
            answer: set,
        })
    }

    /// # Errors
    ///
    /// Fails where no install is selected.
    pub fn choose_linked(&self, id: &str, value: &str) -> Result<AppView> {
        let mut held = self.held();
        Self::reading_mut(&mut held)?
            .settings
            .choose_linked(id, value);
        Ok(self.view_of(&mut held))
    }

    /// One edit to the mod order.
    ///
    /// # Errors
    ///
    /// Fails where no install is selected.
    pub fn edit_order(&self, edit: &OrderEdit) -> Result<AppView> {
        let mut held = self.held();
        let reading = Self::reading_mut(&mut held)?;
        let game_type = reading.install.game_type;
        let order = &mut reading.order;
        match edit {
            OrderEdit::Toggle { name } => order.toggle(name),
            OrderEdit::Shift { name, by } => order.shift(name, *by),
            OrderEdit::Sort => order.sort(game_type),
            OrderEdit::Forget { name } => order.forget(name),
            OrderEdit::ForgetMissing => order.forget_missing(),
        }
        Ok(self.view_of(&mut held))
    }

    /// Writes the mod order, then the settings. The order goes first and a refusal there stops the save
    /// before anything is written: only this order lets one of the two refusals mean nothing happened.
    ///
    /// # Errors
    ///
    /// Fails where no install is selected, or a file cannot be read or written.
    pub fn save(&self) -> Result<Answered<Option<SaveRefusal>>> {
        let mut held = self.held();
        let reading = Self::reading_mut(&mut held)?;
        let saved_mods = reading.order.changed();
        if saved_mods {
            let written = self.save_mods(&ModsSaveRequest {
                install_path: reading.install.path.clone(),
                original: reading.order.text.clone(),
                mods: reading.order.mods.clone(),
            })?;
            if !matches!(written, SaveOutcome::Written(_)) {
                return Ok(Answered {
                    view: self.view_of(&mut held),
                    answer: Some(SaveRefusal {
                        text: format!(
                            "{MODS_ORDER_PATH} changed on disk since it was read. Nothing was written."
                        ),
                    }),
                });
            }
            // Straight back off disk, so the next save is measured against the file this one wrote.
            let snapshot = read_mods(self.platform(), &reading.install)?;
            reading.order = OrderSession::new(&snapshot);
        }

        let reading = Self::reading_mut(&mut held)?;
        let outcome = self.write_values(&reading.settings, &reading.settings.overrides)?;
        if let SaveOutcome::Stale(changed) = outcome {
            // Rereading would silently drop the edits; the user decides, so the files stay as they are.
            let mods = if saved_mods {
                " The mod order was saved."
            } else {
                ""
            };
            return Ok(Answered {
                view: self.view_of(&mut held),
                answer: Some(SaveRefusal {
                    text: format!(
                        "{} changed on disk since it was read. Nothing was written.{mods}",
                        changed.join(" and ")
                    ),
                }),
            });
        }
        self.reread(&mut held)?;
        Ok(Answered {
            view: self.view_of(&mut held),
            answer: None,
        })
    }

    /// Adds a directory the user pointed at, refusing one that does not hold a game. Answers the
    /// refusal in words, or nothing where the install was added.
    ///
    /// # Errors
    ///
    /// Fails where the state file cannot be written or the install cannot be read.
    pub fn add_install(&self, path: &str) -> Result<Answered<Option<String>>> {
        let mut held = self.held();
        let refusal = self.register_install(&mut held, path)?;
        Ok(Answered {
            view: self.view_of(&mut held),
            answer: refusal,
        })
    }

    fn register_install(&self, held: &mut Held, path: &str) -> Result<Option<String>> {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            return Ok(Some("No folder was given.".to_owned()));
        }
        let Some(game_type) = self.identify_install(trimmed) else {
            return Ok(Some(format!(
                "{trimmed} does not hold a Fallout 2 install."
            )));
        };
        if let Err(reason) = add_install(&mut held.state.installs, Install::new(trimmed, game_type))
        {
            return Ok(Some(reason));
        }
        self.persist(held)?;
        if held.selected.is_empty() {
            held.selected = trimmed.to_owned();
            self.reread(held)?;
        }
        Ok(None)
    }

    /// # Errors
    ///
    /// Fails where the state file cannot be written or the next install cannot be read.
    pub fn remove_install(&self, path: &str) -> Result<AppView> {
        let mut held = self.held();
        remove_install(&mut held.state.installs, path);
        // Dropping the selected install would leave every view bound to something no longer listed.
        if held.selected == path {
            held.selected = held
                .state
                .installs
                .first()
                .map(|one| one.path.clone())
                .unwrap_or_default();
            self.reread(&mut held)?;
        }
        self.persist(&held)?;
        Ok(self.view_of(&mut held))
    }

    /// Renames an install, or restores its type's name when given nothing.
    ///
    /// # Errors
    ///
    /// Fails where the state file cannot be written.
    pub fn set_alias(&self, path: &str, name: &str) -> Result<AppView> {
        let mut held = self.held();
        set_alias(&mut held.state.installs, path, name);
        self.sync_install(&mut held, path);
        self.persist(&held)?;
        Ok(self.view_of(&mut held))
    }

    /// # Errors
    ///
    /// Fails where the state file cannot be written.
    pub fn set_wine(&self, path: &str, wine: &WineConfig) -> Result<AppView> {
        let mut held = self.held();
        set_wine(&mut held.state.installs, path, wine);
        self.sync_install(&mut held, path);
        self.persist(&held)?;
        Ok(self.view_of(&mut held))
    }

    /// Keeps the reading's copy of an install in step with the list's.
    fn sync_install(&self, held: &mut Held, path: &str) {
        let Some(install) = held
            .state
            .installs
            .iter()
            .find(|one| one.path == path)
            .cloned()
        else {
            return;
        };
        if let Some(reading) = held.reading.as_mut().filter(|one| one.install.path == path) {
            reading.install = install;
        }
    }

    /// # Errors
    ///
    /// Fails where the state file cannot be written.
    pub fn set_theme(&self, theme: Theme) -> Result<AppView> {
        let mut held = self.held();
        held.state.theme = theme;
        self.persist(&held)?;
        Ok(self.view_of(&mut held))
    }

    /// # Errors
    ///
    /// Fails where the state file cannot be written.
    pub fn set_autosave(&self, on: bool) -> Result<AppView> {
        let mut held = self.held();
        held.state.autosave = on;
        self.persist(&held)?;
        Ok(self.view_of(&mut held))
    }

    /// Records that an engine's caution was read and need not be raised again.
    ///
    /// # Errors
    ///
    /// Fails where the state file cannot be written.
    pub fn accept_caution(&self, engine_id: &str) -> Result<AppView> {
        let mut held = self.held();
        if !held
            .state
            .accepted_cautions
            .iter()
            .any(|one| one == engine_id)
        {
            held.state.accepted_cautions.push(engine_id.to_owned());
            self.persist(&held)?;
        }
        Ok(self.view_of(&mut held))
    }

    /// Looks for installs in the usual places and adds what it finds, answering how many.
    ///
    /// # Errors
    ///
    /// Fails where the state file cannot be written.
    pub fn scan(&self) -> Result<Answered<usize>> {
        let known = self.held().state.installs.clone();
        let found = self.scan_for_installs(&known);
        let mut held = self.held();
        let count = found.len();
        for one in found {
            // A scan racing an add of the same folder keeps the one already on the list.
            let _ = add_install(&mut held.state.installs, one);
        }
        if count > 0 {
            self.persist(&held)?;
            if held.selected.is_empty()
                && let Some(first) = held.state.installs.first()
            {
                held.selected = first.path.clone();
                self.reread(&mut held)?;
            }
        }
        Ok(Answered {
            view: self.view_of(&mut held),
            answer: count,
        })
    }

    /// What ZAX has published, asked of the network with nothing held while it is asked.
    ///
    /// # Errors
    ///
    /// Fails where the release feed cannot be read.
    pub fn check_zax(&self) -> Result<AppView> {
        let latest = self.latest_zax()?;
        let mut held = self.held();
        held.zax_latest = Some(latest.version);
        Ok(self.view_of(&mut held))
    }

    /// # Errors
    ///
    /// Fails where the release feed cannot be read.
    pub fn check_sfall(&self) -> Result<AppView> {
        let latest = self.latest_sfall()?;
        let mut held = self.held();
        held.sfall_latest = Some(latest);
        Ok(self.view_of(&mut held))
    }

    /// What one engine has published. Leaves what was known alone where the project published nothing.
    ///
    /// # Errors
    ///
    /// Fails where the listing cannot be read.
    pub fn check_engine(&self, engine_id: &str) -> Result<AppView> {
        let newest = self.engine_releases(engine_id)?.into_iter().next();
        let mut held = self.held();
        if let Some(newest) = newest {
            held.engine_latest.insert(engine_id.to_owned(), newest);
        }
        Ok(self.view_of(&mut held))
    }

    /// Both halves of the mod listing from one reading of the feeds: the feeds first, then where the
    /// selected install stands against the releases just read. In that order, or the two halves describe
    /// different sets of releases and a mod published by one and unknown to the other loses its row.
    ///
    /// # Errors
    ///
    /// Fails where the selected install cannot be read.
    pub fn read_mod_listing(&self, refresh: bool) -> Result<AppView> {
        let _ = self.published_mods(refresh);
        let mut held = self.held();
        if let Some(reading) = held.reading.as_mut() {
            reading.standing = Some(self.mod_install_state(&reading.install)?);
        }
        Ok(self.view_of(&mut held))
    }

    /// Installs a confirmed plan, then registers what it created and reads the folder again.
    ///
    /// # Errors
    ///
    /// Fails for every reason the install does.
    pub fn install_mod_and_read(
        &self,
        request: &ModInstallRequest,
    ) -> Result<Answered<InstallReport>> {
        let install = self.refuse_over_edits()?;
        let outcome = self.install_mod(
            &install,
            &request.mod_id,
            &request.fingerprint,
            &request.choices,
            &request.answers,
            request.version.as_deref(),
        )?;
        let mut held = self.held();
        let mut added = None;
        match &outcome {
            super::InstallOutcome::Creates(created) => {
                // Registered through the route Add takes, so what it is comes from reading the directory
                // rather than from what the manifest claimed it would make.
                added = self.register_install(&mut held, &created.created.to_string_lossy())?;
            }
            // A base install makes this a different game, and only the directory knows that.
            super::InstallOutcome::Base(_) => {
                if let Some(game_type) = self.identify_install(&install.path) {
                    retype(&mut held.state.installs, &install.path, game_type);
                    self.persist(&held)?;
                }
            }
            super::InstallOutcome::Stacking(_) => {}
        }
        self.reread(&mut held)?;
        self.refresh_standing(&mut held)?;
        Ok(Answered {
            view: self.view_of(&mut held),
            answer: InstallReport {
                outcome,
                refused_registration: added,
            },
        })
    }

    fn refresh_standing(&self, held: &mut Held) -> Result<()> {
        if self.feeds_if_read().is_none() {
            return Ok(());
        }
        if let Some(reading) = held.reading.as_mut() {
            reading.standing = Some(self.mod_install_state(&reading.install)?);
        }
        Ok(())
    }

    /// The one refusal every mod flow starts with: nothing runs over unsaved edits. Broader than the files
    /// a plan touches, on purpose - a flow rewrites the order file and may merge inis, and "save or revert
    /// first" is a clearer contract than a per-file argument about which edit was safe.
    fn refuse_over_edits(&self) -> Result<Install> {
        let held = self.held();
        let reading = held
            .reading
            .as_ref()
            .ok_or_else(|| Error::Unsupported("No game is selected.".to_owned()))?;
        if !reading.settings.overrides.is_empty() || reading.order.changed() {
            return Err(Error::Unsupported(
                "There are unsaved edits - save or revert them before changing mods.".to_owned(),
            ));
        }
        Ok(reading.install.clone())
    }

    fn selected_install(&self) -> Result<Install> {
        let held = self.held();
        held.reading
            .as_ref()
            .map(|reading| reading.install.clone())
            .ok_or_else(|| Error::Unsupported("No game is selected.".to_owned()))
    }

    /// Removes a mod from the selected install and reads the folder again.
    ///
    /// # Errors
    ///
    /// Fails for every reason the removal does.
    pub fn remove_mod_and_read(&self, mod_id: &str) -> Result<AppView> {
        let install = self.refuse_over_edits()?;
        self.remove_mod(&install, mod_id)?;
        let mut held = self.held();
        self.reread(&mut held)?;
        self.refresh_standing(&mut held)?;
        Ok(self.view_of(&mut held))
    }

    /// Unwinds an unfinished install and reads the folder again.
    ///
    /// # Errors
    ///
    /// Fails for every reason the restore does.
    pub fn restore_mod_and_read(&self, mod_id: &str) -> Result<AppView> {
        let install = self.refuse_over_edits()?;
        self.restore_mod(&install, mod_id)?;
        let mut held = self.held();
        self.reread(&mut held)?;
        self.refresh_standing(&mut held)?;
        Ok(self.view_of(&mut held))
    }

    /// Puts a version of sfall into the selected install and reads it again.
    ///
    /// # Errors
    ///
    /// Fails for every reason the update does.
    pub fn change_sfall(
        &self,
        version: Option<&str>,
    ) -> Result<Answered<crate::sfall::SfallUpdate>> {
        let install = self.selected_install()?;
        let version = match version {
            Some(version) => version.to_owned(),
            None => {
                let latest = self.latest_sfall()?;
                let named = latest.version.clone();
                self.held().sfall_latest = Some(latest);
                named
            }
        };
        let update = self.update_sfall(&install, &version)?;
        let mut held = self.held();
        self.reread(&mut held)?;
        Ok(Answered {
            view: self.view_of(&mut held),
            answer: update,
        })
    }

    /// Downloads a build into the machine's cache, and lists the machine's builds again.
    ///
    /// # Errors
    ///
    /// Fails where the download does.
    pub fn fetch_engine_and_list(
        &self,
        engine_id: &str,
        published: Option<&str>,
    ) -> Result<Answered<EngineRelease>> {
        let release = self.fetch_engine(engine_id, published)?;
        let mut held = self.held();
        self.reread_engines(&mut held)?;
        Ok(Answered {
            view: self.view_of(&mut held),
            answer: release,
        })
    }

    /// # Errors
    ///
    /// Fails where the cached build cannot be removed.
    pub fn forget_engine_and_list(&self, engine_id: &str, published: &str) -> Result<AppView> {
        self.forget_engine(engine_id, published)?;
        let mut held = self.held();
        self.reread_engines(&mut held)?;
        Ok(self.view_of(&mut held))
    }

    /// Puts a build in the selected folder, then reads what is deployed there - and nothing else, since
    /// nothing else in the folder moved.
    ///
    /// # Errors
    ///
    /// Fails where the machine holds no build to put there.
    pub fn use_engine_build_here(
        &self,
        engine_id: &str,
        pick: &crate::engine_choice::BuildPick,
    ) -> Result<AppView> {
        let install = self.selected_install()?;
        self.use_engine_build(&install, engine_id, pick)?;
        self.redeployed(&install)
    }

    fn redeployed(&self, install: &Install) -> Result<AppView> {
        let deployed = installed_engines(self.platform(), install)?;
        let mut held = self.held();
        if let Some(reading) = held
            .reading
            .as_mut()
            .filter(|one| one.install.path == install.path)
        {
            reading.settings.engines = deployed
                .into_iter()
                .map(|one| (one.id.clone(), one))
                .collect();
        }
        Ok(self.view_of(&mut held))
    }

    /// Starts the selected game. Only what is deployed is read again afterwards: a full read takes the
    /// mods, and reading them would race the engine now starting for the order file it is about to read.
    ///
    /// # Errors
    ///
    /// Fails where the machine holds no build to run, or the program cannot be started.
    pub fn launch_selected(
        &self,
        engine_id: Option<&str>,
        pick: Option<&crate::engine_choice::BuildPick>,
    ) -> Result<AppView> {
        let (install, sfall) = {
            let held = self.held();
            let reading = held
                .reading
                .as_ref()
                .ok_or_else(|| Error::Unsupported("No game is selected.".to_owned()))?;
            (reading.install.clone(), reading.sfall.clone())
        };
        self.launch(&install, sfall.as_deref(), engine_id, pick)?;
        if engine_id.is_none() {
            return Ok(self.view());
        }
        self.redeployed(&install)
    }
}

impl Backend {
    /// Plans a mod against the selected install.
    ///
    /// # Errors
    ///
    /// Fails where no install is selected, and for every reason planning does.
    pub fn plan_selected_mod(
        &self,
        mod_id: &str,
        choices: &[String],
        answers: &BTreeMap<String, String>,
        version: Option<&str>,
    ) -> Result<super::InstallPlan> {
        self.plan_mod(
            &self.refuse_over_edits()?,
            mod_id,
            choices,
            answers,
            version,
        )
    }

    /// # Errors
    ///
    /// Fails where no install is selected, or the file is not one of the mod's own.
    pub fn open_selected_mod_file(&self, mod_id: &str, file: &str) -> Result<()> {
        self.open_mod_file(&self.selected_install()?, mod_id, file)
    }

    /// What launching an engine would do to the selected install's mod order.
    ///
    /// # Errors
    ///
    /// Fails where no install is selected, or the order file cannot be read.
    pub fn selected_order_swap(
        &self,
        engine_id: Option<&str>,
    ) -> Result<Option<crate::mods::OrderSwap>> {
        self.order_swap(&self.selected_install()?, engine_id)
    }

    /// # Errors
    ///
    /// Fails where no install is selected, or its saves cannot be listed.
    pub fn selected_saves(&self) -> Result<Vec<String>> {
        self.list_saves(&self.selected_install()?)
    }

    /// # Errors
    ///
    /// Fails where no install is selected, or the archive cannot be written.
    pub fn selected_debug_package(
        &self,
        saves: &[String],
    ) -> Result<crate::debug_package::DebugPackage> {
        self.create_debug_package(&self.selected_install()?, saves)
    }
}

/// A setting whose engines have each moved, as the question about it is asked.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct ChoiceView {
    pub id: String,
    pub label: String,
    /// Each value that moved, with the file it moved in.
    pub options: Vec<ChoiceOptionView>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct ChoiceOptionView {
    pub file: String,
    pub value: String,
    pub label: String,
}

/// A divergence the user has to settle, or nothing where it is not one of those.
fn choice_view(settings: &SettingsSession, choice: &Divergence) -> Option<ChoiceView> {
    let def = settings.def_of(&choice.id)?;
    let moved = choice.choose.as_ref()?;
    Some(ChoiceView {
        id: choice.id.clone(),
        label: def.label.clone(),
        options: moved
            .iter()
            .map(|one| ChoiceOptionView {
                file: one.target.file.clone(),
                value: one.value.clone(),
                label: zax_core::catalog::value_label(def, &one.value),
            })
            .collect(),
    })
}

/// Stores what a directory now is, after something changed it.
fn retype(installs: &mut [Install], path: &str, game_type: GameType) {
    if let Some(install) = installs.iter_mut().find(|one| one.path == path) {
        install.game_type = game_type;
    }
}

/// One edit to a setting: a value as the file holds it, or a scale's value as its slider shows it.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
pub struct SettingEdit {
    pub id: String,
    pub to: SettingValue,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub enum SettingValue {
    Raw(String),
    Percent(f64),
}

/// One edit to a mod order.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(tag = "edit", rename_all = "camelCase")]
pub enum OrderEdit {
    Toggle { name: String },
    Shift { name: String, by: i64 },
    Sort,
    Forget { name: String },
    ForgetMissing,
}

/// A confirmed plan, named by what it was planned from.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct ModInstallRequest {
    pub mod_id: String,
    pub fingerprint: String,
    #[serde(default)]
    pub choices: Vec<String>,
    #[serde(default)]
    pub answers: BTreeMap<String, String>,
    pub version: Option<String>,
}

/// What an install did, and why a game it created could not be listed, where it could not.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct InstallReport {
    pub outcome: super::InstallOutcome,
    pub refused_registration: Option<String>,
}

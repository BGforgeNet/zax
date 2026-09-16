//! Installing, upgrading, restoring and removing stacking mods. Every write is bounded to `mods/`, and
//! every exit is finished, retryable, or restored - never a directory that is neither what it was nor
//! the mod with nothing to say about it.
//!
//! An install runs in five phases, and the list is what recovery is written against: journal, deploy,
//! merge, order, commit. Its durable state is exactly four things - the deployed files,
//! `mods_order.txt`, the install record, and the working directory itself - so a restore that puts the
//! first three back from the fourth is total, and needs no phase marker to know how far the failure got.
//!
//! The working directory under the cache carries everything that recovery needs: the journal, the
//! downloaded archive, and copies of whatever deployment overwrote or removed. It is cleared when an
//! install finishes and kept by failure and cancellation alike, so a retry resumes instead of paying the
//! download again and a restore can put every byte back.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use zax_core::directories::backup_directory;
use zax_core::hash::fnv1a;
use zax_core::ini::IniDocument;
use zax_core::ini_merge::{MergeConflict, merge_ini};
use zax_core::install::Install;
use zax_core::stamp::{LocalTime, stamp};
use zax_core::text::latin1;
use zax_platform::archive::{ArchiveEntryInfo, ArchiveEntryKind, ExtractOptions};
use zax_platform::fs::{DirEntry, FileKind};
use zax_platform::{Error, Platform, Result};

use crate::archive_preflight::{is_archiving_clutter, preflight_archive};
use crate::manifest::{ManifestDefaults, ModManifest, ModPart, ModType, may_write, parse_manifest};
use crate::mod_asset::{AssetNaming, ModProgress, fetch_asset};
use crate::mod_feed::{ModRelease, ReleaseAsset, is_archive_name};
use crate::mod_grants::grants_for;
use crate::mod_parts::chosen_parts;
use crate::mod_transaction::{
    ModTransaction, PinnedAsset, mod_work_directory, read_transaction, write_transaction,
};
use crate::mods::{
    MODS_DIRECTORY, MODS_ORDER_PATH, Mod, ModKind, ModsSaveRequest, answers_to_id, list_mods,
    named_in_order, order_dats, read_mods, restore_order, save_mods,
};
use crate::recommended_order::{order_with, place_for, recommendation_for};
use crate::records::{InstallRecord, InstalledMod, assert_usable, load_record, save_record};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedFile {
    /// Relative to the install, under `mods/`.
    pub path: String,
    pub size: u64,
    /// Whether something already sits at the target - what restore would put back.
    pub overwrites: bool,
    /// Which part ships it, for a mod that has them: deployment takes each file from its own payload.
    pub part: Option<String>,
}

/// The resolved plan, shown before anything is written.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModInstallPlan {
    pub files: Vec<PlannedFile>,
    /// The mods-folder entries this install owns, as the manifest spells them - added or re-enabled in
    /// the order file, and recorded so an uninstall can drop the lines a folder entry's paths could
    /// never name.
    pub order_lines: Vec<String>,
    /// The parts this plan installs, by id, empty for a mod without them. What the record keeps.
    pub parts: Option<Vec<String>>,
    /// Recorded files the new release does not ship - an upgrade replaces, never overlays.
    pub removes: Vec<String>,
    /// What this plan resolved to, in one short string. The install re-plans - the directory may have
    /// moved on since the confirmation - and refuses when the answer no longer fingerprints the same,
    /// so what runs is what was agreed to rather than whatever the same button would resolve to now.
    pub fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModInstallOutcome {
    pub version: String,
    pub files: Vec<String>,
    /// Settings both the user and the release changed; the user's won.
    pub conflicts: Vec<MergeConflict>,
}

fn inside_path(root: &Path, relative: &str) -> PathBuf {
    let mut out = root.to_path_buf();
    for segment in relative.split('/') {
        out.push(segment);
    }
    out
}

/// Where deployment sets aside what it overwrote, and what it removed, relative to the working
/// directory.
const OVERWRITTEN: &str = "overwritten";
const REMOVED: &str = "removed";

/// One payload an install deploys: a whole mod, or one chosen part of it. A part is its own asset, its
/// own digest and its own preflight, because that is how a release publishes them.
#[derive(Debug, Clone)]
struct ModPayload {
    /// The part this belongs to, absent for a mod that declares none.
    part: Option<ModPart>,
    asset: ReleaseAsset,
    /// Where a payload that is not an archive lands, or nothing for one that is.
    single: Option<String>,
}

/// Where a payload that is not an archive lands, or nothing for one that is. Cassidy publishes four
/// loose `.dat` assets and the walk-speed and Goris fixes one each, and a single file carries no paths
/// of its own - so the declared entries are the only thing that can say what it installs as, and there
/// must be exactly one.
fn single_file_target(
    asset: &ReleaseAsset,
    entries: Option<&[String]>,
    mod_name: &str,
) -> Result<Option<String>> {
    if is_archive_name(&asset.name) {
        return Ok(None);
    }
    let declared = entries.unwrap_or_default();
    let [only] = declared else {
        return Err(Error::Unsupported(format!(
            "{} is one file rather than an archive, so the {mod_name} manifest has to declare the \
             single \"entries\" name it installs as.",
            asset.name
        )));
    };
    Ok(Some(format!("{MODS_DIRECTORY}/{only}")))
}

/// What this install downloads and deploys: the mod's own payload, or one per selected part.
fn payloads_for(release: &ModRelease, selection: &[String]) -> Result<Vec<ModPayload>> {
    let manifest = &release.manifest;
    if manifest.parts.is_some() {
        let chosen = chosen_parts(release, selection).map_err(Error::Unsupported)?;
        let mut out = Vec::new();
        for part in chosen {
            // Unreachable through `chosen_parts`, which offers only the parts the release published -
            // kept because a caller could hand a release and a selection that were never resolved
            // together.
            let Some(asset) = release.parts.get(&part.id) else {
                return Err(Error::Unsupported(format!(
                    "The {} release publishes no file for {}.",
                    manifest.name, part.label
                )));
            };
            let single = single_file_target(asset, part.entries.as_deref(), &manifest.name)?;
            out.push(ModPayload {
                part: Some(part),
                asset: asset.clone(),
                single,
            });
        }
        return Ok(out);
    }
    let Some(asset) = &release.archive else {
        return Err(Error::Unsupported(format!(
            "The {} release does not say which of its files is the mod - its manifest needs an \
             \"archive\".",
            manifest.name
        )));
    };
    let single = single_file_target(asset, manifest.entries.as_deref(), &manifest.name)?;
    Ok(vec![ModPayload {
        part: None,
        asset: asset.clone(),
        single,
    }])
}

/// The entries one payload puts in the mods folder: what it declares, or - for a manifest written
/// before the field existed - the top-level dats it ships.
///
/// The derivation cannot see two things the declaration can. A mod whose entry is a folder ships only
/// paths below it (`mods/InventoryFilter.dat/InvenFilter.ini`), which match no top-level dat, so it
/// would install and never be loaded; and `mods/patches/extra.dat` reads either as a folder entry
/// `patches` or as a nested dat, which only the mod knows.
fn entries_for(payload: &ModPayload, manifest: &ModManifest, files: &[PlannedFile]) -> Vec<String> {
    let declared = match &payload.part {
        Some(part) => part.entries.as_deref(),
        None => manifest.entries.as_deref(),
    };
    declared.map_or_else(
        || {
            let paths: Vec<String> = files.iter().map(|file| file.path.clone()).collect();
            order_dats(&paths)
        },
        <[String]>::to_vec,
    )
}

/// Whether the payload actually carries a declared entry - the name itself, or anything under it.
fn ships_entry(files: &[PlannedFile], entry: &str) -> bool {
    let at = format!("{MODS_DIRECTORY}/{entry}").to_lowercase();
    files.iter().any(|file| {
        let path = file.path.to_lowercase();
        path == at || path.starts_with(&format!("{at}/"))
    })
}

/// The plan in one line, hashed. Not a cryptographic digest and not meant as one: it detects a plan
/// that moved between the confirmation and the install, and anything that could forge it could have
/// supplied the plan itself.
fn fingerprint_of(
    release: &ModRelease,
    files: &[PlannedFile],
    order_lines: &[String],
    removes: &[String],
    parts: Option<&[String]>,
) -> String {
    let mut lines: Vec<String> = vec![
        release.manifest.version.clone(),
        release
            .archive
            .as_ref()
            .and_then(|asset| asset.digest.clone())
            .unwrap_or_default(),
    ];
    // The selection, so a plan confirmed for one set of parts cannot install another.
    for id in parts.unwrap_or_default() {
        let digest = release
            .parts
            .get(id)
            .and_then(|asset| asset.digest.clone())
            .unwrap_or_default();
        lines.push(format!("={id}:{digest}"));
    }
    for file in files {
        let how = if file.overwrites { "over" } else { "new" };
        lines.push(format!("{}:{}:{how}", file.path, file.size));
    }
    lines.extend(order_lines.iter().map(|name| format!("+{name}")));
    lines.extend(removes.iter().map(|path| format!("-{path}")));
    fnv1a(&lines.join("\n"))
}

fn file_exists(platform: &dyn Platform, path: &Path) -> Result<bool> {
    Ok(platform.fs().stat(path)?.map(|stat| stat.kind) == Some(FileKind::File))
}

/// One read per directory across a batch of lookups. Held only while nothing is writing, since a
/// mutation would go unseen.
type Listings = HashMap<PathBuf, Option<Vec<DirEntry>>>;

/// A relative path resolved to its on-disk spelling under `root`, or nothing when nothing answers to
/// it. Matched case-insensitively segment by segment, the way the loader and upstream's own checks
/// treat paths, so `MODS/Rpu.DAT` on a case-sensitive filesystem still answers to `mods/rpu.dat` - and
/// the caller gets the real name to copy or delete.
fn real_cased_path(
    platform: &dyn Platform,
    root: &Path,
    relative: &str,
    listings: Option<&mut Listings>,
) -> Option<PathBuf> {
    let mut held = listings;
    let mut at = root.to_path_buf();
    for segment in relative.replace('\\', "/").split('/') {
        let entries = match held.as_deref_mut() {
            Some(cache) => cache
                .entry(at.clone())
                .or_insert_with(|| platform.fs().list(&at).ok())
                .clone(),
            None => platform.fs().list(&at).ok(),
        };
        let found = entries?
            .into_iter()
            .find(|entry| entry.name.to_lowercase() == segment.to_lowercase())?;
        at = at.join(found.name);
    }
    Some(at)
}

/// The clashes the manifest declares, judged against the directory as it is now. Only the ones ZAX
/// cannot see for itself: two payloads landing on one path refuse without a rule, and an overwrite is
/// shown before the install is confirmed. These are the incompatibilities with no file in common.
#[must_use]
pub fn conflict_for(
    platform: &dyn Platform,
    install: &Install,
    release: &ModRelease,
) -> Option<String> {
    let root = Path::new(&install.path);
    for rule in &release.manifest.conflicts {
        let present = rule
            .present
            .iter()
            .all(|path| real_cased_path(platform, root, path, None).is_some());
        let absent = rule
            .absent
            .iter()
            .all(|path| real_cased_path(platform, root, path, None).is_none());
        if present && absent {
            return Some(rule.reason.clone());
        }
    }
    None
}

/// Downloads and verifies the release, then resolves what installing it would do - without writing a
/// byte into the game directory. The archive is fetched into the working directory unless a verified
/// copy is already there, which is what makes a retry resume instead of paying the download again.
///
/// # Errors
///
/// Fails where the record may not be written, where a payload cannot be fetched or read, where two
/// payloads land on one path, or where a declared entry is not in what arrived.
pub fn plan_mod_install(
    platform: &dyn Platform,
    install: &Install,
    release: &ModRelease,
    selection: &[String],
    options: &ModProgress<'_>,
) -> Result<ModInstallPlan> {
    let manifest = &release.manifest;
    // Ahead of the download rather than after it: a record this version may not write is a refusal the
    // user should get before spending a transfer on it.
    assert_usable(&load_record(platform, &install.path)?, &manifest.id)?;
    let payloads = payloads_for(release, selection)?;
    let work = mod_work_directory(platform, install, &manifest.id);
    let granted = grants_for(&manifest.id);

    let mut files: Vec<PlannedFile> = Vec::new();
    let mut order_lines: Vec<String> = Vec::new();
    // One read per directory across every payload; planning writes nothing, so the cache cannot go
    // stale.
    let mut listings = Listings::new();

    for payload in &payloads {
        let asset = &payload.asset;
        let label = match &payload.part {
            Some(part) => format!("{} - {}", manifest.name, part.label),
            None => format!("{} {}", manifest.name, manifest.version),
        };
        let archive_path = fetch_asset(
            platform,
            &work,
            asset,
            AssetNaming {
                mod_name: &manifest.name,
                label: &label,
            },
            options,
        )?;

        let entries: Vec<ArchiveEntryInfo> = match &payload.single {
            // Every archive-shaped step is beside the point for one file: no directory to read, no
            // entry count or unpacked total to bound, and no symlink entry to refuse. The manifest's
            // own declaration says where it lands, which is what an archive's paths would have said.
            Some(single) => {
                let size = match asset.size {
                    Some(size) => size,
                    None => platform
                        .fs()
                        .stat(&archive_path)?
                        .map_or(0, |stat| stat.size),
                };
                vec![ArchiveEntryInfo {
                    name: single.clone(),
                    kind: ArchiveEntryKind::File,
                    size,
                }]
            }
            None => {
                options.step(&format!("Reading {}", asset.name));
                preflight_archive(platform, &archive_path, &asset.name)?
            }
        };

        let mut mine: Vec<PlannedFile> = Vec::new();
        for entry in entries {
            if entry.kind != ArchiveEntryKind::File || !may_write(&entry.name, granted) {
                continue;
            }
            // Dropped rather than deployed: what the archiving machine added is not the mod, and
            // installing it would put the file in the overwrite preview, in the record uninstall
            // deletes from, and in the game folder.
            if is_archiving_clutter(&entry.name) {
                continue;
            }
            let overwrites = real_cased_path(
                platform,
                Path::new(&install.path),
                &entry.name,
                Some(&mut listings),
            )
            .is_some();
            mine.push(PlannedFile {
                path: entry.name,
                size: entry.size,
                overwrites,
                part: payload.part.as_ref().map(|part| part.id.clone()),
            });
        }
        if mine.is_empty() {
            let also = if granted.is_empty() {
                String::new()
            } else {
                format!(" or in {}", granted.join(", "))
            };
            return Err(Error::Unsupported(format!(
                "{} ships nothing under mods/{also} - there is nothing to install.",
                asset.name
            )));
        }

        // Two payloads writing one path is an ambiguity only the mod can settle, and last-writer-wins
        // would resolve it silently - differently on a case-sensitive filesystem than elsewhere.
        for file in &mine {
            let Some(held) = files
                .iter()
                .find(|other| other.path.to_lowercase() == file.path.to_lowercase())
            else {
                continue;
            };
            let other = payloads
                .iter()
                .find(|other| other.part.as_ref().map(|part| &part.id) == held.part.as_ref())
                .map_or("the payload", |other| other.asset.name.as_str());
            return Err(Error::Unsupported(format!(
                "{} and {other} both land on {}, so they cannot be installed together.",
                asset.name, file.path
            )));
        }

        // A declared entry nothing carries would put a line in the order file naming something absent,
        // which the loader skips with a log line nobody reads - so it refuses here, where the cause is
        // still visible.
        let declared = match &payload.part {
            Some(part) => part.entries.as_deref(),
            None => manifest.entries.as_deref(),
        };
        for entry in declared.unwrap_or_default() {
            if !ships_entry(&mine, entry) {
                return Err(Error::Unsupported(format!(
                    "{} does not carry \"{entry}\", which the {} manifest declares.",
                    asset.name, manifest.name
                )));
            }
        }

        order_lines.extend(entries_for(payload, manifest, &mine));
        files.extend(mine);
    }

    let planned: BTreeSet<String> = files.iter().map(|file| file.path.to_lowercase()).collect();
    // What this install replaces comes from the open transaction when there is one. Read from the
    // record instead, a retry would find its own unfinished entry there and conclude it replaces
    // itself - so the files a first attempt already removed would go unlisted, and their order lines
    // would outlive them.
    let open = read_transaction(platform, install, &manifest.id)?;
    let replacing = match open.and_then(|held| held.previous) {
        Some(previous) => Some(previous),
        None => load_record(platform, &install.path)?
            .mods
            .into_iter()
            .find(|held| held.id == manifest.id && held.complete),
    };
    let removes: Vec<String> = replacing
        .map(|held| held.files)
        .unwrap_or_default()
        .into_iter()
        .filter(|path| !planned.contains(&path.to_lowercase()))
        .collect();

    let parts = manifest.parts.as_ref().map(|_| {
        payloads
            .iter()
            .map(|payload| {
                payload
                    .part
                    .as_ref()
                    .map(|part| part.id.clone())
                    .unwrap_or_default()
            })
            .collect::<Vec<String>>()
    });
    Ok(ModInstallPlan {
        fingerprint: fingerprint_of(release, &files, &order_lines, &removes, parts.as_deref()),
        files,
        order_lines,
        removes,
        parts,
    })
}

/// What one pass over the order file changes.
#[derive(Debug, Default)]
struct OrderChanges {
    enable: Vec<String>,
    drop: Vec<String>,
}

/// One pass over the order file: the mod's dats end enabled whatever an older file said, and lines
/// whose dat this change removed go with it. One save rather than two, so the user's file is read,
/// backed up and rewritten once per operation.
fn update_order_lines(
    platform: &dyn Platform,
    install: &Install,
    changes: &OrderChanges,
) -> Result<()> {
    // Spelled the way the loader does, here rather than at each caller: a manifest holds `/` like every
    // other path-shaped field, the order file's own separator is `\`, and `named_in_order` reads its
    // lines back normalized - so a nested entry handed over with the wrong one matches no line, and
    // neither the line it just added nor the one it means to drop would be found.
    let spelled = |names: &[String]| -> Vec<String> {
        names.iter().map(|name| name.replace('/', "\\")).collect()
    };
    let enable = spelled(&changes.enable);
    let drop = spelled(&changes.drop);
    if enable.is_empty() && drop.is_empty() {
        return Ok(());
    }
    let snapshot = read_mods(platform, install)?;
    let held = list_mods(&snapshot);
    let wanted: BTreeSet<String> = enable.iter().map(|name| name.to_lowercase()).collect();
    let gone: BTreeSet<String> = drop.iter().map(|name| name.to_lowercase()).collect();
    let mut mods: Vec<Mod> = held
        .into_iter()
        .filter(|one| !gone.contains(&one.name.to_lowercase()))
        .map(|one| Mod {
            enabled: one.enabled || wanted.contains(&one.name.to_lowercase()),
            ..one
        })
        .collect();
    // What the file itself names, rather than what `list_mods` holds: by now the payload is deployed,
    // so the folder listing carries the new dat too, and a mod the file has never placed would keep the
    // place that listing gave it - the end - however the recommendation reads.
    let named: BTreeSet<String> = named_in_order(snapshot.text.as_deref())
        .into_iter()
        .map(|name| name.to_lowercase())
        .collect();
    // The record is written before the first byte is deployed, so the mod being installed has already
    // stated its own place by the time this runs, alongside every mod that stated one before it.
    let base = recommendation_for(install.game_type);
    let order = order_with(base, &snapshot.claims);
    let order: Vec<&str> = order.iter().map(String::as_str).collect();
    for name in &enable {
        // A line the file already carries stays where the user put it; only a first placement is ZAX's
        // to make.
        if named.contains(&name.to_lowercase()) {
            continue;
        }
        if let Some(listed) = mods
            .iter()
            .position(|one| one.name.to_lowercase() == name.to_lowercase())
        {
            mods.remove(listed);
        }
        let at = place_for(&mods, name, &order);
        mods.insert(
            at,
            Mod {
                name: name.clone(),
                enabled: true,
                kind: ModKind::Dat,
                owner: None,
            },
        );
    }
    let saved = save_mods(
        platform,
        &ModsSaveRequest {
            install_path: install.path.clone(),
            original: snapshot.text,
            mods,
        },
    )?;
    match saved {
        zax_core::config_io::SaveOutcome::Written(_) => Ok(()),
        zax_core::config_io::SaveOutcome::Stale(_) => Err(Error::Unsupported(format!(
            "{MODS_ORDER_PATH} changed underneath - retry to pick up the new file."
        ))),
    }
}

/// Executes a confirmed plan. The record is written marked incomplete before the first byte lands and
/// marked complete as the last act, so a relaunch that finds one knows to offer retry or restore rather
/// than trusting the directory; what the entry replaced waits in the working directory for a restore.
///
/// # Errors
///
/// Fails where the manifest's own conflict rules fire, where the record may not be written, or where
/// any of the five phases cannot complete.
#[expect(
    clippy::too_many_lines,
    reason = "the five phases in the order recovery is written against; splitting them would put the \
              sequence a restore undoes out of one reader's sight"
)]
pub fn apply_mod_install(
    platform: &dyn Platform,
    install: &Install,
    release: &ModRelease,
    plan: &ModInstallPlan,
    options: &ModProgress<'_>,
    now: LocalTime,
) -> Result<ModInstallOutcome> {
    let manifest = &release.manifest;
    if let Some(refusal) = conflict_for(platform, install, release) {
        return Err(Error::Unsupported(refusal));
    }

    let work = mod_work_directory(platform, install, &manifest.id);
    let record = load_record(platform, &install.path)?;
    assert_usable(&record, &manifest.id)?;
    // Resolved here rather than at the deploy, so a release whose payload and manifest disagree about
    // being one file is refused before the transaction opens rather than part way through it.
    let payloads = payloads_for(release, plan.parts.as_deref().unwrap_or_default())?;

    // Phase 1, journal. Opened once and resumed thereafter: everything it holds describes the directory
    // as it was before the first byte landed, and a retry that re-derived it would be recording its own
    // wreckage - the half-deployed files as the originals to restore, its own unfinished entry as what
    // it replaces.
    let journal = match read_transaction(platform, install, &manifest.id)? {
        Some(held) => held,
        None => {
            let snapshot = read_mods(platform, install)?;
            let opened = ModTransaction {
                id: manifest.id.clone(),
                archive: release.archive.as_ref().map(pin),
                // One pin per chosen part, and the selection beside them: a retry finishes these parts
                // from these files rather than whatever a second answer to the dialog would have picked.
                parts: if plan.parts.is_some() {
                    payloads
                        .iter()
                        .map(|payload| {
                            (
                                payload
                                    .part
                                    .as_ref()
                                    .map(|part| part.id.clone())
                                    .unwrap_or_default(),
                                pin(&payload.asset),
                            )
                        })
                        .collect()
                } else {
                    BTreeMap::new()
                },
                selection: plan.parts.clone().unwrap_or_default(),
                manifest_text: release.manifest_text.clone(),
                version: manifest.version.clone(),
                // Only a finished entry is something to go back to. An unfinished one here means an
                // earlier transaction whose working directory is gone, and nothing it replaced is
                // recoverable either.
                previous: record
                    .mods
                    .iter()
                    .find(|held| held.id == manifest.id && held.complete)
                    .cloned(),
                order: snapshot.text.clone(),
                preexisting: plan
                    .files
                    .iter()
                    .filter(|file| file.overwrites)
                    .map(|file| file.path.clone())
                    .collect(),
            };
            write_transaction(platform, install, &opened)?;
            opened
        }
    };
    let previous = journal.previous.clone();
    let upgrading = previous.is_some();

    let pending = InstalledMod {
        id: manifest.id.clone(),
        version: manifest.version.clone(),
        mod_type: Some(manifest.mod_type),
        reason: manifest.reason.clone(),
        complete: false,
        files: plan.files.iter().map(|file| file.path.clone()).collect(),
        // A parts install records the entries its chosen parts resolved to, declared or derived: what
        // an uninstall drops from the order file cannot be re-derived from a selection the release may
        // have moved on from. A mod without parts records what its manifest declared, as it always has.
        entries: if plan.parts.is_some() {
            plan.order_lines.clone()
        } else {
            manifest.entries.clone().unwrap_or_default()
        },
        // Kept when this release has no parts to choose: a mod that folded its parts into one payload
        // has not unmade the choice, and an older ZAX reading this record - or a release that goes back
        // to parts - still needs it. Nothing here reads it while the release has none.
        parts: match &plan.parts {
            Some(parts) => parts.clone(),
            None => previous
                .as_ref()
                .map(|held| held.parts.clone())
                .unwrap_or_default(),
        },
        manifest: release.manifest_text.clone(),
        shipped: BTreeMap::new(),
        carried: BTreeMap::new(),
    };
    save_record(platform, &with_mod(&record, &pending))?;

    // Phase 2, deploy.
    options.step(&format!(
        "Installing {} {}",
        manifest.name, manifest.version
    ));
    let backup = backup_directory(platform).join(stamp(now));
    let held: BTreeSet<String> = journal
        .preexisting
        .iter()
        .map(|path| path.to_lowercase())
        .collect();
    let root = Path::new(&install.path);
    for file in &plan.files {
        // Resolved fresh rather than trusting the plan's `overwrites` - the directory may have moved on
        // since.
        let Some(found) = real_cased_path(platform, root, &file.path, None) else {
            continue;
        };
        // Only what was there before the transaction is worth setting aside, and only once. On a retry
        // what sits here is this transaction's own half-deployed file: copying it would overwrite the
        // real original with the wreckage, and a restore would then put the failed attempt back.
        let kept = inside_path(&work.join(OVERWRITTEN), &file.path);
        if held.contains(&file.path.to_lowercase()) && !file_exists(platform, &kept)? {
            platform.fs().copy(&found, &kept)?;
            // And to the timestamped backup, as anything a save replaces does. The working directory's
            // copy is cleared when the install finishes, so on a first install this is the only one
            // that outlives it - which is what a later uninstall would otherwise have nothing to put
            // back.
            platform
                .fs()
                .copy(&found, &inside_path(&backup, &file.path))?;
        }
        // Replaced means replaced: left in place, a differently-spelled original would sit beside the
        // extracted file on a case-sensitive filesystem, and the loader - which folds case - would see
        // the same mod twice.
        if found != inside_path(root, &file.path) {
            platform.fs().remove(&found)?;
        }
    }
    for path in &plan.removes {
        let Some(found) = real_cased_path(platform, root, path, None) else {
            continue;
        };
        platform
            .fs()
            .copy(&found, &inside_path(&work.join(REMOVED), path))?;
        if upgrading {
            platform.fs().copy(&found, &inside_path(&backup, path))?;
        }
        platform.fs().remove(&found)?;
    }

    for payload in &payloads {
        let archive_path = work.join(&payload.asset.name);
        if let Some(single) = &payload.single {
            platform
                .fs()
                .copy(&archive_path, &inside_path(root, single))?;
            continue;
        }
        // Each payload extracts only its own planned files: an archive asked for another part's paths
        // would be asked for paths it does not carry, which is a question with no useful answer.
        let only: Vec<String> = plan
            .files
            .iter()
            .filter(|file| file.part == payload.part.as_ref().map(|part| part.id.clone()))
            .map(|file| file.path.clone())
            .collect();
        platform
            .archive()
            .extract(&archive_path, root, &ExtractOptions { only })?;
    }

    // Phase 3, merge.
    // State files: what the release shipped is recorded as the next upgrade's merge base, then the
    // user's values are merged into the shipped file - with the previous release's copy as base where a
    // record holds one, and user-wins where none does, exactly as the sfall updater treats ddraw.ini.
    let mut shipped: BTreeMap<String, String> = BTreeMap::new();
    let mut conflicts: Vec<MergeConflict> = Vec::new();
    for file in &plan.files {
        if !file.path.to_lowercase().ends_with(".ini") {
            continue;
        }
        let target = inside_path(root, &file.path);
        if !file_exists(platform, &target)? {
            continue;
        }
        let shipped_bytes = platform.fs().read(&target)?;
        shipped.insert(file.path.clone(), latin1(&shipped_bytes));
        let previous_copy = inside_path(&work.join(OVERWRITTEN), &file.path);
        if !file_exists(platform, &previous_copy)? {
            continue;
        }
        // The journal's entry, not the record's: on a retry the record holds this transaction's own
        // unfinished entry, whose base is empty, and merging against that would drop every default the
        // last release set.
        let base = previous
            .as_ref()
            .and_then(|held| held.shipped.get(&file.path))
            .map(|text| IniDocument::parse(&zax_core::text::latin1_bytes(text)));
        let outcome = merge_ini(
            IniDocument::parse(&shipped_bytes),
            &IniDocument::parse(&platform.fs().read(&previous_copy)?),
            base.as_ref(),
        );
        platform.fs().write(&target, &outcome.document.to_bytes())?;
        conflicts.extend(outcome.conflicts);
    }

    // Phase 4, order. What the previous release ordered and this one no longer does goes with it - read
    // from its own declaration where it made one, since a folder entry names no line the deployed paths
    // could yield.
    let dropped = match previous.as_ref().filter(|held| !held.entries.is_empty()) {
        Some(held) => held
            .entries
            .iter()
            .filter(|name| {
                !plan
                    .order_lines
                    .iter()
                    .any(|kept| kept.to_lowercase() == name.to_lowercase())
            })
            .cloned()
            .collect(),
        None => order_dats(&plan.removes),
    };
    update_order_lines(
        platform,
        install,
        &OrderChanges {
            enable: plan.order_lines.clone(),
            drop: dropped,
        },
    )?;

    // Phase 5, commit. The working directory goes last: until it does, this is still a transaction to
    // unwind.
    let written = load_record(platform, &install.path)?;
    let done = InstalledMod {
        complete: true,
        shipped,
        ..pending.clone()
    };
    save_record(platform, &with_mod(&written, &done))?;
    platform.fs().remove(&work)?;
    Ok(ModInstallOutcome {
        version: manifest.version.clone(),
        files: pending.files,
        conflicts,
    })
}

fn pin(asset: &ReleaseAsset) -> PinnedAsset {
    PinnedAsset {
        name: asset.name.clone(),
        url: asset.url.clone(),
        digest: asset.digest.clone().unwrap_or_default(),
    }
}

/// The record with this mod's entry replaced. The rest is carried, so the entries this version could
/// not read survive an install of something else entirely.
fn with_mod(record: &InstallRecord, held: &InstalledMod) -> InstallRecord {
    let mut mods: Vec<InstalledMod> = record
        .mods
        .iter()
        .filter(|one| one.id != held.id)
        .cloned()
        .collect();
    mods.push(held.clone());
    InstallRecord {
        mods,
        ..record.clone()
    }
}

fn without_mod(record: &InstallRecord, id: &str) -> InstallRecord {
    InstallRecord {
        mods: record
            .mods
            .iter()
            .filter(|one| one.id != id)
            .cloned()
            .collect(),
        ..record.clone()
    }
}

/// Unwinds an install that never finished, from the journal the transaction opened: what deployment
/// overwrote or removed goes back from the working directory's copies, files new with the payload are
/// deleted, the order file returns to the text it held, and so does the record. Every phase is undone
/// whichever one the failure reached - the copies say what deployment did, and the other two are
/// snapshots - so there is no phase marker to consult and no phase this misses. The working directory
/// is cleared last: it is the restore's own source.
///
/// # Errors
///
/// Fails where nothing is waiting to be restored, where the working directory is gone, or where a write
/// fails.
pub fn restore_mod_install(
    platform: &dyn Platform,
    install: &Install,
    id: &str,
    now: LocalTime,
) -> Result<()> {
    let record = load_record(platform, &install.path)?;
    assert_usable(&record, id)?;
    let Some(pending) = record.mods.iter().find(|one| one.id == id) else {
        return Err(Error::Unsupported(format!(
            "Nothing of \"{id}\" is waiting to be restored."
        )));
    };
    if pending.complete {
        return Err(Error::Unsupported(format!(
            "Nothing of \"{id}\" is waiting to be restored."
        )));
    }

    let work = mod_work_directory(platform, install, &pending.id);
    // Without the journal there is nothing to restore from - the copies of whatever was overwritten
    // lived in the same directory. Said plainly rather than half-done: deleting the deployed files
    // without putting the originals back is not a restore, and retrying the install still reaches a
    // finished state from here.
    let Some(journal) = read_transaction(platform, install, id)? else {
        return Err(Error::Unsupported(format!(
            "The working files for \"{id}\" are gone, so there is nothing to restore from - the \
             cache they sat in was cleared. Retry the install instead."
        )));
    };

    let root = Path::new(&install.path);
    let granted = grants_for(id);
    for path in &pending.files {
        if !may_write(path, granted) {
            continue;
        }
        let target = inside_path(root, path);
        let kept = inside_path(&work.join(OVERWRITTEN), path);
        if file_exists(platform, &kept)? {
            platform.fs().copy(&kept, &target)?;
        } else {
            platform.fs().remove(&target)?;
        }
    }
    let removed_root = work.join(REMOVED);
    if platform.fs().stat(&removed_root)?.map(|stat| stat.kind) == Some(FileKind::Dir) {
        for path in list_recursively(platform, &removed_root)? {
            platform.fs().copy(
                &inside_path(&removed_root, &path),
                &inside_path(root, &path),
            )?;
        }
    }

    // After the files, so a refused write leaves a directory already made whole - and loudly. The
    // snapshot rather than a computed order: a dat this install enabled may have been sitting there
    // disabled, and nothing readable off the folder afterwards distinguishes that from one it added.
    restore_order(platform, root, journal.order.as_deref(), now)?;

    let restored = match &journal.previous {
        None => without_mod(&record, id),
        Some(previous) => with_mod(&record, previous),
    };
    save_record(platform, &restored)?;
    platform.fs().remove(&work)
}

fn list_recursively(platform: &dyn Platform, root: &Path) -> Result<Vec<String>> {
    let mut out = Vec::new();
    let mut pending = vec![(root.to_path_buf(), String::new())];
    while let Some((at, prefix)) = pending.pop() {
        for entry in platform.fs().list(&at)? {
            let path = if prefix.is_empty() {
                entry.name.clone()
            } else {
                format!("{prefix}/{}", entry.name)
            };
            if entry.kind == FileKind::Dir {
                pending.push((at.join(&entry.name), path));
            } else {
                out.push(path);
            }
        }
    }
    out.sort();
    Ok(out)
}

/// What the record says about whether a mod may be removed. `None` for the type is "cannot be
/// determined", which is a distinct answer from pluggable and is treated as one.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Permanence {
    mod_type: Option<ModType>,
    name: String,
    reason: Option<String>,
}

/// Read from the record's own validated fields first and the manifest snapshot only for records
/// written before those fields existed.
fn permanence_of(recorded: &InstalledMod) -> Permanence {
    if let Some(mod_type) = recorded.mod_type {
        return Permanence {
            mod_type: Some(mod_type),
            name: recorded.id.clone(),
            reason: recorded.reason.clone(),
        };
    }
    // A snapshot this version cannot read gives no verdict, which the caller refuses on.
    match snapshot_of(recorded) {
        None => Permanence {
            mod_type: None,
            name: recorded.id.clone(),
            reason: None,
        },
        Some(manifest) => Permanence {
            mod_type: Some(manifest.mod_type),
            name: manifest.name,
            reason: manifest.reason,
        },
    }
}

fn snapshot_of(recorded: &InstalledMod) -> Option<ModManifest> {
    parse_manifest(
        recorded.manifest.as_bytes(),
        &ManifestDefaults {
            version: Some(recorded.version.clone()),
            archive: None,
        },
    )
    .ok()
}

/// The directory a recorded mod created, where its manifest snapshot says it created one. A snapshot
/// this version cannot read says nothing either way, and the general sentence is the safe one.
fn created_directory(recorded: &InstalledMod) -> Option<String> {
    snapshot_of(recorded)?
        .creates
        .map(|creates| creates.directory)
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModRemoval {
    /// What was deleted, relative to the install.
    pub files: Vec<String>,
    /// Where the copies went before deletion.
    pub backup: PathBuf,
}

/// Uninstalls a pluggable mod: recorded files - or, recordless, whatever under `mods/` answers to the
/// id - are copied to the timestamped backup, then deleted, their order lines removed, the record
/// dropped. Every deleted path is confined to `mods/`; a record that says otherwise was already dropped
/// at load.
///
/// # Errors
///
/// Fails where the mod's type forbids removal, where the record cannot be read or written, or where
/// nothing of the mod is here.
pub fn uninstall_mod(
    platform: &dyn Platform,
    install: &Install,
    id: &str,
    now: LocalTime,
) -> Result<ModRemoval> {
    let record = load_record(platform, &install.path)?;
    assert_usable(&record, id)?;
    let recorded = record.mods.iter().find(|one| one.id == id).cloned();

    // The one gate every removal surface goes through, so no menu or shortcut can offer what the type
    // forbids. A recordless permanent mod is not covered here - the interface never offers Remove for
    // one it knows, and deleting an unknown folder by name is no more than the convention below could
    // always do.
    if let Some(recorded) = &recorded {
        refuse_removal(recorded)?;
    }

    let root = Path::new(&install.path);
    let files: Vec<String> = match &recorded {
        Some(recorded) => recorded.files.clone(),
        None => {
            // The `mods/<id>.*` convention - exactly the uninstall FO2tweaks' own readme prescribes.
            let directory = root.join(MODS_DIRECTORY);
            let entries =
                if platform.fs().stat(&directory)?.map(|stat| stat.kind) == Some(FileKind::Dir) {
                    platform.fs().list(&directory)?
                } else {
                    Vec::new()
                };
            entries
                .into_iter()
                .filter(|entry| answers_to_id(&entry.name, id))
                .map(|entry| format!("{MODS_DIRECTORY}/{}", entry.name))
                .collect()
        }
    };
    if files.is_empty() {
        return Err(Error::Unsupported(format!(
            "Nothing of \"{id}\" is here to remove."
        )));
    }

    let backup = backup_directory(platform).join(stamp(now));
    let mut deleted: Vec<String> = Vec::new();
    let granted = grants_for(id);
    for path in &files {
        if !may_write(path, granted) {
            continue;
        }
        let target = inside_path(root, path);
        let Some(found) = platform.fs().stat(&target)? else {
            continue;
        };
        if found.kind == FileKind::File {
            platform.fs().copy(&target, &inside_path(&backup, path))?;
        } else {
            for inner in list_recursively(platform, &target)? {
                platform.fs().copy(
                    &inside_path(&target, &inner),
                    &inside_path(&backup, &format!("{path}/{inner}")),
                )?;
            }
        }
        platform.fs().remove(&target)?;
        deleted.push(path.clone());
    }

    // The release's own declaration where the record holds one: a folder mod's deployed paths are all
    // below its entry, so deriving from them removes nothing and the line outlives the files.
    let drop = match recorded.as_ref().filter(|held| !held.entries.is_empty()) {
        Some(held) => held.entries.clone(),
        None => order_dats(&deleted),
    };
    update_order_lines(
        platform,
        install,
        &OrderChanges {
            enable: Vec::new(),
            drop,
        },
    )?;
    save_record(platform, &without_mod(&record, id))?;
    Ok(ModRemoval {
        files: deleted,
        backup,
    })
}

fn refuse_removal(recorded: &InstalledMod) -> Result<()> {
    let verdict = permanence_of(recorded);
    match verdict.mod_type {
        Some(ModType::Permanent) => Err(Error::Unsupported(format!(
            "{} cannot be uninstalled: {}",
            verdict.name,
            verdict.reason.as_deref().unwrap_or("its manifest says so")
        ))),
        // A base mod's own answer, and it needs no declared reason: it replaced the game rather than
        // stacking on it, so there is nothing to take away and leave the install as it was. Upstream
        // says the same thing.
        //
        // Unless it created one instead of transforming this one, where the opposite is true: this
        // install was never touched, and what the mod made is a folder. Read off the recorded manifest,
        // since the type alone cannot tell the two apart and telling a user to reinstall the game would
        // be false.
        Some(ModType::Base) => Err(Error::Unsupported(match created_directory(recorded) {
            None => format!(
                "{} cannot be uninstalled: it replaced this installation rather than adding to it. \
                 Starting from a fresh copy of the game is the way back.",
                verdict.name
            ),
            Some(made) => format!(
                "{} cannot be uninstalled by ZAX: what it installed is a whole game in {made}, \
                 which is a folder to delete by hand.",
                verdict.name
            ),
        })),
        // Closed rather than open: a record that cannot be read is exactly the state where a permanent
        // mod would look removable, and a wrong refusal costs a message while a wrong removal costs the
        // install.
        None => Err(Error::Unsupported(format!(
            "ZAX cannot tell whether \"{}\" may be uninstalled: its record was written by a version \
             this one cannot read. Update ZAX, or remove the mod by hand.",
            recorded.id
        ))),
        Some(ModType::Pluggable) => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use zax_core::install::GameType;
    use zax_platform::memory::{Content, MemoryOptions, MemoryPlatform};

    const ARCHIVE: &str = "ecco.zip";
    const URL: &str = "https://example/ecco.zip";
    const WORK: &str = "/home/tester/.cache/zax/tmp";

    fn now() -> LocalTime {
        LocalTime {
            year: 2024,
            month: 5,
            day: 6,
            hour: 7,
            minute: 8,
            second: 9,
        }
    }

    fn install() -> Install {
        Install::new("/games/f2", GameType::Fallout2)
    }

    fn manifest_text(extra: &str) -> String {
        format!(
            "spec: 1\nid: ecco\nname: EcCo\nversion: 1.0\ngame: fallout2\ntype: pluggable\n\
             archive: {ARCHIVE}\n{extra}"
        )
    }

    /// The digest the release states for the payload the host serves, which `fetch_asset` requires.
    fn digest(platform: &MemoryPlatform, payload: &str) -> String {
        let at = Path::new("/tmp/probe");
        platform
            .fs()
            .write(at, payload.as_bytes())
            .expect("a file the test writes");
        format!("sha256:{}", platform.hash().sha256(at).expect("a digest"))
    }

    fn release_with(platform: &MemoryPlatform, extra: &str, payload: &str) -> ModRelease {
        let text = manifest_text(extra);
        ModRelease {
            manifest: parse_manifest(text.as_bytes(), &ManifestDefaults::default())
                .expect("a manifest the test writes"),
            manifest_text: text,
            archive: Some(ReleaseAsset {
                name: ARCHIVE.to_owned(),
                url: URL.to_owned(),
                digest: Some(digest(platform, payload)),
                size: Some(payload.len() as u64),
            }),
            parts: BTreeMap::new(),
            installer: None,
            installer_route: None,
            line: None,
        }
    }

    /// A host serving one archive at `URL`, holding whatever the game folder is said to hold.
    fn platform(files: &[(&str, &str)], inside: &[(&str, &str)], payload: &str) -> MemoryPlatform {
        MemoryPlatform::new(MemoryOptions {
            files: files
                .iter()
                .map(|(path, text)| ((*path).to_owned(), Content::from(*text)))
                .collect(),
            downloads: BTreeMap::from([(URL.to_owned(), Content::from(payload))]),
            archives: BTreeMap::from([(
                payload.to_owned(),
                inside
                    .iter()
                    .map(|(name, text)| ((*name).to_owned(), Content::from(*text)))
                    .collect(),
            )]),
            ..MemoryOptions::default()
        })
    }

    /// The ordinary case: one archive holding one dat, nothing in the folder yet.
    fn simple() -> (MemoryPlatform, ModRelease) {
        let platform = platform(&[], &[("mods/ecco.dat", "new")], "payload");
        let release = release_with(&platform, "", "payload");
        (platform, release)
    }

    fn planned(platform: &MemoryPlatform, release: &ModRelease) -> ModInstallPlan {
        plan_mod_install(platform, &install(), release, &[], &ModProgress::default())
            .expect("a plan")
    }

    fn installed(platform: &MemoryPlatform, release: &ModRelease) -> ModInstallOutcome {
        let plan = planned(platform, release);
        apply_mod_install(
            platform,
            &install(),
            release,
            &plan,
            &ModProgress::default(),
            now(),
        )
        .expect("an install")
    }

    fn recorded(platform: &MemoryPlatform, id: &str) -> Option<InstalledMod> {
        load_record(platform, "/games/f2")
            .expect("a record")
            .mods
            .into_iter()
            .find(|one| one.id == id)
    }

    #[test]
    fn a_plan_names_what_lands_and_nothing_else() {
        let (platform, release) = simple();
        let plan = planned(&platform, &release);
        assert_eq!(plan.files.len(), 1);
        assert_eq!(plan.files[0].path, "mods/ecco.dat");
        assert!(!plan.files[0].overwrites);
        assert_eq!(plan.order_lines, ["ecco.dat"]);
        assert!(plan.removes.is_empty());
        assert_eq!(plan.parts, None);
    }

    #[test]
    fn what_the_payload_would_overwrite_is_shown_before_the_install() {
        let platform = platform(
            &[("/games/f2/mods/ECCO.DAT", "the user's")],
            &[("mods/ecco.dat", "new")],
            "payload",
        );
        let release = release_with(&platform, "", "payload");
        // Matched the way the loader does, so a differently-spelled original still counts.
        assert!(planned(&platform, &release).files[0].overwrites);
    }

    #[test]
    fn a_payload_carrying_nothing_under_mods_has_nothing_to_install() {
        let platform = platform(&[], &[("readme.txt", "hello")], "payload");
        let release = release_with(&platform, "", "payload");
        let err = plan_mod_install(
            &platform,
            &install(),
            &release,
            &[],
            &ModProgress::default(),
        )
        .expect_err("nothing to install");
        assert!(
            format!("{err}").contains("ships nothing under mods/"),
            "{err}"
        );
    }

    #[test]
    fn what_the_archiving_machine_added_is_not_the_mod() {
        let platform = platform(
            &[],
            &[
                ("mods/ecco.dat", "new"),
                ("mods/__MACOSX/._ecco.dat", "clutter"),
            ],
            "payload",
        );
        let release = release_with(&platform, "", "payload");
        let plan = planned(&platform, &release);
        assert_eq!(plan.files.len(), 1, "{:?}", plan.files);
    }

    #[test]
    fn a_declared_entry_the_payload_does_not_carry_refuses_at_the_plan() {
        // A line naming something absent is one the loader skips with a log nobody reads.
        let platform = platform(&[], &[("mods/ecco.dat", "new")], "payload");
        let release = release_with(&platform, "entries:\n  - missing.dat\n", "payload");
        let err = plan_mod_install(
            &platform,
            &install(),
            &release,
            &[],
            &ModProgress::default(),
        )
        .expect_err("a declared entry nothing carries");
        assert!(
            format!("{err}").contains("does not carry \"missing.dat\""),
            "{err}"
        );
    }

    #[test]
    fn a_plan_that_moved_fingerprints_differently() {
        let (before, release) = simple();
        let first = planned(&before, &release);
        let moved = platform(
            &[("/games/f2/mods/ecco.dat", "the user's")],
            &[("mods/ecco.dat", "new")],
            "payload",
        );
        let second = planned(&moved, &release_with(&moved, "", "payload"));
        assert_ne!(first.fingerprint, second.fingerprint);
    }

    #[test]
    fn the_same_plan_fingerprints_the_same() {
        let (platform, release) = simple();
        assert_eq!(
            planned(&platform, &release).fingerprint,
            planned(&platform, &release).fingerprint
        );
    }

    #[test]
    fn a_manifests_declared_clash_is_judged_against_the_directory_as_it_is() {
        let held = platform(
            &[("/games/f2/mods/rival.dat", "theirs")],
            &[("mods/ecco.dat", "new")],
            "payload",
        );
        let clashing = release_with(
            &held,
            "conflicts:\n  - present: [mods/rival.dat]\n    reason: it clashes with Rival\n",
            "payload",
        );
        assert_eq!(
            conflict_for(&held, &install(), &clashing),
            Some("it clashes with Rival".to_owned())
        );
        let clean = platform(&[], &[("mods/ecco.dat", "new")], "payload");
        let elsewhere = release_with(
            &clean,
            "conflicts:\n  - present: [mods/rival.dat]\n    reason: it clashes with Rival\n",
            "payload",
        );
        assert_eq!(conflict_for(&clean, &install(), &elsewhere), None);
    }

    #[test]
    fn an_install_deploys_records_and_orders_in_one_pass() {
        let (platform, release) = simple();
        let done = installed(&platform, &release);
        assert_eq!(done.version, "1.0");
        assert_eq!(done.files, ["mods/ecco.dat"]);
        assert_eq!(
            platform
                .fs()
                .read(Path::new("/games/f2/mods/ecco.dat"))
                .expect("a read"),
            b"new"
        );
        let held = recorded(&platform, "ecco").expect("a record entry");
        assert!(held.complete);
        assert_eq!(held.version, "1.0");
        let order = platform
            .fs()
            .read(Path::new("/games/f2/mods/mods_order.txt"))
            .expect("a read");
        assert!(
            String::from_utf8_lossy(&order).contains("ecco.dat"),
            "{}",
            String::from_utf8_lossy(&order)
        );
    }

    #[test]
    fn the_working_directory_goes_only_once_the_install_has_finished() {
        let (platform, release) = simple();
        installed(&platform, &release);
        let work = mod_work_directory(&platform, &install(), "ecco");
        assert_eq!(platform.fs().stat(&work).expect("a read"), None);
    }

    #[test]
    fn what_was_overwritten_waits_where_a_restore_can_reach_it() {
        let platform = platform(
            &[("/games/f2/mods/ecco.dat", "the user's")],
            &[("mods/ecco.dat", "new")],
            "payload",
        );
        let release = release_with(&platform, "", "payload");
        // Stopped before the commit, so the working directory is still there to look in.
        let plan = planned(&platform, &release);
        let work = mod_work_directory(&platform, &install(), "ecco");
        apply_mod_install(
            &platform,
            &install(),
            &release,
            &plan,
            &ModProgress::default(),
            now(),
        )
        .expect("an install");
        // The timestamped backup outlives the working directory, which is what a later uninstall
        // would otherwise have nothing to put back.
        let kept = backup_directory(&platform)
            .join(stamp(now()))
            .join("mods")
            .join("ecco.dat");
        assert_eq!(platform.fs().read(&kept).expect("a read"), b"the user's");
        assert_eq!(platform.fs().stat(&work).expect("a read"), None);
    }

    #[test]
    fn an_upgrade_removes_what_the_new_release_no_longer_ships() {
        let first = platform(
            &[],
            &[("mods/ecco.dat", "old"), ("mods/extra.dat", "old extra")],
            "payload",
        );
        installed(&first, &release_with(&first, "", "payload"));
        assert!(
            first
                .fs()
                .stat(Path::new("/games/f2/mods/extra.dat"))
                .expect("a read")
                .is_some()
        );

        // The same folder, and a release that ships only the one file.
        let second = MemoryPlatform::new(MemoryOptions {
            files: BTreeMap::from([
                ("/games/f2/mods/ecco.dat".to_owned(), Content::from("old")),
                (
                    "/games/f2/mods/extra.dat".to_owned(),
                    Content::from("old extra"),
                ),
            ]),
            downloads: BTreeMap::from([(URL.to_owned(), Content::from("second"))]),
            archives: BTreeMap::from([(
                "second".to_owned(),
                BTreeMap::from([("mods/ecco.dat".to_owned(), Content::from("new"))]),
            )]),
            ..MemoryOptions::default()
        });
        // The record the first install wrote, carried over to the second host.
        let record = load_record(&first, "/games/f2").expect("a record");
        save_record(&second, &record).expect("a record");

        let release = release_with(&second, "", "second");
        let plan = planned(&second, &release);
        assert_eq!(plan.removes, ["mods/extra.dat"]);
        apply_mod_install(
            &second,
            &install(),
            &release,
            &plan,
            &ModProgress::default(),
            now(),
        )
        .expect("an upgrade");
        assert_eq!(
            second
                .fs()
                .stat(Path::new("/games/f2/mods/extra.dat"))
                .expect("a read"),
            None,
            "an upgrade replaces rather than overlays"
        );
    }

    #[test]
    fn an_unfinished_install_is_unwound_from_its_own_journal() {
        let platform = platform(
            &[("/games/f2/mods/ecco.dat", "the user's")],
            &[("mods/ecco.dat", "new")],
            "payload",
        );
        let release = release_with(&platform, "", "payload");
        let plan = planned(&platform, &release);
        // The journal and the incomplete record, as the install writes them before deploying.
        let work = mod_work_directory(&platform, &install(), "ecco");
        let record = load_record(&platform, "/games/f2").expect("a record");
        let snapshot = read_mods(&platform, &install()).expect("a reading");
        write_transaction(
            &platform,
            &install(),
            &ModTransaction {
                id: "ecco".to_owned(),
                archive: release.archive.as_ref().map(pin),
                parts: BTreeMap::new(),
                selection: Vec::new(),
                manifest_text: release.manifest_text.clone(),
                version: "1.0".to_owned(),
                previous: None,
                order: snapshot.text.clone(),
                preexisting: vec!["mods/ecco.dat".to_owned()],
            },
        )
        .expect("a journal");
        save_record(
            &platform,
            &with_mod(
                &record,
                &InstalledMod {
                    id: "ecco".to_owned(),
                    version: "1.0".to_owned(),
                    mod_type: Some(ModType::Pluggable),
                    reason: None,
                    complete: false,
                    files: plan.files.iter().map(|file| file.path.clone()).collect(),
                    entries: Vec::new(),
                    parts: Vec::new(),
                    manifest: release.manifest_text.clone(),
                    shipped: BTreeMap::new(),
                    carried: BTreeMap::new(),
                },
            ),
        )
        .expect("a record");
        // What deployment set aside, and the half-deployed file over the user's.
        platform
            .fs()
            .write(
                &work.join(OVERWRITTEN).join("mods").join("ecco.dat"),
                b"the user's",
            )
            .expect("a copy");
        platform
            .fs()
            .write(Path::new("/games/f2/mods/ecco.dat"), b"half written")
            .expect("a write");

        restore_mod_install(&platform, &install(), "ecco", now()).expect("a restore");
        assert_eq!(
            platform
                .fs()
                .read(Path::new("/games/f2/mods/ecco.dat"))
                .expect("a read"),
            b"the user's"
        );
        assert_eq!(recorded(&platform, "ecco"), None);
        assert_eq!(platform.fs().stat(&work).expect("a read"), None);
    }

    #[test]
    fn a_restore_with_no_working_directory_says_so_rather_than_half_doing_it() {
        // Deleting the deployed files without putting the originals back is not a restore.
        let (platform, release) = simple();
        let record = load_record(&platform, "/games/f2").expect("a record");
        save_record(
            &platform,
            &with_mod(
                &record,
                &InstalledMod {
                    id: "ecco".to_owned(),
                    version: "1.0".to_owned(),
                    mod_type: Some(ModType::Pluggable),
                    reason: None,
                    complete: false,
                    files: vec!["mods/ecco.dat".to_owned()],
                    entries: Vec::new(),
                    parts: Vec::new(),
                    manifest: release.manifest_text.clone(),
                    shipped: BTreeMap::new(),
                    carried: BTreeMap::new(),
                },
            ),
        )
        .expect("a record");
        let err = restore_mod_install(&platform, &install(), "ecco", now())
            .expect_err("nothing to restore from");
        assert!(
            format!("{err}").contains("Retry the install instead"),
            "{err}"
        );
    }

    #[test]
    fn a_finished_install_is_not_something_to_restore() {
        let (platform, release) = simple();
        installed(&platform, &release);
        let err =
            restore_mod_install(&platform, &install(), "ecco", now()).expect_err("nothing waiting");
        assert!(format!("{err}").contains("waiting to be restored"), "{err}");
    }

    #[test]
    fn uninstall_deletes_what_the_record_names_and_keeps_a_copy() {
        let (platform, release) = simple();
        installed(&platform, &release);
        let removal = uninstall_mod(&platform, &install(), "ecco", now()).expect("a removal");
        assert_eq!(removal.files, ["mods/ecco.dat"]);
        assert_eq!(
            platform
                .fs()
                .stat(Path::new("/games/f2/mods/ecco.dat"))
                .expect("a read"),
            None
        );
        assert_eq!(
            platform
                .fs()
                .read(&removal.backup.join("mods").join("ecco.dat"))
                .expect("a read"),
            b"new"
        );
        assert_eq!(recorded(&platform, "ecco"), None);
        let order = platform
            .fs()
            .read(Path::new("/games/f2/mods/mods_order.txt"))
            .expect("a read");
        assert!(
            !String::from_utf8_lossy(&order).contains("ecco.dat"),
            "the order line outlived the file: {}",
            String::from_utf8_lossy(&order)
        );
    }

    #[test]
    fn a_recordless_mod_is_removed_by_the_convention_its_own_readme_prescribes() {
        let platform = platform(
            &[
                ("/games/f2/mods/ecco.dat", "by hand"),
                ("/games/f2/mods/other.dat", "somebody else's"),
            ],
            &[],
            "payload",
        );
        let removal = uninstall_mod(&platform, &install(), "ecco", now()).expect("a removal");
        assert_eq!(removal.files, ["mods/ecco.dat"]);
        assert!(
            platform
                .fs()
                .stat(Path::new("/games/f2/mods/other.dat"))
                .expect("a read")
                .is_some()
        );
    }

    #[test]
    fn nothing_of_a_mod_that_is_not_here_is_removed() {
        let (platform, _) = simple();
        let err = uninstall_mod(&platform, &install(), "ecco", now()).expect_err("nothing here");
        assert!(format!("{err}").contains("is here to remove"), "{err}");
    }

    #[test]
    fn a_permanent_mod_is_refused_with_the_reason_its_manifest_gave() {
        let (platform, _) = simple();
        let record = load_record(&platform, "/games/f2").expect("a record");
        save_record(
            &platform,
            &with_mod(
                &record,
                &InstalledMod {
                    id: "ecco".to_owned(),
                    version: "1.0".to_owned(),
                    mod_type: Some(ModType::Permanent),
                    reason: Some("it rewrites the scripts".to_owned()),
                    complete: true,
                    files: vec!["mods/ecco.dat".to_owned()],
                    entries: Vec::new(),
                    parts: Vec::new(),
                    manifest: manifest_text(""),
                    shipped: BTreeMap::new(),
                    carried: BTreeMap::new(),
                },
            ),
        )
        .expect("a record");
        let err = uninstall_mod(&platform, &install(), "ecco", now()).expect_err("refused");
        assert!(
            format!("{err}").contains("it rewrites the scripts"),
            "{err}"
        );
    }

    #[test]
    fn a_base_mod_that_replaced_the_installation_says_where_the_way_back_is() {
        let (platform, _) = simple();
        let record = load_record(&platform, "/games/f2").expect("a record");
        save_record(
            &platform,
            &with_mod(
                &record,
                &InstalledMod {
                    id: "upu".to_owned(),
                    version: "1.0".to_owned(),
                    mod_type: Some(ModType::Base),
                    reason: None,
                    complete: true,
                    files: Vec::new(),
                    entries: Vec::new(),
                    parts: Vec::new(),
                    manifest: "spec: 1\nid: upu\nname: UPU\nversion: 1.0\ngame: fallout2\n\
                               type: base\nbecomes: fallout2upu\n\
                               installer.other.run: upu-install.sh\n"
                        .to_owned(),
                    shipped: BTreeMap::new(),
                    carried: BTreeMap::new(),
                },
            ),
        )
        .expect("a record");
        let err = uninstall_mod(&platform, &install(), "upu", now()).expect_err("refused");
        assert!(format!("{err}").contains("fresh copy of the game"), "{err}");
    }

    #[test]
    fn a_base_mod_that_made_a_folder_names_the_folder_instead() {
        // Telling a user to reinstall the game would be false: this install was never touched.
        let (platform, _) = simple();
        let record = load_record(&platform, "/games/f2").expect("a record");
        save_record(
            &platform,
            &with_mod(
                &record,
                &InstalledMod {
                    id: "fo1in2".to_owned(),
                    version: "1.0".to_owned(),
                    mod_type: Some(ModType::Base),
                    reason: None,
                    complete: true,
                    files: Vec::new(),
                    entries: Vec::new(),
                    parts: Vec::new(),
                    manifest: "spec: 1\nid: fo1in2\nname: Fallout et tu\nversion: 1.0\n\
                               game: fallout2\ntype: base\nbecomes: fo1in2\n\
                               creates.directory: Fallout1in2\n"
                        .to_owned(),
                    shipped: BTreeMap::new(),
                    carried: BTreeMap::new(),
                },
            ),
        )
        .expect("a record");
        let err = uninstall_mod(&platform, &install(), "fo1in2", now()).expect_err("refused");
        assert!(format!("{err}").contains("Fallout1in2"), "{err}");
    }

    #[test]
    fn a_record_this_version_cannot_read_refuses_rather_than_guessing() {
        // A wrong refusal costs a message while a wrong removal costs the install.
        let recorded = InstalledMod {
            id: "ecco".to_owned(),
            version: "1.0".to_owned(),
            mod_type: None,
            reason: None,
            complete: true,
            files: vec!["mods/ecco.dat".to_owned()],
            entries: Vec::new(),
            parts: Vec::new(),
            manifest: "spec: 99\n".to_owned(),
            shipped: BTreeMap::new(),
            carried: BTreeMap::new(),
        };
        let err = refuse_removal(&recorded).expect_err("refused");
        assert!(format!("{err}").contains("cannot tell whether"), "{err}");
    }

    #[test]
    fn a_record_without_a_type_falls_back_to_its_manifest_snapshot() {
        let recorded = InstalledMod {
            id: "ecco".to_owned(),
            version: "1.0".to_owned(),
            mod_type: None,
            reason: None,
            complete: true,
            files: vec!["mods/ecco.dat".to_owned()],
            entries: Vec::new(),
            parts: Vec::new(),
            manifest: manifest_text(""),
            shipped: BTreeMap::new(),
            carried: BTreeMap::new(),
        };
        assert!(refuse_removal(&recorded).is_ok());
    }

    #[test]
    fn a_single_file_payload_needs_the_one_entry_it_installs_as() {
        // A single file carries no paths of its own.
        let asset = ReleaseAsset {
            name: "cassidy_head.dat".to_owned(),
            url: URL.to_owned(),
            digest: None,
            size: None,
        };
        assert!(single_file_target(&asset, None, "Cassidy").is_err());
        assert!(
            single_file_target(&asset, Some(&["a".to_owned(), "b".to_owned()]), "Cassidy").is_err()
        );
        assert_eq!(
            single_file_target(&asset, Some(&["cassidy_head.dat".to_owned()]), "Cassidy")
                .expect("one entry"),
            Some("mods/cassidy_head.dat".to_owned())
        );
        // An archive-shaped asset carries its own paths, so it declares nothing here.
        let zipped = ReleaseAsset {
            name: ARCHIVE.to_owned(),
            ..asset
        };
        assert_eq!(
            single_file_target(&zipped, None, "EcCo").expect("an archive"),
            None
        );
    }

    #[test]
    fn a_path_is_resolved_to_its_on_disk_spelling() {
        let platform = platform(&[("/games/f2/MODS/Ecco.DAT", "held")], &[], "payload");
        assert_eq!(
            real_cased_path(&platform, Path::new("/games/f2"), "mods/ecco.dat", None),
            Some(PathBuf::from("/games/f2/MODS/Ecco.DAT"))
        );
        assert_eq!(
            real_cased_path(&platform, Path::new("/games/f2"), "mods/other.dat", None),
            None
        );
    }

    #[test]
    fn the_work_directory_is_where_a_retry_finds_the_download() {
        let (platform, release) = simple();
        planned(&platform, &release);
        let at = mod_work_directory(&platform, &install(), "ecco").join(ARCHIVE);
        assert!(at.starts_with(WORK), "{at:?}");
        assert_eq!(platform.fs().read(&at).expect("a read"), b"payload");
        // Planning a second time re-uses the verified copy rather than paying the download again.
        let before = platform.records().downloaded.len();
        planned(&platform, &release);
        assert_eq!(platform.records().downloaded.len(), before);
    }
}

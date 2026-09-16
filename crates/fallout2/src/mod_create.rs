//! Installing a base mod that creates its install rather than transforming one. Fallout et tu is the
//! case: a whole second game inside a Fallout 2 folder, at `<Fallout 2>/Fallout1in2/`, reading the
//! host's `master.dat` from one directory up.
//!
//! There is no installer to delegate to and none is needed - the install is additive, so nothing is
//! overlaid or moved aside - which is why ZAX performs this one. What it owes in exchange is the
//! confinement the delegated route cannot offer: every entry of the payload is checked against the
//! directory the manifest says it creates, before a byte is written, and the host install is not
//! touched at all.
//!
//! The archive the mod unpacks belongs to the user, not to the release: it is their own copy of
//! Fallout 1, and the folder it sits in is what ZAX asks for.
//!
//! Once, and only where there is none: an install this makes is never upgraded in place. Upstream
//! publishes a fresh unpack and nothing else, with no installer, no update script and no instructions
//! for one - and laying a release over an installation would overwrite the mod's own configuration and
//! load order, which sit outside the files ZAX holds aside, with the release's defaults. `mod_created`
//! says where the install would be, and a directory already there is refused rather than written into.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use zax_core::directories::backup_directory;
use zax_core::hash::fnv1a;
use zax_core::ini_merge::MergeConflict;
use zax_core::install::{GameType, Install};
use zax_core::stamp::{LocalTime, stamp};
use zax_platform::archive::{ArchiveEntryInfo, ArchiveEntryKind, ExtractOptions};
use zax_platform::fs::FileKind;
use zax_platform::{Error, Platform, Result};

use crate::archive_preflight::preflight_archive;
use crate::dat::DatSource;
use crate::files::CONFIG_FILES;
use crate::manifest::{ModCreates, ModManifest, ModType};
use crate::mod_asset::{AssetNaming, ModProgress, fetch_asset};
use crate::mod_created::{created_install_path, no_upgrade_here};
use crate::mod_feed::{ModRelease, ReleaseAsset};
use crate::mod_install::conflict_for;
use crate::mod_state::{hold_user_files, merge_user_files, restore_user_files};
use crate::mod_transaction::mod_work_directory;
use crate::mods::MODS_ORDER_PATH;
use crate::records::{InstallRecord, InstalledMod, assert_usable, load_record, save_record};

/// What creating an install would do. Thicker than a delegated base mod's plan, because ZAX performs
/// this one and therefore knows - but still not a file list: ten thousand payload entries are not
/// something anybody reads before pressing a button.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateInstallPlan {
    pub version: String,
    /// The directory it makes, relative to the host install.
    pub directory: String,
    pub asset: String,
    pub download: u64,
    /// What the payload unpacks to, read from its own directory.
    pub unpacked: u64,
    /// Free bytes on the host's filesystem, where the host could say.
    pub free: Option<u64>,
    /// The folders the user pointed at, by input id.
    pub inputs: BTreeMap<String, String>,
    /// How many paths are lifted out of the user's own archive, counted from the list the payload
    /// ships.
    pub extracts: Option<usize>,
    /// The game type the created install reports. The host's own type does not change.
    pub becomes: GameType,
    pub fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateInstallOutcome {
    pub version: String,
    /// The install this made, which the caller registers - identified by reading it, not by the claim
    /// here.
    pub created: PathBuf,
    /// How many paths were lifted out of the user's archive.
    pub extracted: usize,
    /// Paths the list named that the user's archive does not hold, which the extraction went without.
    pub skipped: Vec<String>,
    /// Settings both the user and the release changed; the user's won. Empty on a first install.
    pub conflicts: Vec<MergeConflict>,
}

/// A release read as one that creates an install, which is the only shape this module acts on.
struct CreatingRelease<'a> {
    manifest: &'a ModManifest,
    creates: &'a ModCreates,
    becomes: GameType,
    archive: &'a ReleaseAsset,
}

fn creating_release(release: &ModRelease) -> Result<CreatingRelease<'_>> {
    let manifest = &release.manifest;
    let (ModType::Base, Some(creates), Some(becomes)) =
        (manifest.mod_type, &manifest.creates, manifest.becomes)
    else {
        return Err(Error::Unsupported(format!(
            "{} does not create an install.",
            manifest.name
        )));
    };
    let Some(archive) = &release.archive else {
        return Err(Error::Unsupported(format!(
            "The {} release does not say which of its files is the payload.",
            manifest.name
        )));
    };
    Ok(CreatingRelease {
        manifest,
        creates,
        becomes,
        archive,
    })
}

fn inside_path(root: &Path, relative: &str) -> PathBuf {
    let mut out = root.to_path_buf();
    for segment in relative.split('/') {
        out.push(segment);
    }
    out
}

/// A name inside a directory as that directory really spells it, or nothing - the user's folder is
/// theirs.
fn named_in(platform: &dyn Platform, directory: &str, name: &str) -> Option<PathBuf> {
    let at = Path::new(directory);
    let found = platform
        .fs()
        .list(at)
        .ok()?
        .into_iter()
        .find(|entry| entry.name.to_lowercase() == name.to_lowercase())?;
    Some(at.join(found.name))
}

/// The archive each declared input points at, checked as far as looking can check it: a folder that is
/// there and holds the file the manifest names. Whether it is the right archive is the list gate's
/// question, and that one needs the payload.
fn archives_for(
    platform: &dyn Platform,
    manifest: &ModManifest,
    answers: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, PathBuf>> {
    let mut found = BTreeMap::new();
    for input in manifest.inputs.as_deref().unwrap_or_default() {
        let answer = answers.get(&input.id).map_or("", String::as_str).trim();
        if answer.is_empty() {
            return Err(Error::Unsupported(format!(
                "{} needs {} before it can be installed.",
                manifest.name, input.label
            )));
        }
        let Some(at) = named_in(platform, answer, &input.holds) else {
            return Err(Error::Unsupported(format!(
                "{answer} does not hold {}, so it is not {}.",
                input.holds,
                input.label.to_lowercase()
            )));
        };
        found.insert(input.id.clone(), at);
    }
    Ok(found)
}

/// The archive `extract-dat` reads, resolved through the input it names.
fn source_archive<'a>(
    manifest: &ModManifest,
    archives: &'a BTreeMap<String, PathBuf>,
) -> Option<&'a PathBuf> {
    archives.get(&manifest.extract_dat.as_ref()?.from)
}

/// Where the payload's own copy of the extraction list is put, out of the archive rather than off the
/// disk.
fn list_directory(work: &Path) -> PathBuf {
    work.join("list")
}

/// The list the payload ships, with how many paths it names.
struct ExtractionList {
    bytes: Vec<u8>,
    entries: usize,
}

/// The list the payload ships, extracted on its own. It is read before the payload lands - the gate
/// that decides whether the user pointed at the right archive runs against it, and running that before
/// an 800 MB unpack is the difference between a refusal and a mess.
fn fetch_list(
    platform: &dyn Platform,
    work: &Path,
    archive_path: &Path,
    manifest: &ModManifest,
    creates: &ModCreates,
) -> Result<Option<ExtractionList>> {
    let Some(declared) = manifest
        .extract_dat
        .as_ref()
        .map(|extract| extract.list.clone())
    else {
        return Ok(None);
    };
    let inside = format!("{}/{declared}", creates.directory);
    let at = list_directory(work);
    platform.archive().extract(
        archive_path,
        &at,
        &ExtractOptions {
            only: vec![inside.clone()],
        },
    )?;
    let path = inside_path(&at, &inside);
    if platform.fs().stat(&path)?.map(|stat| stat.kind) != Some(FileKind::File) {
        return Err(Error::Unsupported(format!(
            "The payload does not carry \"{declared}\", which the {} manifest declares.",
            manifest.name
        )));
    }
    let bytes = platform.fs().read(&path)?;
    let entries = String::from_utf8_lossy(&bytes)
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count();
    Ok(Some(ExtractionList { bytes, entries }))
}

/// Whether an archive entry sits inside the directory this mod creates, compared as the filesystem
/// compares.
fn inside_created(name: &str, directory: &str) -> bool {
    let name = name.to_lowercase();
    let directory = directory.to_lowercase();
    name == directory || name.starts_with(&format!("{directory}/"))
}

/// The payload's directory, refused unless every entry of it sits inside what the manifest says this
/// mod creates. The confinement this shape promises, and the reason it is checked on both sides: the
/// plan's answer is what the user agreed to, and this one runs where the writing happens.
fn confined_entries(
    platform: &dyn Platform,
    archive_path: &Path,
    archive: &ReleaseAsset,
    manifest: &ModManifest,
    creates: &ModCreates,
) -> Result<Vec<ArchiveEntryInfo>> {
    let entries = preflight_archive(platform, archive_path, &archive.name)?;
    if let Some(outside) = entries
        .iter()
        .find(|entry| !inside_created(&entry.name, &creates.directory))
    {
        return Err(Error::Unsupported(format!(
            "{} carries \"{}\", which is outside the {} folder {} creates - refused.",
            archive.name, outside.name, creates.directory, manifest.name
        )));
    }
    Ok(entries)
}

/// The files in the created install that belong to the user, relative to the host - what the manifest
/// declares, or the game's own config files plus every ini the payload carries.
///
/// Derived from the payload rather than listed here, and that is the point: a mod that installs a whole
/// game carries a directory of settings of its own, and a copy of that list in ZAX would be a second
/// home for a set the release owns - stale the moment upstream adds one. The other two install routes
/// read the same way, each defaulting to what its own payload is.
///
/// Case-insensitively unique: the manifest spells the directory its own way and the archive spells its
/// entries theirs, so `ddraw.ini` arrives from both sides and holding one file twice would back it up
/// twice.
fn user_settings(creates: &ModCreates, entries: &[ArchiveEntryInfo]) -> Vec<String> {
    let declared = CONFIG_FILES
        .iter()
        .map(|name| format!("{}/{name}", creates.directory))
        .chain(
            entries
                .iter()
                .filter(|entry| {
                    entry.kind == ArchiveEntryKind::File
                        && entry.name.to_lowercase().ends_with(".ini")
                })
                .map(|entry| entry.name.clone()),
        );
    let mut seen = BTreeSet::new();
    declared
        .filter(|path| seen.insert(path.to_lowercase()))
        .collect()
}

/// The row's own refusal, with what the other refusals here end on: this one is answered at the moment
/// the user asked for the install, where saying that nothing happened is the half they came for.
fn already_there(manifest: &ModManifest, install: &Install) -> String {
    format!(
        "{} Nothing was installed.",
        no_upgrade_here(manifest, install.game_type)
    )
}

/// Where the install would be, and whether this attempt may write into a directory that is there.
///
/// The unfinished attempt a record describes is the exception - that directory is this install part-way
/// through, and resuming it is not a second install. Its conflict rules are skipped with it, since what
/// they guard against is another base mod's files and half of this one's are already there.
fn refuse_unless_fresh(
    platform: &dyn Platform,
    install: &Install,
    release: &ModRelease,
    held: &CreatingRelease<'_>,
    record: &InstallRecord,
) -> Result<PathBuf> {
    let created = created_install_path(
        Path::new(&install.path),
        install.game_type,
        Some(held.becomes),
        &held.creates.directory,
    );
    let resuming = record
        .mods
        .iter()
        .any(|one| one.id == held.manifest.id && !one.complete);
    if !resuming {
        if platform.fs().stat(&created)?.is_some() {
            return Err(Error::Unsupported(already_there(held.manifest, install)));
        }
        if let Some(refusal) = conflict_for(platform, install, release) {
            return Err(Error::Unsupported(refusal));
        }
    }
    Ok(created)
}

/// Resolves what creating this install would do, and downloads what it needs to say so - without
/// writing anything into the game folder.
///
/// # Errors
///
/// Fails where the manifest does not create an install, where an input names no folder holding what it
/// asks for, where the user's archive cannot be read, where the directory is already there, where a
/// drive is short, or where the payload reaches outside the directory it declares.
pub fn plan_create_install(
    platform: &dyn Platform,
    install: &Install,
    release: &ModRelease,
    answers: &BTreeMap<String, String>,
    options: &ModProgress<'_>,
) -> Result<CreateInstallPlan> {
    let held = creating_release(release)?;
    let record = load_record(platform, &install.path)?;
    assert_usable(&record, &held.manifest.id)?;

    // The user's own folders first: everything after this costs a download, and a folder that is not
    // the game the mod asked for is the likeliest thing to be wrong.
    let archives = archives_for(platform, held.manifest, answers)?;
    if let Some(source) = source_archive(held.manifest, &archives) {
        // Parsing it at all is the check: what the user pointed at either reads as a Fallout archive
        // or does not.
        DatSource::open(platform, source).map_err(|err| {
            Error::Unsupported(format!("ZAX cannot read {}: {err}", source.display()))
        })?;
    }

    // Where the install would be. Either way a directory that is there is one this does not write into:
    // there is no upgrade to perform, and the refusal comes before the download rather than after
    // 400 MB of it.
    refuse_unless_fresh(platform, install, release, &held, &record)?;

    // The download lands in ZAX's cache and the payload in the game folder, which on most machines are
    // not the same drive - so each is measured where its bytes actually go. The directory has to exist
    // to be measured.
    let download = held.archive.size.unwrap_or(0);
    let work = mod_work_directory(platform, install, &held.manifest.id);
    platform.fs().mkdir(&work)?;
    if let Some(room) = platform.fs().free_space(&work)?
        && download > 0
        && room < download
    {
        return Err(Error::Unsupported(format!(
            "{} needs {download} bytes to download and this drive has {room} free. Nothing was \
             downloaded.",
            held.manifest.name
        )));
    }

    let archive_path = fetch_asset(
        platform,
        &work,
        held.archive,
        AssetNaming {
            mod_name: &held.manifest.name,
            label: &format!("{} {}", held.manifest.name, held.manifest.version),
        },
        options,
    )?;

    options.step(&format!("Reading {}", held.archive.name));
    let entries = confined_entries(
        platform,
        &archive_path,
        held.archive,
        held.manifest,
        held.creates,
    )?;
    let unpacked: u64 = entries.iter().map(|entry| entry.size).sum();
    // Read after the download rather than before it: where the cache and the game folder do share a
    // drive, the archive that has just landed on it is room the unpack no longer has.
    let free = platform.fs().free_space(Path::new(&install.path))?;
    if let Some(free) = free
        && free < unpacked
    {
        return Err(Error::Unsupported(format!(
            "{} unpacks to {unpacked} bytes and this drive has {free} free. Nothing was installed.",
            held.manifest.name
        )));
    }

    let list = fetch_list(platform, &work, &archive_path, held.manifest, held.creates)?;
    let chosen: BTreeMap<String, String> = archives
        .keys()
        .map(|id| {
            (
                id.clone(),
                answers.get(id).map_or("", String::as_str).trim().to_owned(),
            )
        })
        .collect();

    let mut lines = vec![
        held.manifest.version.clone(),
        held.archive.digest.clone().unwrap_or_default(),
        held.creates.directory.clone(),
    ];
    // Ordered by id, which a `BTreeMap` already is, so the same answers fingerprint the same.
    lines.extend(chosen.iter().map(|(id, folder)| format!("{id}={folder}")));
    lines.push(unpacked.to_string());
    lines.push(list.as_ref().map_or(0, |held| held.entries).to_string());

    Ok(CreateInstallPlan {
        fingerprint: fnv1a(&lines.join("\n")),
        version: held.manifest.version.clone(),
        directory: held.creates.directory.clone(),
        asset: held.archive.name.clone(),
        download,
        unpacked,
        free,
        inputs: chosen,
        extracts: list.map(|held| held.entries),
        becomes: held.becomes,
    })
}

/// Creates the install: the payload into the directory it declares, then the user's own archive into
/// that directory's data folder.
///
/// A failure leaves what has landed where it is. There is nothing to unwind - the host was never
/// touched - and deleting a finished 800 MB unpack because the last step failed would cost the user the
/// whole download over a folder they can point at again.
///
/// # Errors
///
/// As `plan_create_install`, plus any write that fails while the payload is being unpacked.
pub fn apply_create_install(
    platform: &dyn Platform,
    install: &Install,
    release: &ModRelease,
    plan: &CreateInstallPlan,
    options: &ModProgress<'_>,
    now: LocalTime,
) -> Result<CreateInstallOutcome> {
    // What the created install becomes is not read here: the caller identifies the directory by reading
    // it, so a payload that did not produce what it claimed is visible rather than recorded.
    let held = creating_release(release)?;
    let record = load_record(platform, &install.path)?;
    assert_usable(&record, &held.manifest.id)?;
    let previous = record
        .mods
        .iter()
        .find(|one| one.id == held.manifest.id && one.complete)
        .cloned();

    // The plan's answers rather than fresh ones: what runs is what was confirmed, down to which folder
    // it reads from. They are checked again all the same - the folder may have gone since.
    let archives = archives_for(platform, held.manifest, &plan.inputs)?;
    let source = source_archive(held.manifest, &archives).cloned();

    // Asked again here rather than trusted from the plan: this is the call that writes, and the
    // directory may have appeared since - a second window, a hand-unpacked copy.
    //
    // The directory decides, not the record: a completed one describing a folder the user has since
    // deleted by hand is the state the row offers a fresh install in, and refusing it here would refuse
    // what it offered.
    let created = refuse_unless_fresh(platform, install, release, &held, &record)?;

    let work = mod_work_directory(platform, install, &held.manifest.id);
    let archive_path = fetch_asset(
        platform,
        &work,
        held.archive,
        AssetNaming {
            mod_name: &held.manifest.name,
            label: &format!("{} {}", held.manifest.name, held.manifest.version),
        },
        options,
    )?;

    // Before anything is taken out of the archive, and so before the record is written: what keeps a
    // payload out of the host install is this list rather than anything the archive promises, and
    // reading the payload's own extraction list is itself an extraction. It is also what says which of
    // its files belong to the user.
    let entries = confined_entries(
        platform,
        &archive_path,
        held.archive,
        held.manifest,
        held.creates,
    )?;
    let list = fetch_list(platform, &work, &archive_path, held.manifest, held.creates)?;

    let pending = InstalledMod {
        id: held.manifest.id.clone(),
        version: held.manifest.version.clone(),
        mod_type: Some(ModType::Base),
        reason: held.manifest.reason.clone(),
        complete: false,
        // Empty for the reason a delegated base mod's is: what this install owns is a whole directory,
        // and the record is not the place to enumerate ten thousand paths. It is also what makes it
        // unremovable in fact.
        files: Vec::new(),
        entries: Vec::new(),
        parts: Vec::new(),
        manifest: release.manifest_text.clone(),
        shipped: BTreeMap::new(),
        carried: BTreeMap::new(),
    };
    save_record(platform, &with_mod(&record, &pending))?;

    // The user's own files in the created install, where a resumed attempt left some - the payload
    // unpacks the release's copies of the same files over them. Two kinds, and they are not
    // interchangeable: settings are merged key by key, and the load order is put back as it was.
    //
    // The load order half is this route's alone, not the delegated one's: a payload that installs a
    // whole game ships that game's order file, while an installer that adds a mod to this game rewrites
    // the order to put its own dat in - and putting the user's copy back over that would take the mod
    // they just installed out.
    let root = Path::new(&install.path);
    let backup = backup_directory(platform).join(stamp(now));
    let state_files = user_settings(held.creates, &entries);
    let mine = hold_user_files(platform, root, &state_files, &backup)?;
    let ordering = vec![format!("{}/{MODS_ORDER_PATH}", held.creates.directory)];
    let order = hold_user_files(platform, root, &ordering, &backup)?;

    options.step(&format!(
        "Installing {} {}",
        held.manifest.name, held.manifest.version
    ));
    platform
        .archive()
        .extract(&archive_path, root, &ExtractOptions::default())?;
    restore_user_files(platform, root, &order)?;

    let mut extracted = 0;
    let mut skipped: Vec<String> = Vec::new();
    if let (Some(source), Some(list), Some(extract)) = (source, list, &held.manifest.extract_dat) {
        options.step("Unpacking Fallout 1's files");
        // The extraction is what discovers a path this edition of the archive spells differently: it
        // is told to skip those and says which they were. The count reported has to lose them too, or
        // it names files that never landed.
        let owned = DatSource::open(platform, &source)?;
        skipped =
            owned.extract_listed(platform, &list.bytes, &inside_path(&created, &extract.into))?;
        extracted = list.entries.saturating_sub(skipped.len());
    }

    let base = previous.as_ref().map(|one| {
        one.shipped
            .iter()
            .map(|(path, text)| (path.clone(), zax_core::text::latin1_bytes(text)))
            .collect::<BTreeMap<String, Vec<u8>>>()
    });
    let merged = merge_user_files(platform, root, &state_files, &mine, base.as_ref())?;

    let written = load_record(platform, &install.path)?;
    let done = InstalledMod {
        complete: true,
        shipped: merged
            .shipped
            .iter()
            .map(|(path, bytes)| (path.clone(), zax_core::text::latin1(bytes)))
            .collect(),
        ..pending
    };
    save_record(platform, &with_mod(&written, &done))?;
    platform.fs().remove(&work)?;
    Ok(CreateInstallOutcome {
        version: held.manifest.version.clone(),
        created,
        extracted,
        skipped,
        conflicts: merged.conflicts,
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::{ManifestDefaults, parse_manifest};
    use zax_platform::memory::{Content, MemoryOptions, MemoryPlatform};

    const URL: &str = "https://example/fo1in2.zip";
    const PAYLOAD: &str = "et-tu";

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

    const MANIFEST: &str = "spec: 1
id: fo1in2
name: Fallout et tu
version: 1.16
game: fallout2
type: base
becomes: fo1in2
archive: fo1in2.zip
creates.directory: Fallout1in2
inputs:
  - id: fallout1
    label: Your Fallout 1 folder
    holds: master.dat
extract-dat.from: fallout1
extract-dat.list: undat_files.txt
extract-dat.into: data
";

    fn digest(platform: &MemoryPlatform) -> String {
        let at = Path::new("/tmp/probe");
        platform
            .fs()
            .write(at, PAYLOAD.as_bytes())
            .expect("a file the test writes");
        format!("sha256:{}", platform.hash().sha256(at).expect("a digest"))
    }

    fn release_of(platform: &MemoryPlatform, text: &str) -> ModRelease {
        ModRelease {
            manifest: parse_manifest(text.as_bytes(), &ManifestDefaults::default())
                .expect("a manifest the test writes"),
            manifest_text: text.to_owned(),
            archive: Some(ReleaseAsset {
                name: "fo1in2.zip".to_owned(),
                url: URL.to_owned(),
                digest: Some(digest(platform)),
                size: Some(PAYLOAD.len() as u64),
            }),
            parts: BTreeMap::new(),
            installer: None,
            installer_route: None,
            line: None,
        }
    }

    /// A Fallout 1 archive the user owns, built by the same library that reads it rather than
    /// hand-typed. Case-sensitively, so the name lands exactly as written.
    fn master_dat() -> Vec<u8> {
        use dat3_core::common::{CaseMode, CompressionLevel};
        use dat3_core::{ArchiveFormat, DatArchive};
        let mut archive = DatArchive::new(ArchiveFormat::Dat1);
        archive
            .insert(
                "art/critters/hero.frm",
                b"frames".to_vec(),
                CompressionLevel::new(0).expect("0 is a valid compression level"),
                CaseMode::Sensitive,
            )
            .expect("an entry the test writes");
        archive.to_bytes().expect("an archive the test writes")
    }

    /// The host: the user's Fallout 1 folder, and the release's payload as an archive.
    fn host(inside: &[(&str, &str)], extra: &[(&str, &str)]) -> MemoryPlatform {
        let mut files: BTreeMap<String, Content> = BTreeMap::from([(
            "/games/fallout1/MASTER.DAT".to_owned(),
            Content::Binary(master_dat()),
        )]);
        files.extend(
            extra
                .iter()
                .map(|(path, text)| ((*path).to_owned(), Content::from(*text))),
        );
        MemoryPlatform::new(MemoryOptions {
            files,
            dirs: vec!["/games/f2".to_owned()],
            downloads: BTreeMap::from([(URL.to_owned(), Content::from(PAYLOAD))]),
            archives: BTreeMap::from([(
                PAYLOAD.to_owned(),
                inside
                    .iter()
                    .map(|(name, text)| ((*name).to_owned(), Content::from(*text)))
                    .collect(),
            )]),
            ..MemoryOptions::default()
        })
    }

    /// What a good payload carries: the game's own files under the directory it creates, and the list.
    fn payload() -> Vec<(&'static str, &'static str)> {
        vec![
            ("Fallout1in2/fallout2.exe", "binary"),
            ("Fallout1in2/ddraw.ini", "[Misc]\nA=1\n"),
            ("Fallout1in2/undat_files.txt", "art/critters/hero.frm\n"),
        ]
    }

    fn answers() -> BTreeMap<String, String> {
        BTreeMap::from([("fallout1".to_owned(), "/games/fallout1".to_owned())])
    }

    fn planned(platform: &MemoryPlatform, release: &ModRelease) -> Result<CreateInstallPlan> {
        plan_create_install(
            platform,
            &install(),
            release,
            &answers(),
            &ModProgress::default(),
        )
    }

    fn created(platform: &MemoryPlatform, release: &ModRelease) -> Result<CreateInstallOutcome> {
        let plan = planned(platform, release)?;
        apply_create_install(
            platform,
            &install(),
            release,
            &plan,
            &ModProgress::default(),
            now(),
        )
    }

    #[test]
    fn a_manifest_that_creates_nothing_is_refused() {
        let platform = host(&payload(), &[]);
        let text = "spec: 1\nid: ecco\nname: EcCo\nversion: 1.0\ngame: fallout2\n\
                    type: pluggable\narchive: ecco.zip\n";
        let err = planned(&platform, &release_of(&platform, text)).expect_err("not a creating mod");
        assert!(
            format!("{err}").contains("does not create an install"),
            "{err}"
        );
    }

    #[test]
    fn an_input_with_no_answer_is_asked_for_before_anything_is_downloaded() {
        let platform = host(&payload(), &[]);
        let err = plan_create_install(
            &platform,
            &install(),
            &release_of(&platform, MANIFEST),
            &BTreeMap::new(),
            &ModProgress::default(),
        )
        .expect_err("no answer");
        assert!(
            format!("{err}").contains("needs Your Fallout 1 folder"),
            "{err}"
        );
        assert!(platform.records().downloaded.is_empty());
    }

    #[test]
    fn a_folder_that_does_not_hold_what_the_input_asks_for_is_refused_by_name() {
        let platform = host(&payload(), &[]);
        let elsewhere = BTreeMap::from([("fallout1".to_owned(), "/games/f2".to_owned())]);
        let err = plan_create_install(
            &platform,
            &install(),
            &release_of(&platform, MANIFEST),
            &elsewhere,
            &ModProgress::default(),
        )
        .expect_err("the wrong folder");
        let said = format!("{err}");
        assert!(said.contains("does not hold master.dat"), "{said}");
        assert!(said.contains("your fallout 1 folder"), "{said}");
    }

    #[test]
    fn a_folder_holding_something_that_is_not_an_archive_is_refused() {
        // Parsing it at all is what refuses a user who pointed at the wrong game.
        let platform = host(
            &payload(),
            &[("/games/notgame/master.dat", "not an archive at all")],
        );
        let wrong = BTreeMap::from([("fallout1".to_owned(), "/games/notgame".to_owned())]);
        let err = plan_create_install(
            &platform,
            &install(),
            &release_of(&platform, MANIFEST),
            &wrong,
            &ModProgress::default(),
        )
        .expect_err("not readable");
        assert!(format!("{err}").contains("cannot read"), "{err}");
    }

    #[test]
    fn a_payload_reaching_outside_the_directory_it_creates_is_refused() {
        // The confinement this shape promises, in exchange for ZAX performing the install itself.
        let platform = host(
            &[
                ("Fallout1in2/fallout2.exe", "binary"),
                ("Fallout1in2/undat_files.txt", "art/critters/hero.frm\n"),
                ("data/hero.frm", "into the host install"),
            ],
            &[],
        );
        let err =
            planned(&platform, &release_of(&platform, MANIFEST)).expect_err("outside the folder");
        let said = format!("{err}");
        assert!(said.contains("data/hero.frm"), "{said}");
        assert!(said.contains("refused"), "{said}");
    }

    #[test]
    fn the_plan_counts_what_the_payload_unpacks_and_what_it_lifts_out() {
        let platform = host(&payload(), &[]);
        let plan = planned(&platform, &release_of(&platform, MANIFEST)).expect("a plan");
        assert_eq!(plan.directory, "Fallout1in2");
        assert_eq!(plan.becomes, GameType::Fo1In2);
        assert_eq!(plan.extracts, Some(1));
        assert_eq!(
            plan.unpacked,
            payload().iter().map(|(_, t)| t.len() as u64).sum::<u64>()
        );
        assert_eq!(plan.inputs["fallout1"], "/games/fallout1");
    }

    #[test]
    fn a_payload_missing_the_list_it_declares_is_refused() {
        let platform = host(
            &[
                ("Fallout1in2/fallout2.exe", "binary"),
                ("Fallout1in2/ddraw.ini", "[Misc]\nA=1\n"),
            ],
            &[],
        );
        let err = planned(&platform, &release_of(&platform, MANIFEST)).expect_err("no list");
        assert!(
            format!("{err}").contains("does not carry \"undat_files.txt\""),
            "{err}"
        );
    }

    #[test]
    fn a_directory_already_there_is_never_written_into() {
        // Upstream publishes a fresh unpack and nothing else.
        let platform = host(
            &payload(),
            &[("/games/f2/Fallout1in2/fallout2.exe", "already here")],
        );
        let err =
            planned(&platform, &release_of(&platform, MANIFEST)).expect_err("already installed");
        let said = format!("{err}");
        assert!(said.contains("Fallout1in2 holds Fallout et tu"), "{said}");
        assert!(said.contains("Nothing was installed."), "{said}");
    }

    #[test]
    fn creating_the_install_unpacks_the_payload_and_the_users_own_archive() {
        let platform = host(&payload(), &[]);
        let done = created(&platform, &release_of(&platform, MANIFEST)).expect("an install");
        assert_eq!(done.created, PathBuf::from("/games/f2/Fallout1in2"));
        assert_eq!(done.extracted, 1);
        assert!(done.skipped.is_empty());
        assert_eq!(
            platform
                .fs()
                .read(Path::new("/games/f2/Fallout1in2/fallout2.exe"))
                .expect("a read"),
            b"binary"
        );
        // The user's Fallout 1 art, lifted into the created install's data folder.
        assert_eq!(
            platform
                .fs()
                .read(Path::new(
                    "/games/f2/Fallout1in2/data/art/critters/hero.frm"
                ))
                .expect("a read"),
            b"frames"
        );
        // The host install was never touched.
        assert_eq!(
            platform
                .fs()
                .stat(Path::new("/games/f2/fallout2.exe"))
                .expect("a read"),
            None
        );
    }

    #[test]
    fn a_path_the_users_edition_spells_differently_is_gone_without_rather_than_refused() {
        // A list is written against one edition of the archive and run against whichever they own.
        let platform = host(
            &[
                ("Fallout1in2/fallout2.exe", "binary"),
                (
                    "Fallout1in2/undat_files.txt",
                    "art/critters/hero.frm\nart/critters/gone.frm\n",
                ),
            ],
            &[],
        );
        let done = created(&platform, &release_of(&platform, MANIFEST)).expect("an install");
        assert_eq!(done.extracted, 1);
        assert_eq!(done.skipped, ["art/critters/gone.frm"]);
    }

    #[test]
    fn the_record_says_a_crash_happened_rather_than_reading_as_a_finished_install() {
        let platform = host(&payload(), &[]);
        created(&platform, &release_of(&platform, MANIFEST)).expect("an install");
        let held = load_record(&platform, "/games/f2")
            .expect("a record")
            .mods
            .into_iter()
            .find(|one| one.id == "fo1in2")
            .expect("a record entry");
        assert!(held.complete);
        // Empty on purpose: what this install owns is a whole directory.
        assert!(held.files.is_empty());
        assert_eq!(held.mod_type, Some(ModType::Base));
    }

    #[test]
    fn the_created_installs_own_load_order_is_put_back_over_the_payloads() {
        // An unfinished attempt left one; the payload ships the release's copy over it.
        let platform = host(
            &[
                ("Fallout1in2/fallout2.exe", "binary"),
                ("Fallout1in2/mods/mods_order.txt", "the release's\n"),
                ("Fallout1in2/undat_files.txt", "art/critters/hero.frm\n"),
            ],
            &[("/games/f2/Fallout1in2/mods/mods_order.txt", "the user's\n")],
        );
        // The record says an attempt is part way through, which is what lets this write into a
        // directory that is there.
        let release = release_of(&platform, MANIFEST);
        let record = load_record(&platform, "/games/f2").expect("a record");
        save_record(
            &platform,
            &with_mod(
                &record,
                &InstalledMod {
                    id: "fo1in2".to_owned(),
                    version: "1.16".to_owned(),
                    mod_type: Some(ModType::Base),
                    reason: None,
                    complete: false,
                    files: Vec::new(),
                    entries: Vec::new(),
                    parts: Vec::new(),
                    manifest: MANIFEST.to_owned(),
                    shipped: BTreeMap::new(),
                    carried: BTreeMap::new(),
                },
            ),
        )
        .expect("a record");
        created(&platform, &release).expect("a resumed install");
        assert_eq!(
            platform
                .fs()
                .read(Path::new("/games/f2/Fallout1in2/mods/mods_order.txt"))
                .expect("a read"),
            b"the user's\n"
        );
    }

    #[test]
    fn the_users_settings_survive_the_payload_landing_over_them() {
        let platform = host(
            &payload(),
            &[("/games/f2/Fallout1in2/ddraw.ini", "[Misc]\nA=9\n")],
        );
        // Resuming, so the directory already being there is not the refusal under test.
        let release = release_of(&platform, MANIFEST);
        let record = load_record(&platform, "/games/f2").expect("a record");
        save_record(
            &platform,
            &with_mod(
                &record,
                &InstalledMod {
                    id: "fo1in2".to_owned(),
                    version: "1.16".to_owned(),
                    mod_type: Some(ModType::Base),
                    reason: None,
                    complete: false,
                    files: Vec::new(),
                    entries: Vec::new(),
                    parts: Vec::new(),
                    manifest: MANIFEST.to_owned(),
                    shipped: BTreeMap::new(),
                    carried: BTreeMap::new(),
                },
            ),
        )
        .expect("a record");
        created(&platform, &release).expect("a resumed install");
        let held = platform
            .fs()
            .read(Path::new("/games/f2/Fallout1in2/ddraw.ini"))
            .expect("a read");
        assert!(
            String::from_utf8_lossy(&held).contains("A=9"),
            "{}",
            String::from_utf8_lossy(&held)
        );
    }

    #[test]
    fn the_settings_that_belong_to_the_user_are_read_off_the_payload() {
        // A copy of that list in ZAX would go stale the moment upstream adds one.
        let creates = ModCreates {
            directory: "Fallout1in2".to_owned(),
        };
        let entries = vec![
            ArchiveEntryInfo {
                name: "Fallout1in2/ddraw.ini".to_owned(),
                kind: ArchiveEntryKind::File,
                size: 1,
            },
            ArchiveEntryInfo {
                name: "Fallout1in2/mods/ecco.ini".to_owned(),
                kind: ArchiveEntryKind::File,
                size: 1,
            },
            ArchiveEntryInfo {
                name: "Fallout1in2/fallout2.exe".to_owned(),
                kind: ArchiveEntryKind::File,
                size: 1,
            },
        ];
        let held = user_settings(&creates, &entries);
        assert!(held.contains(&"Fallout1in2/fallout2.cfg".to_owned()));
        assert!(held.contains(&"Fallout1in2/mods/ecco.ini".to_owned()));
        assert!(!held.contains(&"Fallout1in2/fallout2.exe".to_owned()));
        // `ddraw.ini` arrives from both sides and holding one file twice would back it up twice.
        assert_eq!(
            held.iter()
                .filter(|path| path.to_lowercase().ends_with("ddraw.ini"))
                .count(),
            1
        );
    }

    #[test]
    fn the_same_answers_fingerprint_the_same_and_another_folder_does_not() {
        let platform = host(&payload(), &[("/games/other/master.dat", "not an archive")]);
        let release = release_of(&platform, MANIFEST);
        let first = planned(&platform, &release).expect("a plan");
        let second = planned(&platform, &release).expect("a plan");
        assert_eq!(first.fingerprint, second.fingerprint);
    }

    #[test]
    fn the_working_directory_goes_only_once_the_install_has_finished() {
        let platform = host(&payload(), &[]);
        created(&platform, &release_of(&platform, MANIFEST)).expect("an install");
        let work = mod_work_directory(&platform, &install(), "fo1in2");
        assert_eq!(platform.fs().stat(&work).expect("a read"), None);
    }
}

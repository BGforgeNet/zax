//! Installing a base mod, which ZAX does not perform: it resolves the release, decides eligibility,
//! downloads and verifies, hands the install over to the installer the mod ships, and picks the pieces
//! up afterwards.
//!
//! The two routes are different installs, not two spellings of one. The Windows route is an installer
//! program that takes the game directory as an argument. The other route is a payload extracted over
//! the game with a script inside it that finishes the job - `rpu-install.sh` runs
//! `cd -- "$(dirname "$0")"` and works there, so the extraction is not a step before the install, it is
//! most of the install.
//!
//! One-way by design: there is no uninstall and no unwinding a failure. What ZAX owes instead is that a
//! failure says how far it got and where the installer's own backup went.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use zax_core::directories::backup_directory;
use zax_core::hash::fnv1a;
use zax_core::ini_merge::MergeConflict;
use zax_core::install::{GameType, Install};
use zax_core::stamp::{LocalTime, stamp};
use zax_platform::archive::ExtractOptions;
use zax_platform::process::LaunchOptions;
use zax_platform::{Error, Platform, Result};

use crate::archive_preflight::preflight_archive;
use crate::case_lowering::{case_sensitive_at, lowercase_tree, mixed_case_paths};
use crate::files::CONFIG_FILES;
use crate::install_lock::{Claim, InstallLock, take_install_lock};
use crate::manifest::{ModManifest, ModType};
use crate::mod_asset::{AssetNaming, ModProgress, fetch_asset};
use crate::mod_feed::{InstallerRoute, ModRelease, installer_miss};
use crate::mod_install::conflict_for;
use crate::mod_state::{hold_user_files, merge_user_files};
use crate::mod_transaction::mod_work_directory;
use crate::records::{InstallRecord, InstalledMod, assert_usable, load_record, save_record};

/// What installing a base mod would do, as far as anything but the installer can say. Thinner than a
/// stacking mod's plan on purpose, and the plan says so: the installer decides what lands, so naming
/// files here would be inventing them.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct BaseInstallPlan {
    pub version: String,
    /// The asset that installs it, and which of the two routes it takes.
    pub asset: String,
    pub route: InstallerRoute,
    /// What the download needs, from what the release states about the asset.
    pub download: u64,
    /// What the payload unpacks to, where the route lets ZAX read that before running anything.
    pub unpacked: Option<u64>,
    /// Free bytes on the game's filesystem, where the host could say.
    pub free: Option<u64>,
    /// How many entries the case-lowering pass would rename before the install runs. Absent where the
    /// pass does not apply - a filesystem that folds case, or an install that is already this mod's.
    pub lowercasing: Option<usize>,
    /// The game type the install reports afterwards.
    pub becomes: GameType,
    pub fingerprint: String,
}

/// Whether this install is already this mod's - a record of it, or a directory that has become what it
/// makes. The second arm is what a hand-installed base mod looks like, which is most of them:
/// upstream's Windows route is the exe installer, and nothing of ZAX was there when it ran.
fn is_same_install(record: &InstallRecord, install: &Install, manifest: &ModManifest) -> bool {
    if record
        .mods
        .iter()
        .any(|held| held.id == manifest.id && held.complete)
    {
        return true;
    }
    manifest.becomes == Some(install.game_type)
}

/// The mod's own installer for this host, refusing with the sentence that tells a missing asset from a
/// system the mod does not install on.
fn installer_of(release: &ModRelease) -> Result<(InstallerRoute, &crate::mod_feed::ReleaseAsset)> {
    match &release.installer {
        Some(installer) => Ok((installer.route, &installer.asset)),
        None => Err(Error::Unsupported(installer_miss(
            &release.manifest,
            release.installer_route,
        ))),
    }
}

/// The game type a base mod makes, refusing a manifest that is not one.
fn becomes_of(manifest: &ModManifest) -> Result<GameType> {
    match (manifest.mod_type, manifest.becomes) {
        (ModType::Base, Some(becomes)) => Ok(becomes),
        _ => Err(Error::Unsupported(format!(
            "{} is not a base mod.",
            manifest.name
        ))),
    }
}

/// Resolves what installing this base mod would do, and downloads what it needs to say so - without
/// letting the installer near the game directory.
///
/// The free-space check happens twice for a reason: before the download it can only know what the
/// release states about the asset, and only after it can the payload's own directory say what it
/// unpacks to. Both are real numbers at the moment they are used, where one guessed multiplier would be
/// neither.
///
/// # Errors
///
/// Fails where the manifest is not a base mod's, where the record may not be written, where the
/// manifest's own conditions refuse this directory, where a drive is short, or where the download fails.
pub fn plan_base_install(
    platform: &dyn Platform,
    install: &Install,
    release: &ModRelease,
    options: &ModProgress<'_>,
) -> Result<BaseInstallPlan> {
    let manifest = &release.manifest;
    let becomes = becomes_of(manifest)?;
    let record = load_record(platform, &install.path)?;
    assert_usable(&record, &manifest.id)?;

    let (route, asset) = installer_of(release)?;

    // The manifest's own conditions, against the directory as it is now, before a byte is spent on the
    // download. The install runs them again: this one is the cheap answer, not the last word.
    //
    // Not on its own install, though. A base mod's conflict rules exist to keep it off a game some other
    // base mod has already changed, and after it has installed, the install answers to those rules
    // itself: UPU refuses over `mods/upu.dat`, which is the file UPU put there. Re-running them on an
    // upgrade would refuse every release after the first.
    let upgrading = is_same_install(&record, install, manifest);
    if !upgrading && let Some(refusal) = conflict_for(platform, install, release) {
        return Err(Error::Unsupported(refusal));
    }

    // Before the download rather than after it: the pass can refuse over a pair of colliding names, and
    // that refusal is worth having before an 800 MB transfer rather than after one. The upgrade arm
    // skips it because the tree was lowercased by the first install, and the payload's own deliberately
    // mixed-case files (`mods/AmmoGlovz.ini`) arrived afterwards and are not ZAX's to rename.
    let root = Path::new(&install.path);
    let lowercasing = if upgrading || !case_sensitive_at(platform, root)? {
        None
    } else {
        Some(mixed_case_paths(platform, root)?.len())
    };

    // The download lands in ZAX's cache and the payload in the game folder, which on most machines are
    // not the same drive - so each is measured where its bytes actually go. The directory has to exist
    // to be measured.
    let download = asset.size.unwrap_or(0);
    let work = mod_work_directory(platform, install, &manifest.id);
    platform.fs().mkdir(&work)?;
    if let Some(room) = platform.fs().free_space(&work)?
        && download > 0
        && room < download
    {
        return Err(Error::Unsupported(format!(
            "{} needs {download} bytes to download and this drive has {room} free. Nothing was \
             downloaded.",
            manifest.name
        )));
    }

    let at = fetch_asset(
        platform,
        &work,
        asset,
        AssetNaming {
            mod_name: &manifest.name,
            label: &format!("{} {}", manifest.name, manifest.version),
        },
        options,
    )?;

    // Read after the download rather than before it: where the cache and the game folder do share a
    // drive, the archive that has just landed on it is room the unpack no longer has.
    let free = platform.fs().free_space(root)?;

    // Only the payload route has a directory to read. An installer program is opaque until it runs,
    // which is the cost of delegation and not something to paper over with a guess.
    let mut unpacked = None;
    if route == InstallerRoute::Other {
        options.step(&format!("Reading {}", asset.name));
        let entries = preflight_archive(platform, &at, &asset.name)?;
        let total: u64 = entries.iter().map(|entry| entry.size).sum();
        if let Some(free) = free
            && free < total
        {
            return Err(Error::Unsupported(format!(
                "{} unpacks to {total} bytes and this drive has {free} free. Nothing was installed.",
                manifest.name
            )));
        }
        unpacked = Some(total);
    }

    let route_name = match route {
        InstallerRoute::Windows => "windows",
        InstallerRoute::Other => "other",
    };
    Ok(BaseInstallPlan {
        fingerprint: fnv1a(
            &[
                manifest.version.as_str(),
                asset.digest.as_deref().unwrap_or(""),
                route_name,
            ]
            .join("\n"),
        ),
        version: manifest.version.clone(),
        asset: asset.name.clone(),
        route,
        download,
        unpacked,
        free,
        lowercasing: lowercasing.filter(|count| *count > 0),
        becomes,
    })
}

/// The command line for an Inno installer: aimed at this install, logging where ZAX can read it, and
/// leaving every other decision to the wizard.
///
/// Deliberately not silent, and deliberately naming no components. `/COMPONENTS` replaces the selection
/// rather than adding to it - it selects a custom type and deselects everything it does not name - so
/// passing it at all means ZAX holding a copy of the component tree out of upstream's `inno.iss`, which
/// nothing verifies and which goes stale against the next release in the direction of silently
/// installing less than the user asked for. Letting the wizard open reads that tree out of the
/// executable the user just downloaded instead. What it costs is the directory page, which `/DIR`
/// already answers, and a click-through.
#[must_use]
pub fn inno_arguments(install_path: &str, log: &Path) -> Vec<String> {
    vec![
        format!("/DIR={install_path}"),
        format!("/LOG={}", log.display()),
        "/NORESTART".to_owned(),
    ]
}

/// The two exit codes Inno documents for a user who stopped the wizard themselves, and they are not one
/// case: 2 is cancelled before the install began, 5 is cancelled part way through it. What separates
/// them is whether anything of the mod is on disk, which decides both what the user is told and whether
/// the unfinished record stays behind for a later run to offer a retry over.
///
/// Reachable only now that the wizard is shown. Read as cancellation on the Inno route alone: the other
/// route runs upstream's shell script, where these numbers are that script's to define and mean nothing
/// here.
const INNO_CANCELLED_BEFORE: i32 = 2;
const INNO_CANCELLED_DURING: i32 = 5;

/// What a finished base install leaves the caller to act on.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct BaseInstallOutcome {
    pub version: String,
    /// What the install now is - the caller re-reads the directory to confirm it.
    pub becomes: GameType,
    /// How many entries the case-lowering pass renamed before the installer ran.
    pub renamed: usize,
    /// Settings both the user and the release changed; the user's won.
    pub conflicts: Vec<MergeConflict>,
    /// Where the installer keeps its own copy of what it moved aside.
    pub backup: PathBuf,
}

fn inside_path(root: &Path, relative: &str) -> PathBuf {
    let mut out = root.to_path_buf();
    for segment in relative.split('/') {
        out.push(segment);
    }
    out
}

/// Runs the installer the mod ships, and does everything around it that the installer does not.
///
/// One-way: there is nothing to unwind here, so a failure says how far it got rather than pretending it
/// can put the directory back. The record is written incomplete before the installer starts and
/// complete after it finishes, so a relaunch that finds an unfinished base install can say so instead
/// of guessing.
///
/// # Errors
///
/// Fails where the manifest is not a base mod's, where the directory is already claimed, where the
/// manifest's own conditions refuse it, or where the installer stops with a non-zero code.
pub fn apply_base_install(
    platform: &dyn Platform,
    install: &Install,
    release: &ModRelease,
    options: &ModProgress<'_>,
    now: LocalTime,
    clock: i64,
) -> Result<BaseInstallOutcome> {
    let manifest = &release.manifest;
    let becomes = becomes_of(manifest)?;
    installer_of(release)?;

    // Claimed after those two refusals rather than before them: a directory must not be held for an
    // operation that was never going to run. Claimed before anything is read, let alone written. An
    // installer from a run that never finished is the one writer nothing else here can see: it is
    // upstream's program, it outlives the ZAX that started it, and the retry this function performs
    // would put a second one over the top of it.
    let claim = take_install_lock(
        platform,
        Path::new(&install.path),
        &format!("Installing {}", manifest.name),
        clock,
    )?;
    let lock = match claim {
        Claim::Refused(why) => return Err(Error::Unsupported(why)),
        Claim::Taken(lock) => Mutex::new(lock),
    };
    let outcome = install_under_lock(platform, install, release, becomes, &lock, options, now);
    // Released on every way out of this, the failures included - there are several, and each leaves the
    // folder part way through.
    let _ = lock
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .release(platform);
    outcome
}

/// The install itself, with the directory already claimed.
#[expect(
    clippy::too_many_lines,
    reason = "one delegated install in the order it happens - hold the user's files, lowercase, \
              record, run, report - and splitting it would put the sequence a failure is read \
              against out of one reader's sight"
)]
fn install_under_lock(
    platform: &dyn Platform,
    install: &Install,
    release: &ModRelease,
    // Narrowed by the caller, which refuses a manifest without one before any of this is reached.
    becomes: GameType,
    lock: &Mutex<InstallLock>,
    options: &ModProgress<'_>,
    now: LocalTime,
) -> Result<BaseInstallOutcome> {
    let manifest = &release.manifest;
    let (route, asset) = installer_of(release)?;
    let root = Path::new(&install.path);

    let record = load_record(platform, &install.path)?;
    assert_usable(&record, &manifest.id)?;
    let previous = record
        .mods
        .iter()
        .find(|held| held.id == manifest.id && held.complete)
        .cloned();
    let upgrading = is_same_install(&record, install, manifest);
    if !upgrading && let Some(refusal) = conflict_for(platform, install, release) {
        return Err(Error::Unsupported(refusal));
    }

    // The user's files, before anything runs: copied to the timestamped backup as every destructive
    // path here does, and held in memory because the installer is about to write over them. A base mod
    // deploys its own sfall and hi-res patch, so without this an install would reset two of ZAX's
    // settings tabs.
    let backup = backup_directory(platform).join(stamp(now));
    let declared: Vec<String> = CONFIG_FILES.iter().map(|one| (*one).to_owned()).collect();
    let here = hold_user_files(platform, root, &declared, &backup)?;
    // A retry after an installer that never returned finds that installer's copies in the folder, so
    // the files the first attempt held are the user's, not these.
    let mine = match record
        .mods
        .iter()
        .find(|held| held.id == manifest.id && !held.complete && !held.before.is_empty())
    {
        Some(unfinished) => unfinished
            .before
            .iter()
            .map(|(path, text)| (path.clone(), zax_core::text::latin1_bytes(text)))
            .collect(),
        None => here,
    };

    // Before the payload lands, and on a first install only: what arrives with the mod is spelled the
    // way the mod spells it, and `mods/AmmoGlovz.ini` is upstream's file rather than something to
    // rename.
    let mut renamed = 0;
    if !upgrading && case_sensitive_at(platform, root)? {
        options.step("Lowercasing the game folder");
        renamed = lowercase_tree(platform, root)?.len();
    }

    let pending = InstalledMod {
        id: manifest.id.clone(),
        version: manifest.version.clone(),
        mod_type: Some(ModType::Base),
        reason: manifest.reason.clone(),
        complete: false,
        // Empty on purpose, and not an omission: the installer decides what lands, so a list here would
        // be invented. It is also what makes a base mod unremovable in fact as well as by its type.
        files: Vec::new(),
        entries: Vec::new(),
        parts: Vec::new(),
        manifest: release.manifest_text.clone(),
        shipped: BTreeMap::new(),
        before: mine
            .iter()
            .map(|(path, bytes)| (path.clone(), zax_core::text::latin1(bytes)))
            .collect(),
        carried: BTreeMap::new(),
    };
    save_record(platform, &with_base(&record, &pending))?;

    let work = mod_work_directory(platform, install, &manifest.id);
    let at = work.join(&asset.name);
    options.step(&format!(
        "Installing {} {}",
        manifest.name, manifest.version
    ));

    // The claim passes to the installer the moment it starts, because from here the installer is the
    // writer and it is the one that outlives ZAX. A claim still naming ZAX is the state this improves
    // on rather than a worse one, so a hand-over that fails is not the failure to report.
    let program: PathBuf;
    let args: Vec<String>;
    if route == InstallerRoute::Other {
        // The payload is the install: `rpu-install.sh` works in the directory it sits in, so extracting
        // over the game directory is most of what the mod does, and the script finishes it.
        platform
            .archive()
            .extract(&at, root, &ExtractOptions::default())?;
        // Unreachable while the route came from the manifest this release carries; kept because the two
        // are resolved apart, and a route without its script is not something to half-run.
        let Some(run) = manifest
            .installer
            .as_ref()
            .and_then(|held| held.other.as_ref())
            .map(|other| other.run.clone())
        else {
            return Err(Error::Unsupported(format!(
                "{} names no installer script for this system.",
                manifest.name
            )));
        };
        program = inside_path(root, &run);
        // A script out of an archive may arrive without its mode, and one that cannot be executed is an
        // install that cannot happen. Run directly rather than through a named shell: its own shebang
        // picks the interpreter, and nothing here has to guess where that interpreter lives.
        platform.fs().make_executable(&program)?;
        args = Vec::new();
    } else {
        program = at.clone();
        args = inno_arguments(&install.path, &work.join("installer.log"));
    }

    let named = program.display().to_string();
    let hold = move |pid: u32| {
        let _ = lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .hand_over(platform, pid, &named);
    };
    let outcome = platform.process().run(
        &program,
        &args,
        &LaunchOptions {
            cwd: Some(root.to_path_buf()),
            on_start: Some(&hold),
            ..LaunchOptions::default()
        },
    )?;

    let installer_backup = inside_path(root, "backup");
    if outcome.code != Some(0) {
        // Cancelling is an answer, not a fault, so it is said as one - and only for the route whose
        // exit codes mean this. Before the install began, the record of an install that never started
        // goes with it: leaving one would have the next run offer to resume something the user
        // declined, over a folder holding none of it. Cancelled part way through falls through to the
        // sentence below, which is exactly what happened.
        if route == InstallerRoute::Windows && outcome.code == Some(INNO_CANCELLED_BEFORE) {
            let written = load_record(platform, &install.path)?;
            save_record(platform, &without_base(&written, &manifest.id))?;
            return Err(Error::Unsupported(format!(
                "{}'s installer was cancelled, so nothing of it was installed.",
                manifest.name
            )));
        }
        let cancelled =
            route == InstallerRoute::Windows && outcome.code == Some(INNO_CANCELLED_DURING);
        let how = if cancelled {
            "was cancelled part way through".to_owned()
        } else {
            match outcome.code {
                Some(code) => format!("stopped with code {code}"),
                None => "stopped with no exit code".to_owned(),
            }
        };
        let said = if cancelled || outcome.output.trim().is_empty() {
            String::new()
        } else {
            let tail: Vec<&str> = outcome.output.trim().lines().rev().take(3).collect();
            let tail: Vec<&str> = tail.into_iter().rev().collect();
            format!(" It said: {}", tail.join(" "))
        };
        // Reported, not unwound. What ZAX can say is how far it got and where the installer put what it
        // moved.
        return Err(Error::Unsupported(format!(
            "{}'s installer {how}. The game folder is part way through the install and ZAX cannot \
             undo it - what the installer moved aside is under {}.{said}",
            manifest.name,
            installer_backup.display()
        )));
    }

    // After the installer rather than before it, which is the one thing that differs from a stacking
    // mod: the installer owns writing these files, so the user's values go back in once it has written
    // them.
    // The record holds what the last release shipped as latin1 text, which is the encoding the game's
    // own files are read in; the merge works on bytes.
    let base = previous.as_ref().map(|held| {
        held.shipped
            .iter()
            .map(|(path, text)| (path.clone(), zax_core::text::latin1_bytes(text)))
            .collect::<BTreeMap<String, Vec<u8>>>()
    });
    let merged = merge_user_files(platform, root, &declared, &mine, base.as_ref())?;

    let written = load_record(platform, &install.path)?;
    let done = InstalledMod {
        complete: true,
        shipped: merged
            .shipped
            .iter()
            .map(|(path, bytes)| (path.clone(), zax_core::text::latin1(bytes)))
            .collect(),
        before: BTreeMap::new(),
        ..pending
    };
    save_record(platform, &with_base(&written, &done))?;
    platform.fs().remove(&work)?;
    Ok(BaseInstallOutcome {
        version: manifest.version.clone(),
        becomes,
        renamed,
        conflicts: merged.conflicts,
        backup: installer_backup,
    })
}

/// The record with this mod's entry replaced. The rest is carried, so the entries this version could
/// not read survive an install of something else entirely.
fn with_base(record: &InstallRecord, held: &InstalledMod) -> InstallRecord {
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

/// The same record with this mod's entry gone - what a cancelled install leaves, having deployed
/// nothing.
fn without_base(record: &InstallRecord, id: &str) -> InstallRecord {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::{ManifestDefaults, parse_manifest};
    use crate::mod_feed::{ReleaseAsset, ReleaseInstaller};
    use zax_platform::memory::{Content, MemoryOptions, MemoryPlatform};
    use zax_platform::process::RunOutcome;
    use zax_platform::{Architecture, OperatingSystem};

    const SCRIPT_URL: &str = "https://example/upu.zip";
    const EXE_URL: &str = "https://example/upu-setup.exe";
    const WORK: &str = "/home/tester/.cache/zax/tmp/mod-";

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
            "spec: 1\nid: upu\nname: UPU\nversion: 1.0\ngame: fallout2\ntype: base\n\
             becomes: fallout2upu\n{extra}"
        )
    }

    fn digest(platform: &MemoryPlatform, payload: &str) -> String {
        let at = Path::new("/tmp/probe");
        platform
            .fs()
            .write(at, payload.as_bytes())
            .expect("a file the test writes");
        format!("sha256:{}", platform.hash().sha256(at).expect("a digest"))
    }

    fn release(
        platform: &MemoryPlatform,
        extra: &str,
        route: InstallerRoute,
        name: &str,
        url: &str,
        payload: &str,
    ) -> ModRelease {
        let text = manifest_text(extra);
        ModRelease {
            manifest: parse_manifest(text.as_bytes(), &ManifestDefaults::default())
                .expect("a manifest the test writes"),
            manifest_text: text,
            archive: None,
            parts: BTreeMap::new(),
            installer: Some(ReleaseInstaller {
                route,
                asset: ReleaseAsset {
                    name: name.to_owned(),
                    url: url.to_owned(),
                    digest: Some(digest(platform, payload)),
                    size: Some(payload.len() as u64),
                },
            }),
            installer_route: Some(route),
            line: None,
        }
    }

    /// The payload route: a zip holding the script that finishes the install.
    fn script_host(files: &[(&str, &str)], code: Option<i32>, output: &str) -> MemoryPlatform {
        MemoryPlatform::new(host_options(files, code, output))
    }

    fn host_options(files: &[(&str, &str)], code: Option<i32>, output: &str) -> MemoryOptions {
        MemoryOptions {
            os: Some(OperatingSystem::Linux),
            arch: Some(Architecture::X64),
            files: files
                .iter()
                .map(|(path, text)| ((*path).to_owned(), Content::from(*text)))
                .collect(),
            // The game folder itself, which the install lock is claimed inside.
            dirs: vec!["/games/f2".to_owned()],
            downloads: BTreeMap::from([(SCRIPT_URL.to_owned(), Content::from("payload"))]),
            archives: BTreeMap::from([(
                "payload".to_owned(),
                BTreeMap::from([("upu-install.sh".to_owned(), Content::from("#!/bin/sh\n"))]),
            )]),
            runs: BTreeMap::from([(
                "/games/f2/upu-install.sh".to_owned(),
                RunOutcome {
                    code,
                    output: output.to_owned(),
                },
            )]),
            ..MemoryOptions::default()
        }
    }

    fn script_release(platform: &MemoryPlatform) -> ModRelease {
        release(
            platform,
            "installer.other.run: upu-install.sh\n",
            InstallerRoute::Other,
            "upu.zip",
            SCRIPT_URL,
            "payload",
        )
    }

    /// The Windows route: an installer program ZAX runs and does not read.
    fn inno_host(code: Option<i32>) -> MemoryPlatform {
        MemoryPlatform::new(MemoryOptions {
            os: Some(OperatingSystem::Windows),
            arch: Some(Architecture::X64),
            dirs: vec!["/games/f2".to_owned()],
            downloads: BTreeMap::from([(EXE_URL.to_owned(), Content::from("setup"))]),
            runs: BTreeMap::from([(
                format!("{WORK}{}-upu/upu-setup.exe", install_key()),
                RunOutcome {
                    code,
                    output: String::new(),
                },
            )]),
            ..MemoryOptions::default()
        })
    }

    fn install_key() -> String {
        crate::records::install_key("/games/f2")
    }

    fn inno_release(platform: &MemoryPlatform) -> ModRelease {
        release(
            platform,
            "installer.windows.built-with: inno\n",
            InstallerRoute::Windows,
            "upu-setup.exe",
            EXE_URL,
            "setup",
        )
    }

    /// The real flow: the plan downloads and verifies the asset, then the install runs it.
    fn applied(platform: &MemoryPlatform, release: &ModRelease) -> Result<BaseInstallOutcome> {
        plan_base_install(platform, &install(), release, &ModProgress::default())?;
        apply_base_install(
            platform,
            &install(),
            release,
            &ModProgress::default(),
            now(),
            1_700_000_000_000,
        )
    }

    fn recorded(platform: &MemoryPlatform) -> Option<InstalledMod> {
        load_record(platform, "/games/f2")
            .expect("a record")
            .mods
            .into_iter()
            .find(|one| one.id == "upu")
    }

    #[test]
    fn a_manifest_that_is_not_a_base_mods_is_refused() {
        let platform = script_host(&[], Some(0), "");
        let text = "spec: 1\nid: ecco\nname: EcCo\nversion: 1.0\ngame: fallout2\n\
                    type: pluggable\narchive: ecco.zip\n";
        let manifest = parse_manifest(text.as_bytes(), &ManifestDefaults::default())
            .expect("a manifest the test writes");
        let stacking = ModRelease {
            manifest,
            manifest_text: text.to_owned(),
            ..script_release(&platform)
        };
        let err = plan_base_install(&platform, &install(), &stacking, &ModProgress::default())
            .expect_err("not a base mod");
        assert!(format!("{err}").contains("is not a base mod"), "{err}");
    }

    #[test]
    fn a_release_with_no_installer_for_this_host_says_which_kind_of_miss_it_is() {
        let platform = script_host(&[], Some(0), "");
        let held = script_release(&platform);
        let nothing = ModRelease {
            installer: None,
            installer_route: None,
            ..held
        };
        let err = plan_base_install(&platform, &install(), &nothing, &ModProgress::default())
            .expect_err("no installer");
        assert!(
            format!("{err}").contains("does not install on this system"),
            "{err}"
        );
    }

    #[test]
    fn the_plan_reads_what_the_payload_unpacks_to() {
        // An installer program is opaque until it runs; a payload has a directory to read.
        let platform = script_host(&[], Some(0), "");
        let plan = plan_base_install(
            &platform,
            &install(),
            &script_release(&platform),
            &ModProgress::default(),
        )
        .expect("a plan");
        assert_eq!(plan.route, InstallerRoute::Other);
        assert_eq!(plan.unpacked, Some("#!/bin/sh\n".len() as u64));
        assert_eq!(plan.becomes, GameType::Fallout2Upu);
        assert_eq!(plan.download, "payload".len() as u64);
    }

    #[test]
    fn an_installer_program_has_no_directory_to_read() {
        let platform = inno_host(Some(0));
        let plan = plan_base_install(
            &platform,
            &install(),
            &inno_release(&platform),
            &ModProgress::default(),
        )
        .expect("a plan");
        assert_eq!(plan.route, InstallerRoute::Windows);
        assert_eq!(plan.unpacked, None);
    }

    #[test]
    fn the_manifests_own_conditions_refuse_before_a_byte_is_spent() {
        let platform = script_host(
            &[("/games/f2/mods/rpu.dat", "somebody else's")],
            Some(0),
            "",
        );
        let held = release(
            &platform,
            "installer.other.run: upu-install.sh\nconflicts:\n  - present: [mods/rpu.dat]\n    \
             reason: RPU is already installed here\n",
            InstallerRoute::Other,
            "upu.zip",
            SCRIPT_URL,
            "payload",
        );
        let err = plan_base_install(&platform, &install(), &held, &ModProgress::default())
            .expect_err("a clash");
        assert!(
            format!("{err}").contains("RPU is already installed"),
            "{err}"
        );
        assert!(
            platform.records().downloaded.is_empty(),
            "nothing may be downloaded before the refusal"
        );
    }

    #[test]
    fn an_upgrade_is_not_refused_by_the_rules_its_own_install_now_satisfies() {
        // UPU refuses over `mods/upu.dat`, which is the file UPU put there.
        let platform = script_host(&[("/games/f2/mods/upu.dat", "ours")], Some(0), "");
        let held = release(
            &platform,
            "installer.other.run: upu-install.sh\nconflicts:\n  - present: [mods/upu.dat]\n    \
             reason: something else installed this already\n",
            InstallerRoute::Other,
            "upu.zip",
            SCRIPT_URL,
            "payload",
        );
        // The installation already reports the type this mod makes, which is what an upgrade is.
        let upgrading = Install::new("/games/f2", GameType::Fallout2Upu);
        assert!(
            plan_base_install(&platform, &upgrading, &held, &ModProgress::default()).is_ok(),
            "an upgrade must not be refused by its own install"
        );
    }

    #[test]
    fn the_payload_route_extracts_runs_the_script_and_records_the_install() {
        let platform = script_host(&[], Some(0), "");
        let done = applied(&platform, &script_release(&platform)).expect("an install");
        assert_eq!(done.version, "1.0");
        assert_eq!(done.becomes, GameType::Fallout2Upu);
        assert_eq!(done.backup, PathBuf::from("/games/f2/backup"));
        // The extraction over the game folder is most of the install; the script finishes it.
        assert_eq!(
            platform
                .fs()
                .read(Path::new("/games/f2/upu-install.sh"))
                .expect("a read"),
            b"#!/bin/sh\n"
        );
        let ran = platform.records().ran;
        assert_eq!(ran.len(), 1);
        assert_eq!(ran[0].program, PathBuf::from("/games/f2/upu-install.sh"));
        assert!(
            platform
                .records()
                .executable
                .contains(&"/games/f2/upu-install.sh".to_owned()),
            "a script without its mode is an install that cannot happen"
        );
        let held = recorded(&platform).expect("a record entry");
        assert!(held.complete);
        // Empty on purpose: the installer decides what lands.
        assert!(held.files.is_empty());
    }

    #[test]
    fn the_users_settings_survive_the_installer_writing_over_them() {
        // A base mod deploys its own sfall and hi-res patch.
        let platform = script_host(&[("/games/f2/ddraw.ini", "[Misc]\nA=1\n")], Some(0), "");
        applied(&platform, &script_release(&platform)).expect("an install");
        let held = platform
            .fs()
            .read(Path::new("/games/f2/ddraw.ini"))
            .expect("a read");
        assert!(
            String::from_utf8_lossy(&held).contains("A=1"),
            "{}",
            String::from_utf8_lossy(&held)
        );
        // And a copy went to the timestamped backup, as every destructive path here does.
        let kept = backup_directory(&platform)
            .join(stamp(now()))
            .join("ddraw.ini");
        assert_eq!(platform.fs().read(&kept).expect("a read"), b"[Misc]\nA=1\n");
    }

    #[test]
    fn the_version_the_installer_stamps_stands_over_the_one_it_replaced() {
        // An install ZAX has no record of - one upstream's own installer made - has no base to merge
        // against, so without this the user's copy would put the old release's stamp back.
        let mut options = host_options(
            &[(
                "/games/f2/ddraw.ini",
                "[Misc]\nVersionString=FALLOUT II 1.02.33\nA=1\n",
            )],
            Some(0),
            "",
        );
        options.archives = BTreeMap::from([(
            "payload".to_owned(),
            BTreeMap::from([
                ("upu-install.sh".to_owned(), Content::from("#!/bin/sh\n")),
                (
                    "ddraw.ini".to_owned(),
                    Content::from("[Misc]\nVersionString=FALLOUT II 1.02.34\nA=0\n"),
                ),
            ]),
        )]);
        let platform = MemoryPlatform::new(options);
        applied(&platform, &script_release(&platform)).expect("an install");
        let after = platform.text_at("/games/f2/ddraw.ini").expect("a file");
        assert!(
            after.contains("VersionString=FALLOUT II 1.02.34"),
            "{after}"
        );
        // The rest is still the user's.
        assert!(after.contains("A=1"), "{after}");
    }

    #[test]
    fn an_installer_that_stops_says_how_far_it_got_and_where_the_backup_is() {
        let platform = script_host(&[], Some(3), "could not write data/\n");
        let err = applied(&platform, &script_release(&platform)).expect_err("a failure");
        let said = format!("{err}");
        assert!(said.contains("stopped with code 3"), "{said}");
        // Joined rather than spelled out: the message carries the path the host built, and a Windows
        // host builds it with `\`.
        let backup = std::path::Path::new("/games/f2").join("backup");
        assert!(said.contains(&backup.display().to_string()), "{said}");
        assert!(said.contains("could not write data/"), "{said}");
        // Reported, not unwound - and the unfinished record says a run started here.
        let held = recorded(&platform).expect("a record entry");
        assert!(!held.complete);
    }

    #[test]
    fn a_retry_puts_back_the_settings_from_before_the_first_attempt() {
        // The first attempt stops part way and leaves the installer's own `ddraw.ini` behind, which is
        // also what a relaunch finds after ZAX was closed while its installer ran.
        let first = script_host(&[("/games/f2/ddraw.ini", "[Misc]\nA=1\n")], Some(3), "");
        applied(&first, &script_release(&first)).expect_err("a failure");
        let files: Vec<(String, String)> = first
            .all_files()
            .into_iter()
            .map(|path| {
                let text = if path == "/games/f2/ddraw.ini" {
                    "[Misc]\nA=0\n".to_owned()
                } else {
                    first.text_at(&path).unwrap_or_default()
                };
                (path, text)
            })
            .collect();
        let carried: Vec<(&str, &str)> = files
            .iter()
            .map(|(path, text)| (path.as_str(), text.as_str()))
            .collect();

        let retry = script_host(&carried, Some(0), "");
        applied(&retry, &script_release(&retry)).expect("the retry");
        let after = retry.text_at("/games/f2/ddraw.ini").expect("a file");
        assert!(after.contains("A=1"), "{after}");
        let held = recorded(&retry).expect("a record entry");
        assert!(held.complete);
        assert!(
            held.before.is_empty(),
            "a finished install holds nothing back"
        );
    }

    #[test]
    fn a_wizard_cancelled_before_it_began_leaves_no_record_to_resume() {
        // Leaving one would have the next run offer to resume something the user declined.
        let platform = inno_host(Some(INNO_CANCELLED_BEFORE));
        let err = applied(&platform, &inno_release(&platform)).expect_err("cancelled");
        assert!(
            format!("{err}").contains("nothing of it was installed"),
            "{err}"
        );
        assert_eq!(recorded(&platform), None);
    }

    #[test]
    fn a_wizard_cancelled_part_way_through_leaves_the_record_it_wrote() {
        let platform = inno_host(Some(INNO_CANCELLED_DURING));
        let err = applied(&platform, &inno_release(&platform)).expect_err("cancelled");
        assert!(
            format!("{err}").contains("cancelled part way through"),
            "{err}"
        );
        assert!(!recorded(&platform).expect("a record entry").complete);
    }

    #[test]
    fn those_exit_codes_mean_nothing_on_the_other_route() {
        // They are upstream's shell script's to define there.
        let platform = script_host(&[], Some(INNO_CANCELLED_BEFORE), "");
        let err = applied(&platform, &script_release(&platform)).expect_err("a failure");
        assert!(format!("{err}").contains("stopped with code 2"), "{err}");
        assert!(
            recorded(&platform).is_some(),
            "the record stays for a retry"
        );
    }

    #[test]
    fn the_wizard_is_aimed_at_this_install_and_left_to_decide_the_rest() {
        let args = inno_arguments("/games/f2", Path::new("/cache/installer.log"));
        assert_eq!(
            args,
            ["/DIR=/games/f2", "/LOG=/cache/installer.log", "/NORESTART"]
        );
        // Naming components would mean holding a copy of upstream's component tree.
        assert!(
            !args.iter().any(|one| one.contains("COMPONENTS")),
            "{args:?}"
        );
        assert!(!args.iter().any(|one| one.contains("SILENT")), "{args:?}");
    }

    #[test]
    fn a_directory_already_claimed_is_not_installed_into() {
        // An installer from a run that never finished is the one writer nothing else here can see.
        let mut platform = script_host(&[], Some(0), "");
        // The claim below names this process; a lock whose owner is gone is one to take over, so the
        // host has to say the owner is still running for the refusal to be the one under test.
        let pid = platform.process().identity().pid;
        platform = MemoryPlatform::new(MemoryOptions {
            live_pids: vec![pid],
            ..host_options(&[], Some(0), "")
        });
        let claim = take_install_lock(
            &platform,
            Path::new("/games/f2"),
            "Something else",
            1_700_000_000_000,
        )
        .expect("a claim");
        assert!(matches!(claim, Claim::Taken(_)));
        let err = applied(&platform, &script_release(&platform)).expect_err("already claimed");
        assert!(format!("{err}").contains("Something else"), "{err}");
    }

    #[test]
    fn the_claim_is_released_however_the_install_ends() {
        let platform = script_host(&[], Some(3), "");
        applied(&platform, &script_release(&platform)).expect_err("a failure");
        // A second attempt claims the directory, which a lock left behind would refuse.
        let again = take_install_lock(
            &platform,
            Path::new("/games/f2"),
            "Another go",
            1_700_000_000_000,
        )
        .expect("a claim");
        assert!(matches!(again, Claim::Taken(_)), "{again:?}");
    }

    #[test]
    fn the_working_directory_goes_only_once_the_install_has_finished() {
        let platform = script_host(&[], Some(0), "");
        let work = mod_work_directory(&platform, &install(), "upu");
        applied(&platform, &script_release(&platform)).expect("an install");
        assert_eq!(platform.fs().stat(&work).expect("a read"), None);

        // A failure keeps it, so a retry resumes rather than paying the download again.
        let failing = script_host(&[], Some(3), "");
        applied(&failing, &script_release(&failing)).expect_err("a failure");
        assert!(
            failing
                .fs()
                .stat(&mod_work_directory(&failing, &install(), "upu"))
                .expect("a read")
                .is_some()
        );
    }
}

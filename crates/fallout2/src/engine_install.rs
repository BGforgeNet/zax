//! Putting an engine into a game folder, replacing it with a newer build, and taking it out again.
//!
//! The shape is the sfall updater's with the merge removed - an engine ships no settings file to merge:
//! back up what is about to be replaced, unpack, copy the declared members in, record what was done.

use std::path::{Path, PathBuf};

use zax_core::directories::{backup_directory, temporary_directory};
use zax_core::fs::copy_tree;
use zax_core::install::Install;
use zax_core::stamp::{LocalTime, stamp};
use zax_platform::archive::ExtractOptions;
use zax_platform::fs::{FileKind, FileStat};
use zax_platform::{Error, Platform, Result};

use crate::archive_preflight::preflight_archive;
use crate::engine_release::engine_named;
use crate::engine_release::{CachedEngine, EngineProgress, EngineRelease, cached_engines};
use crate::engines::{EngineBuild, EngineDefinition, EngineMember, build_for};
use crate::records::{
    InstallRecord, InstalledEngine, assert_usable, load_record, reconcile_record, save_record,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineInstallOutcome {
    pub engine: String,
    pub release: String,
    pub published: String,
    /// What was deployed, relative to the install.
    pub files: Vec<String>,
    /// Which of those were already there, and so were copied aside first.
    pub replaced: Vec<String>,
    pub backup: Option<PathBuf>,
}

/// Which build a folder is being asked to hold: one release by its publication instant, or nothing for
/// the newest the machine has.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineChoice {
    pub published: Option<String>,
    pub pin: bool,
}

/// What the record says is here, judged against the directory - the same reconciliation the mods get.
///
/// # Errors
///
/// Fails where the record cannot be read.
pub fn installed_engines(
    platform: &dyn Platform,
    install: &Install,
) -> Result<Vec<InstalledEngine>> {
    let record = reconcile_record(platform, &load_record(platform, &install.path)?)?;
    Ok(record.engines)
}

/// The record with this engine's entry replaced by `entry`, or removed when there is none.
fn with_engine(
    engines: &[InstalledEngine],
    id: &str,
    entry: Option<InstalledEngine>,
) -> Vec<InstalledEngine> {
    let mut others: Vec<InstalledEngine> =
        engines.iter().filter(|one| one.id != id).cloned().collect();
    others.extend(entry);
    others
}

/// Runs `action`, discarding the cached archive first when it fails - a cache keyed on existence would
/// otherwise fail preflight, or extraction, the same way on every attempt after this one.
fn or_discard<T>(
    platform: &dyn Platform,
    archive: &Path,
    action: impl FnOnce() -> Result<T>,
) -> Result<T> {
    action().inspect_err(|_| {
        // The failure being reported is the one worth seeing; a removal that also fails changes
        // nothing about it.
        let _ = platform.fs().remove(archive);
    })
}

/// Installs from a release the cache already holds, without asking the network anything. One machine
/// downloads an engine once; a second game folder is the same archive unpacked again, which is what
/// makes running an engine in a folder that has never had one a copy rather than a download.
///
/// # Errors
///
/// Fails where the project publishes no build for this machine, where the cache holds none, or where
/// the deployment itself fails.
pub fn install_cached_engine(
    platform: &dyn Platform,
    install: &Install,
    engine_id: &str,
    choice: &EngineChoice,
    now: LocalTime,
    options: &EngineProgress<'_>,
) -> Result<EngineInstallOutcome> {
    let engine = engine_named(engine_id)?;
    let Some(build) = build_for(engine, platform.os(), platform.arch()) else {
        return Err(Error::Unsupported(format!(
            "{} publishes no build ZAX can install for this machine. See {}.",
            engine.name, engine.page
        )));
    };
    let cached = cached_engines(platform, engine, build.asset)?;
    let held: Option<CachedEngine> = match &choice.published {
        None => cached.into_iter().next(),
        Some(at) => cached.into_iter().find(|one| one.release.published == *at),
    };
    let Some(held) = held else {
        return Err(Error::Unsupported(format!(
            "ZAX has no copy of {} to install from. Check for one first.",
            engine.name
        )));
    };
    deploy_engine(
        platform,
        install,
        engine,
        build,
        &held.release,
        &held.archive,
        choice.pin,
        now,
        options,
    )
}

/// One declared member found inside the unpacked release.
struct Resolved<'a> {
    member: &'a EngineMember,
    source: PathBuf,
    found: FileStat,
}

/// Unpacking an archive over a game folder and recording what that put there. Shared by the two ways a
/// release is arrived at - asking the project, or finding it already cached - because only how the
/// archive was obtained differs, and a second copy of this is a second place for the backup and the
/// record to drift.
#[expect(
    clippy::too_many_arguments,
    reason = "every argument names one thing the deployment cannot derive: which engine, which of \
              its builds, which release, where the archive is, and whether the user picked it"
)]
pub fn deploy_engine(
    platform: &dyn Platform,
    install: &Install,
    engine: &EngineDefinition,
    build: &EngineBuild,
    release: &EngineRelease,
    archive: &Path,
    pin: bool,
    now: LocalTime,
    options: &EngineProgress<'_>,
) -> Result<EngineInstallOutcome> {
    let at = stamp(now);
    let work = temporary_directory(platform).join(format!("engine-{}-{at}", engine.id));
    let outcome = deploy_into(
        platform, install, engine, build, release, archive, pin, &at, &work, options,
    );
    // The working copy goes whether the deployment finished or not; its failure is not the one to
    // report.
    let _ = platform.fs().remove(&work);
    outcome
}

#[expect(
    clippy::too_many_arguments,
    reason = "the body of `deploy_engine`, split out so the working directory is removed on every \
              path without the whole deployment sitting inside a cleanup arm"
)]
fn deploy_into(
    platform: &dyn Platform,
    install: &Install,
    engine: &EngineDefinition,
    build: &EngineBuild,
    release: &EngineRelease,
    archive: &Path,
    pin: bool,
    at: &str,
    work: &Path,
    options: &EngineProgress<'_>,
) -> Result<EngineInstallOutcome> {
    // Judged before it is opened: this is a third-party archive about to be unpacked over a game
    // folder.
    let entries = or_discard(platform, archive, || {
        preflight_archive(
            platform,
            archive,
            &format!("{} {}", engine.name, release.release),
        )
    })?;

    // `None` where the host cannot say - a check that cannot run is not a check that failed.
    //
    // Both drives, because the release lands on both: the whole archive is unpacked into ZAX's cache,
    // and the build's own files are then copied into the game folder. On most machines those are not
    // the same drive, and the cache is the one asked to hold everything.
    let needed: u64 = entries.iter().map(|entry| entry.size).sum();
    let refuse_if_short = |where_: &Path| -> Result<()> {
        match platform.fs().free_space(where_)? {
            Some(drive) if drive < needed => Err(Error::Unsupported(format!(
                "{} {} needs {needed} bytes unpacked, and the drive holding {} has {drive}.",
                engine.name,
                release.release,
                where_.display()
            ))),
            _ => Ok(()),
        }
    };
    platform.fs().mkdir(work)?;
    refuse_if_short(work)?;
    refuse_if_short(Path::new(&install.path))?;

    options.step(&format!("Unpacking {}", engine.name));
    or_discard(platform, archive, || {
        platform
            .archive()
            .extract(archive, work, &ExtractOptions::default())
    })?;

    options.step(&format!("Installing {}", engine.name));
    let backup = backup_directory(platform).join(at);
    let mut replaced: Vec<String> = Vec::new();
    let mut files: Vec<String> = Vec::new();

    // Written before anything is deployed and marked complete after, so a crash leaves a record saying
    // so rather than one that reads as a good copy of a release nobody can identify.
    let record = load_record(platform, &install.path)?;
    let entry = InstalledEngine {
        id: engine.id.to_owned(),
        release: release.release.clone(),
        published: release.published.clone(),
        complete: false,
        files: build
            .members
            .iter()
            .map(|member| member.to.to_owned())
            .collect(),
        backup: None,
        commit: release.commit.clone(),
        // Written here as well as on the finished entry: a crash between the two must not leave the
        // folder silently following the newest build again when the user had picked this one.
        pinned: pin,
    };
    save_record(
        platform,
        &InstallRecord {
            engines: with_engine(&record.engines, engine.id, Some(entry.clone())),
            ..record
        },
    )?;

    // Checked whole before anything is written: a release missing one declared member must fail
    // without having already moved the user's original aside for the members that were there.
    let mut resolved: Vec<Resolved<'_>> = Vec::new();
    for member in build.members {
        let source = join_archive_path(work, member.from);
        let Some(found) = platform.fs().stat(&source)? else {
            return Err(Error::Unsupported(format!(
                "The {} release does not contain {} - its layout has changed, and ZAX will not \
                 guess where that went.",
                engine.name, member.from
            )));
        };
        resolved.push(Resolved {
            member,
            source,
            found,
        });
    }

    for one in &resolved {
        let destination = join_archive_path(Path::new(&install.path), one.member.to);
        if let Some(existing) = platform.fs().stat(&destination)? {
            let keep = join_archive_path(&backup, one.member.to);
            if existing.kind == FileKind::Dir {
                copy_tree(platform, &destination, &keep)?;
                // Removed rather than left for `copy_tree` to merge into: it only ever adds files, so
                // a release that drops one from the bundle would otherwise leave the old copy behind
                // inside the new one.
                platform.fs().remove(&destination)?;
            } else {
                platform.fs().copy(&destination, &keep)?;
            }
            replaced.push(one.member.to.to_owned());
        }
        if one.found.kind == FileKind::Dir {
            copy_tree(platform, &one.source, &destination)?;
        } else {
            platform.fs().copy(&one.source, &destination)?;
        }
        files.push(one.member.to.to_owned());
    }

    // A binary that arrived inside an archive may arrive without its mode, and an engine that cannot
    // be executed is an install that did not happen.
    platform
        .fs()
        .make_executable(&join_archive_path(Path::new(&install.path), build.program))?;

    let done = InstalledEngine {
        complete: true,
        backup: (!replaced.is_empty()).then(|| backup.to_string_lossy().into_owned()),
        ..entry
    };
    let written = load_record(platform, &install.path)?;
    save_record(
        platform,
        &InstallRecord {
            engines: with_engine(&written.engines, engine.id, Some(done)),
            ..written
        },
    )?;

    Ok(EngineInstallOutcome {
        engine: engine.id.to_owned(),
        release: release.release.clone(),
        published: release.published.clone(),
        files,
        backup: (!replaced.is_empty()).then(|| backup.clone()),
        replaced,
    })
}

/// A `/`-separated path from inside an archive, joined onto a host path one segment at a time so the
/// host's own separator is what lands on disk.
fn join_archive_path(root: &Path, path: &str) -> PathBuf {
    let mut out = root.to_path_buf();
    for segment in path.split('/') {
        out.push(segment);
    }
    out
}

/// Sets or clears the pin on the build already deployed here, touching no file. What picking the build
/// that is in place amounts to, and what picking latest undoes.
///
/// # Errors
///
/// Fails where the record cannot be read or written, or where it is one this version may not write.
pub fn pin_engine(
    platform: &dyn Platform,
    install: &Install,
    engine_id: &str,
    pin: bool,
) -> Result<()> {
    let record = load_record(platform, &install.path)?;
    assert_usable(&record, engine_id)?;
    let Some(entry) = record.engines.iter().find(|one| one.id == engine_id) else {
        return Ok(());
    };
    let updated = InstalledEngine {
        pinned: pin,
        ..entry.clone()
    };
    save_record(
        platform,
        &InstallRecord {
            engines: with_engine(&record.engines, engine_id, Some(updated)),
            ..record.clone()
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine_release::EngineAsset;
    use crate::engines::engine_by_id;
    use std::collections::BTreeMap;
    use zax_core::install::GameType;
    use zax_platform::memory::{Content, MemoryOptions, MemoryPlatform};
    use zax_platform::{Architecture, OperatingSystem};

    const CE: &str = "fallout2-ce";
    const CACHE: &str = "/home/tester/.cache/zax/packages/engines/fallout2-ce/20240102030405";
    const ARCHIVE: &str = "fallout2-ce-linux-x64.tar.gz";

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

    /// The release's own layout, which the build's members name.
    fn payload() -> BTreeMap<String, Content> {
        BTreeMap::from([
            (
                "fallout2-ce-linux-x64/fallout2-ce".to_owned(),
                Content::from("elf"),
            ),
            (
                "fallout2-ce-linux-x64/ce.dat".to_owned(),
                Content::from("dat"),
            ),
        ])
    }

    fn cached(files: &[(&str, &str)], contents: BTreeMap<String, Content>) -> MemoryPlatform {
        let note = r#"{"release":"continious","published":"2024-01-02T03:04:05Z"}"#;
        let mut held = BTreeMap::from([
            (format!("{CACHE}/{ARCHIVE}"), Content::from("release")),
            (format!("{CACHE}/release.json"), Content::from(note)),
        ]);
        held.extend(
            files
                .iter()
                .map(|(path, text)| ((*path).to_owned(), Content::from(*text))),
        );
        MemoryPlatform::new(MemoryOptions {
            os: Some(OperatingSystem::Linux),
            arch: Some(Architecture::X64),
            files: held,
            archives: BTreeMap::from([("release".to_owned(), contents)]),
            ..MemoryOptions::default()
        })
    }

    fn choice() -> EngineChoice {
        EngineChoice {
            published: None,
            pin: false,
        }
    }

    #[test]
    fn a_folder_that_has_never_had_one_is_a_copy_rather_than_a_download() {
        let platform = cached(&[], payload());
        let done = install_cached_engine(
            &platform,
            &install(),
            CE,
            &choice(),
            now(),
            &EngineProgress::default(),
        )
        .expect("an install");
        assert_eq!(done.files, ["fallout2-ce", "ce.dat"]);
        assert!(done.replaced.is_empty());
        assert_eq!(done.backup, None);
        assert_eq!(
            platform
                .fs()
                .read(Path::new("/games/f2/fallout2-ce"))
                .expect("a read"),
            b"elf"
        );
    }

    #[test]
    fn what_was_already_there_is_copied_aside_first() {
        let platform = cached(&[("/games/f2/ce.dat", "the old one")], payload());
        let done = install_cached_engine(
            &platform,
            &install(),
            CE,
            &choice(),
            now(),
            &EngineProgress::default(),
        )
        .expect("an install");
        assert_eq!(done.replaced, ["ce.dat"]);
        let backup = done.backup.as_ref().expect("a backup directory");
        assert_eq!(
            platform.fs().read(&backup.join("ce.dat")).expect("a read"),
            b"the old one"
        );
        assert_eq!(
            platform
                .fs()
                .read(Path::new("/games/f2/ce.dat"))
                .expect("a read"),
            b"dat"
        );
    }

    #[test]
    fn a_release_missing_a_declared_member_moves_nothing_aside() {
        // Failing after the first member was replaced would leave the user's original in the backup
        // and a half-installed release in the folder.
        let mut short = payload();
        short.remove("fallout2-ce-linux-x64/ce.dat");
        let platform = cached(&[("/games/f2/fallout2-ce", "the old one")], short);
        let err = install_cached_engine(
            &platform,
            &install(),
            CE,
            &choice(),
            now(),
            &EngineProgress::default(),
        )
        .expect_err("a release with a changed layout");
        assert!(format!("{err}").contains("ce.dat"), "{err}");
        assert_eq!(
            platform
                .fs()
                .read(Path::new("/games/f2/fallout2-ce"))
                .expect("a read"),
            b"the old one",
            "nothing may be replaced before every member is found"
        );
    }

    #[test]
    fn the_record_says_a_crash_happened_rather_than_reading_as_a_good_copy() {
        let mut short = payload();
        short.remove("fallout2-ce-linux-x64/ce.dat");
        let platform = cached(&[], short);
        install_cached_engine(
            &platform,
            &install(),
            CE,
            &choice(),
            now(),
            &EngineProgress::default(),
        )
        .expect_err("a release with a changed layout");
        let record = load_record(&platform, "/games/f2").expect("a record");
        assert_eq!(record.engines.len(), 1);
        assert!(!record.engines[0].complete);
    }

    #[test]
    fn the_pin_survives_a_crash_between_the_two_writes() {
        // Otherwise the folder silently follows the newest build again when the user had picked one.
        let mut short = payload();
        short.remove("fallout2-ce-linux-x64/ce.dat");
        let platform = cached(&[], short);
        let pinned = EngineChoice {
            published: None,
            pin: true,
        };
        install_cached_engine(
            &platform,
            &install(),
            CE,
            &pinned,
            now(),
            &EngineProgress::default(),
        )
        .expect_err("a release with a changed layout");
        let record = load_record(&platform, "/games/f2").expect("a record");
        assert!(record.engines[0].pinned);
    }

    #[test]
    fn the_record_holds_one_entry_per_engine() {
        let platform = cached(&[], payload());
        for _ in 0..2 {
            install_cached_engine(
                &platform,
                &install(),
                CE,
                &choice(),
                now(),
                &EngineProgress::default(),
            )
            .expect("an install");
        }
        let record = load_record(&platform, "/games/f2").expect("a record");
        assert_eq!(record.engines.len(), 1);
        assert!(record.engines[0].complete);
    }

    #[test]
    fn a_release_the_cache_does_not_hold_is_refused() {
        let platform = cached(&[], payload());
        let asked = EngineChoice {
            published: Some("1999-01-01T00:00:00Z".to_owned()),
            pin: true,
        };
        let err = install_cached_engine(
            &platform,
            &install(),
            CE,
            &asked,
            now(),
            &EngineProgress::default(),
        )
        .expect_err("nothing cached");
        assert!(format!("{err}").contains("Check for one first"), "{err}");
    }

    #[test]
    fn a_machine_the_project_publishes_no_build_for_is_told_where_to_look() {
        let platform = MemoryPlatform::new(MemoryOptions {
            os: Some(OperatingSystem::MacOs),
            arch: Some(Architecture::Arm64),
            ..MemoryOptions::default()
        });
        let err = install_cached_engine(
            &platform,
            &install(),
            "fission",
            &choice(),
            now(),
            &EngineProgress::default(),
        )
        .expect_err("no build for this machine");
        assert!(format!("{err}").contains("cambragol/fission-ce"), "{err}");
    }

    #[test]
    fn the_engine_is_made_runnable() {
        // A binary that arrived inside an archive may arrive without its mode.
        let platform = cached(&[], payload());
        install_cached_engine(
            &platform,
            &install(),
            CE,
            &choice(),
            now(),
            &EngineProgress::default(),
        )
        .expect("an install");
        let marked = platform.records().executable;
        assert!(
            marked.contains(&"/games/f2/fallout2-ce".to_owned()),
            "{marked:?}"
        );
    }

    #[test]
    fn a_pin_can_be_set_and_cleared_without_touching_a_file() {
        let platform = cached(&[], payload());
        install_cached_engine(
            &platform,
            &install(),
            CE,
            &choice(),
            now(),
            &EngineProgress::default(),
        )
        .expect("an install");
        pin_engine(&platform, &install(), CE, true).expect("a pin");
        assert!(
            load_record(&platform, "/games/f2")
                .expect("a record")
                .engines[0]
                .pinned
        );
        pin_engine(&platform, &install(), CE, false).expect("a pin");
        assert!(
            !load_record(&platform, "/games/f2")
                .expect("a record")
                .engines[0]
                .pinned
        );
    }

    #[test]
    fn pinning_an_engine_the_folder_does_not_hold_changes_nothing() {
        let platform = cached(&[], payload());
        pin_engine(&platform, &install(), CE, true).expect("a pin");
        assert!(
            load_record(&platform, "/games/f2")
                .expect("a record")
                .engines
                .is_empty()
        );
    }

    #[test]
    fn what_the_record_says_is_judged_against_the_directory() {
        let platform = cached(&[], payload());
        install_cached_engine(
            &platform,
            &install(),
            CE,
            &choice(),
            now(),
            &EngineProgress::default(),
        )
        .expect("an install");
        let held = installed_engines(&platform, &install()).expect("a reconciliation");
        assert_eq!(held.len(), 1);
        assert_eq!(held[0].id, CE);
    }

    #[test]
    fn an_archive_that_will_not_open_is_thrown_away() {
        // A cache keyed on existence would fail the same way on every attempt after this one. The
        // archive is named by no `archives` entry, so opening it is what fails.
        let note = r#"{"release":"continious","published":"2024-01-02T03:04:05Z"}"#;
        let platform = MemoryPlatform::new(MemoryOptions {
            os: Some(OperatingSystem::Linux),
            arch: Some(Architecture::X64),
            files: BTreeMap::from([
                (
                    format!("{CACHE}/{ARCHIVE}"),
                    Content::from("not an archive"),
                ),
                (format!("{CACHE}/release.json"), Content::from(note)),
            ]),
            ..MemoryOptions::default()
        });
        let err = install_cached_engine(
            &platform,
            &install(),
            CE,
            &choice(),
            now(),
            &EngineProgress::default(),
        )
        .expect_err("an archive holding nothing");
        assert!(!format!("{err}").is_empty());
        assert_eq!(
            platform
                .fs()
                .stat(Path::new(&format!("{CACHE}/{ARCHIVE}")))
                .expect("a read"),
            None
        );
    }

    #[test]
    fn the_steps_are_reported_as_the_install_runs() {
        let said = std::sync::Mutex::new(Vec::new());
        let note = |step: &str| {
            said.lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(step.to_owned());
        };
        let platform = cached(&[], payload());
        install_cached_engine(
            &platform,
            &install(),
            CE,
            &choice(),
            now(),
            &EngineProgress {
                on_step: Some(&note),
                ..EngineProgress::default()
            },
        )
        .expect("an install");
        let steps = said
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        assert_eq!(
            steps,
            [
                "Unpacking Fallout II Community Edition",
                "Installing Fallout II Community Edition"
            ]
        );
    }

    #[test]
    fn an_asset_names_the_file_the_cache_holds() {
        // The build's asset name is what `cached_engines` is asked for, so the two must agree.
        let ce = engine_by_id(CE).expect("a named engine");
        let build =
            build_for(ce, OperatingSystem::Linux, Architecture::X64).expect("a build for Linux");
        let asset = EngineAsset {
            name: build.asset.to_owned(),
            url: "https://example/x".to_owned(),
            size: 1,
        };
        assert_eq!(asset.name, ARCHIVE);
    }
}

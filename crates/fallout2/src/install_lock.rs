//! One writer at a time in a game directory, across processes.
//!
//! The store's own gate already serialises everything one ZAX does, so what this is for is the
//! writers that gate cannot see: another machine reaching the same folder over a share, another
//! account on this one, and - the case it was built for - an installer still running from a ZAX that
//! died. That last one is why the lock names the installer's process id rather than ZAX's: ZAX's id
//! is gone precisely when the question is asked, while the installer's is still there to be found,
//! so a lock naming ZAX would read as abandoned at the one moment it is not.
//!
//! It does not stop that installer from writing - nothing here can, it is upstream's program and
//! knows nothing about ZAX. What it stops is the second writer: the retry the next run would
//! otherwise offer over the top.
//!
//! A lock nobody holds must not strand the install, so a stale one is broken rather than reported:
//! an id this machine is not running is an id nothing is writing under. The unknown cases all answer
//! "not running", which frees the lock - the direction that costs a warning rather than an install
//! nobody can perform.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use zax_platform::{Platform, Result};

/// The file, at the top of the install beside the config files ZAX already writes there.
const LOCK_NAME: &str = ".zax-lock";

/// What a lock says about itself. Every field is for the message a refusal has to write.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
struct LockRecord {
    /// The machine that took it, which is the only thing a lock on a share can be judged by from
    /// elsewhere.
    host: String,
    /// The process writing under it - the installer where one is running, ZAX itself until then.
    pid: u32,
    /// What is being done, so a refusal names the operation rather than only its directory.
    #[serde(default = "unnamed_operation")]
    what: String,
    /// The program the id was started as, once one has been handed the claim. What it settles is
    /// reuse: the system hands ids out again, so an id that is alive may be alive as something with
    /// nothing to do with this install, and the command is the only thing that tells those apart.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    command: Option<String>,
    /// When it was taken, in milliseconds since the epoch. Reported, never used to decide staleness.
    #[serde(default)]
    taken: i64,
}

fn unnamed_operation() -> String {
    "an operation".to_owned()
}

fn lock_path(install: &Path) -> PathBuf {
    install.join(LOCK_NAME)
}

fn encode(record: &LockRecord) -> Vec<u8> {
    // Every field is a plain scalar, so there is no value here the serializer can refuse.
    let mut out = serde_json::to_vec(record).unwrap_or_default();
    out.push(b'\n');
    out
}

/// What a lock file holds, or nothing where it holds something this version cannot read.
///
/// A lock ZAX cannot parse is treated as absent rather than as a refusal: the alternative is a
/// truncated write from a killed process locking the directory for good, and the file is ZAX's own
/// rather than anything a user wrote.
fn decode(bytes: &[u8]) -> Option<LockRecord> {
    serde_json::from_slice(bytes).ok()
}

/// The refusal a held lock produces, naming what holds it and where, which is what tells the user
/// what to do.
fn refusal(record: &LockRecord, here: &str) -> String {
    let where_at = if record.host == here {
        "on this machine".to_owned()
    } else {
        format!("on {}", record.host)
    };
    format!(
        "{} is already running in this game folder {where_at}, as process {}. \
         Wait for it to finish, or close it, before starting another.",
        record.what, record.pid
    )
}

/// Held by the caller for as long as it writes: `release` at the end, `hand_over` when it spawns.
#[derive(Debug)]
pub struct InstallLock {
    at: PathBuf,
    record: LockRecord,
    held: bool,
}

impl InstallLock {
    /// Names a different process as the writer - the installer, once it has started.
    ///
    /// Until this is called the lock names ZAX, which is right while ZAX is the one writing and
    /// wrong the moment it is not.
    ///
    /// # Errors
    ///
    /// Fails when the lock file cannot be rewritten.
    pub fn hand_over(&mut self, platform: &dyn Platform, pid: u32, command: &str) -> Result<()> {
        if !self.held {
            return Ok(());
        }
        self.record.pid = pid;
        self.record.command = Some(command.to_owned());
        platform.fs().write(&self.at, &encode(&self.record))
    }

    /// Gives the directory back.
    ///
    /// # Errors
    ///
    /// Fails when the lock file cannot be removed.
    pub fn release(&mut self, platform: &dyn Platform) -> Result<()> {
        self.held = false;
        platform.fs().remove(&self.at)
    }
}

/// What a claim answered.
#[derive(Debug)]
pub enum Claim {
    Taken(InstallLock),
    /// Worded for the user, since it is what reaches them.
    Refused(String),
}

/// Claims the directory, or answers why it could not.
///
/// Takes the lock over where the one already there names a process that is not running, since that
/// is a lock whose owner is gone rather than a directory in use.
///
/// # Errors
///
/// Fails when the directory cannot be written to at all.
pub fn take_install_lock(
    platform: &dyn Platform,
    install: &Path,
    what: &str,
    now: i64,
) -> Result<Claim> {
    let at = lock_path(install);
    let identity = platform.process().identity();
    let mine = LockRecord {
        host: identity.host.clone(),
        pid: identity.pid,
        what: what.to_owned(),
        command: None,
        taken: now,
    };

    if platform.fs().create_exclusive(&at, &encode(&mine))? {
        return Ok(Claim::Taken(holder(at, mine)));
    }

    let existing = platform.fs().read(&at).ok().as_deref().and_then(decode);
    if let Some(existing) = &existing {
        // Only this machine can answer for an id. A lock from elsewhere is left alone whatever its
        // age: the run that took it is somebody else's to finish, and breaking it would be the
        // second writer this prevents.
        if existing.host != mine.host {
            return Ok(Claim::Refused(refusal(existing, &mine.host)));
        }
        if platform.process().alive(existing.pid)? && still_it(platform, existing)? {
            return Ok(Claim::Refused(refusal(existing, &mine.host)));
        }
    }

    // Nobody is writing under it: an id this machine is not running, a file too damaged to name one,
    // or one that went away between the claim and the read. Cleared rather than deferred to, since
    // each of those stands between the user and an install that nothing is actually performing.
    platform.fs().remove(&at)?;
    claim_again(platform, at, mine)
}

/// Whether a live id is still the program the claim was handed to. A claim that never reached an
/// installer names no command, and the id in it is ZAX's own - alive means another ZAX, which is a
/// refusal on its own terms.
fn still_it(platform: &dyn Platform, existing: &LockRecord) -> Result<bool> {
    let Some(command) = &existing.command else {
        return Ok(true);
    };
    still_running(platform, existing.pid, command)
}

/// Whether a live id is still running `program`, rather than a number the system has since given to
/// something else.
///
/// Only a positive disagreement counts: a host that cannot say what an id is running answers `None`,
/// and treating that as a mismatch would break the check on every host without the answer.
///
/// # Errors
///
/// Fails where the host cannot be asked.
pub fn still_running(platform: &dyn Platform, pid: u32, program: &str) -> Result<bool> {
    let Some(running) = platform.process().command_of(pid)? else {
        return Ok(true);
    };
    let name = Path::new(program)
        .file_name()
        .map_or(program, |name| name.to_str().unwrap_or(program));
    Ok(running.contains(name))
}

/// One more attempt, after clearing a lock nobody held.
///
/// Once only: a third would be racing whoever took it in between, and losing that race twice is an
/// answer rather than a reason to keep trying.
fn claim_again(platform: &dyn Platform, at: PathBuf, mine: LockRecord) -> Result<Claim> {
    if platform.fs().create_exclusive(&at, &encode(&mine))? {
        return Ok(Claim::Taken(holder(at, mine)));
    }
    let won = platform.fs().read(&at).ok().as_deref().and_then(decode);
    Ok(Claim::Refused(won.map_or_else(
        || "Another ZAX is writing to this game folder.".to_owned(),
        |won| refusal(&won, &mine.host),
    )))
}

fn holder(at: PathBuf, record: LockRecord) -> InstallLock {
    InstallLock {
        at,
        record,
        held: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use zax_platform::memory::{Content, MemoryOptions, MemoryPlatform};

    const INSTALL: &str = "/games/f2";
    const LOCK: &str = "/games/f2/.zax-lock";

    fn platform_with(options: MemoryOptions) -> MemoryPlatform {
        let mut files = options.files.clone();
        // The lock is taken beside the config files, so the directory has to be there.
        files.insert("/games/f2/fallout2.exe".to_owned(), Content::from("MZ"));
        MemoryPlatform::new(MemoryOptions { files, ..options })
    }

    fn take(platform: &MemoryPlatform) -> Claim {
        take_install_lock(
            platform,
            Path::new(INSTALL),
            "Installing RPU",
            1_700_000_000_000,
        )
        .expect("claim")
    }

    fn refused_text(claim: Claim) -> String {
        match claim {
            Claim::Refused(said) => said,
            Claim::Taken(_) => panic!("the claim should have been refused"),
        }
    }

    fn held(claim: Claim) -> InstallLock {
        match claim {
            Claim::Taken(lock) => lock,
            Claim::Refused(said) => panic!("the claim should have been taken: {said}"),
        }
    }

    fn lock_file(platform: &MemoryPlatform) -> LockRecord {
        let bytes = platform.file_at(LOCK).expect("a lock file");
        decode(&bytes).expect("a readable lock")
    }

    #[test]
    fn an_empty_directory_is_claimed() {
        let platform = platform_with(MemoryOptions::default());
        let mut lock = held(take(&platform));
        assert_eq!(lock_file(&platform).what, "Installing RPU");
        lock.release(&platform).expect("release");
        assert_eq!(platform.file_at(LOCK), None);
    }

    #[test]
    fn a_lock_from_another_machine_is_left_alone_whatever_its_age() {
        // The run that took it is somebody else's to finish.
        let held_by_other = LockRecord {
            host: "elsewhere".to_owned(),
            pid: 4242,
            what: "Installing RPU".to_owned(),
            command: None,
            taken: 0,
        };
        let platform = platform_with(MemoryOptions {
            files: BTreeMap::from([(LOCK.to_owned(), Content::Binary(encode(&held_by_other)))]),
            ..MemoryOptions::default()
        });
        let said = refused_text(take(&platform));
        assert!(said.contains("on elsewhere"), "{said}");
        assert!(said.contains("4242"), "{said}");
    }

    #[test]
    fn a_lock_held_by_a_live_process_on_this_machine_refuses() {
        let mine = LockRecord {
            host: "memory".to_owned(),
            pid: 4242,
            what: "Installing RPU".to_owned(),
            command: None,
            taken: 0,
        };
        let platform = platform_with(MemoryOptions {
            files: BTreeMap::from([(LOCK.to_owned(), Content::Binary(encode(&mine)))]),
            live_pids: vec![4242],
            ..MemoryOptions::default()
        });
        let said = refused_text(take(&platform));
        assert!(said.contains("on this machine"), "{said}");
    }

    #[test]
    fn a_lock_naming_a_process_that_is_not_running_is_broken() {
        // A lock nobody holds must not strand the install.
        let stale = LockRecord {
            host: "memory".to_owned(),
            pid: 4242,
            what: "Installing RPU".to_owned(),
            command: None,
            taken: 0,
        };
        let platform = platform_with(MemoryOptions {
            files: BTreeMap::from([(LOCK.to_owned(), Content::Binary(encode(&stale)))]),
            ..MemoryOptions::default()
        });
        let _lock = held(take(&platform));
        assert_eq!(lock_file(&platform).pid, 1, "the memory platform's own id");
    }

    #[test]
    fn a_lock_too_damaged_to_read_is_treated_as_absent() {
        // The alternative is a truncated write locking the directory for good.
        let platform = platform_with(MemoryOptions {
            files: BTreeMap::from([(LOCK.to_owned(), Content::from("{\"host\": trunc"))]),
            ..MemoryOptions::default()
        });
        let _lock = held(take(&platform));
        assert_eq!(lock_file(&platform).what, "Installing RPU");
    }

    #[test]
    fn a_live_id_running_something_else_does_not_hold_the_lock() {
        // The system hands ids out again, and the command is the only thing that tells those apart.
        let handed_over = LockRecord {
            host: "memory".to_owned(),
            pid: 4242,
            what: "Installing RPU".to_owned(),
            command: Some("/cache/rpu-setup.exe".to_owned()),
            taken: 0,
        };
        let platform = platform_with(MemoryOptions {
            files: BTreeMap::from([(LOCK.to_owned(), Content::Binary(encode(&handed_over)))]),
            live_pids: vec![4242],
            commands: BTreeMap::from([(4242, "/usr/bin/something-else".to_owned())]),
            ..MemoryOptions::default()
        });
        let _lock = held(take(&platform));
    }

    #[test]
    fn a_live_id_still_running_the_installer_holds_it() {
        let handed_over = LockRecord {
            host: "memory".to_owned(),
            pid: 4242,
            what: "Installing RPU".to_owned(),
            command: Some("/cache/rpu-setup.exe".to_owned()),
            taken: 0,
        };
        let platform = platform_with(MemoryOptions {
            files: BTreeMap::from([(LOCK.to_owned(), Content::Binary(encode(&handed_over)))]),
            live_pids: vec![4242],
            commands: BTreeMap::from([(4242, "wine /cache/rpu-setup.exe /silent".to_owned())]),
            ..MemoryOptions::default()
        });
        assert!(refused_text(take(&platform)).contains("4242"));
    }

    #[test]
    fn a_host_that_cannot_say_what_an_id_runs_keeps_the_lock_held() {
        // Treating "cannot say" as a mismatch would break claims on every host without the answer.
        let handed_over = LockRecord {
            host: "memory".to_owned(),
            pid: 4242,
            what: "Installing RPU".to_owned(),
            command: Some("/cache/rpu-setup.exe".to_owned()),
            taken: 0,
        };
        let platform = platform_with(MemoryOptions {
            files: BTreeMap::from([(LOCK.to_owned(), Content::Binary(encode(&handed_over)))]),
            live_pids: vec![4242],
            ..MemoryOptions::default()
        });
        assert!(refused_text(take(&platform)).contains("4242"));
    }

    #[test]
    fn handing_over_names_the_installer_rather_than_zax() {
        // ZAX's id is gone precisely when the question is asked.
        let platform = platform_with(MemoryOptions::default());
        let mut lock = held(take(&platform));
        lock.hand_over(&platform, 9001, "/cache/rpu-setup.exe")
            .expect("hand over");

        let record = lock_file(&platform);
        assert_eq!(record.pid, 9001);
        assert_eq!(record.command.as_deref(), Some("/cache/rpu-setup.exe"));
        assert_eq!(record.what, "Installing RPU", "the operation is unchanged");
    }

    #[test]
    fn handing_over_after_release_writes_nothing_back() {
        let platform = platform_with(MemoryOptions::default());
        let mut lock = held(take(&platform));
        lock.release(&platform).expect("release");
        lock.hand_over(&platform, 9001, "/cache/setup.exe")
            .expect("hand over");
        assert_eq!(platform.file_at(LOCK), None, "the lock must stay released");
    }
}

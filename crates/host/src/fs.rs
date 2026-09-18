//! Files on a real filesystem.

use std::fs;
use std::io::Write as _;
use std::path::Path;

use zax_platform::fs::{DirEntry, FileKind, FileStat, FileSystem};
use zax_platform::{Error, Result};

/// A failure with the operation and path the caller asked about, which is what the domain's messages
/// are written against.
fn failed(operation: &'static str, path: &Path, source: std::io::Error) -> Error {
    Error::Io {
        operation,
        path: path.to_string_lossy().into_owned(),
        source,
    }
}

fn kind_of(held: &fs::FileType) -> FileKind {
    if held.is_file() {
        FileKind::File
    } else if held.is_dir() {
        FileKind::Dir
    } else {
        FileKind::Other
    }
}

/// Milliseconds since the epoch, or zero where the host cannot say. A modification time nobody can read
/// makes a cached listing look ancient, which costs a request rather than correctness.
fn modified_millis(held: &fs::Metadata) -> i64 {
    let Ok(at) = held.modified() else {
        return 0;
    };
    match at.duration_since(std::time::UNIX_EPOCH) {
        Ok(since) => i64::try_from(since.as_millis()).unwrap_or(i64::MAX),
        // Before the epoch, which is a clock nobody set rather than a file anyone wrote.
        Err(_) => 0,
    }
}

fn parent_of(path: &Path) -> Option<&Path> {
    path.parent().filter(|at| !at.as_os_str().is_empty())
}

#[derive(Debug, Default)]
pub struct HostFileSystem;

impl FileSystem for HostFileSystem {
    fn read(&self, path: &Path) -> Result<Vec<u8>> {
        fs::read(path).map_err(|err| failed("read", path, err))
    }

    fn write(&self, path: &Path, bytes: &[u8]) -> Result<()> {
        if let Some(parent) = parent_of(path) {
            fs::create_dir_all(parent).map_err(|err| failed("mkdir", parent, err))?;
        }
        // Written beside the target and renamed over it: a crash mid-write must not leave a truncated
        // file, because one of these files is the user's install list.
        let mut partial = path.as_os_str().to_owned();
        partial.push(".zax-partial");
        let partial = std::path::PathBuf::from(partial);
        fs::write(&partial, bytes).map_err(|err| failed("write", &partial, err))?;
        fs::rename(&partial, path).map_err(|err| failed("rename", path, err))
    }

    fn create_exclusive(&self, path: &Path, bytes: &[u8]) -> Result<bool> {
        // `create_new` is the whole point: the kernel does the test and the create together, so two
        // processes racing for one lock cannot both be told they made it. Anything but `AlreadyExists`
        // is a real failure and propagates - including the missing parent this deliberately does not
        // create, since a claim on a directory that is not there is a claim on nothing.
        let held = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path);
        let mut file = match held {
            Ok(file) => file,
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => return Ok(false),
            Err(err) => return Err(failed("create_exclusive", path, err)),
        };
        file.write_all(bytes)
            .map_err(|err| failed("create_exclusive", path, err))?;
        Ok(true)
    }

    fn append(&self, path: &Path, bytes: &[u8]) -> Result<()> {
        if let Some(parent) = parent_of(path) {
            fs::create_dir_all(parent).map_err(|err| failed("mkdir", parent, err))?;
        }
        let mut file = fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(path)
            .map_err(|err| failed("append", path, err))?;
        file.write_all(bytes)
            .map_err(|err| failed("append", path, err))
    }

    fn stat(&self, path: &Path) -> Result<Option<FileStat>> {
        // Through the link first: a game folder reached by one is the folder it points at, and reading
        // the link itself reports `Other`, which every caller asking "is this a directory" refuses.
        //
        // `symlink_metadata` second, so a link pointing at nothing still reads as something rather than
        // as absent - what a caller about to write there has to know.
        match fs::metadata(path).or_else(|_| fs::symlink_metadata(path)) {
            Ok(held) => Ok(Some(FileStat {
                kind: kind_of(&held.file_type()),
                size: held.len(),
                modified: modified_millis(&held),
            })),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(failed("stat", path, err)),
        }
    }

    fn list(&self, path: &Path) -> Result<Vec<DirEntry>> {
        let mut out = Vec::new();
        for entry in fs::read_dir(path).map_err(|err| failed("list", path, err))? {
            let entry = entry.map_err(|err| failed("list", path, err))?;
            let kind = entry
                .file_type()
                .map_or(FileKind::Other, |held| kind_of(&held));
            out.push(DirEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                kind,
            });
        }
        Ok(out)
    }

    fn mkdir(&self, path: &Path) -> Result<()> {
        fs::create_dir_all(path).map_err(|err| failed("mkdir", path, err))
    }

    fn copy(&self, from: &Path, to: &Path) -> Result<()> {
        if let Some(parent) = parent_of(to) {
            fs::create_dir_all(parent).map_err(|err| failed("mkdir", parent, err))?;
        }
        fs::copy(from, to)
            .map(|_| ())
            .map_err(|err| failed("copy", from, err))
    }

    fn remove(&self, path: &Path) -> Result<()> {
        match fs::symlink_metadata(path) {
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(failed("remove", path, err)),
            Ok(held) if held.is_dir() => {
                fs::remove_dir_all(path).map_err(|err| failed("remove", path, err))
            }
            Ok(_) => fs::remove_file(path).map_err(|err| failed("remove", path, err)),
        }
    }

    fn rename(&self, from: &Path, to: &Path) -> Result<()> {
        if let Some(parent) = parent_of(to) {
            fs::create_dir_all(parent).map_err(|err| failed("mkdir", parent, err))?;
        }
        fs::rename(from, to).map_err(|err| failed("rename", from, err))
    }

    fn free_space(&self, path: &Path) -> Result<Option<u64>> {
        Ok(free_space_at(path))
    }

    fn make_executable(&self, path: &Path) -> Result<()> {
        set_executable(path)
    }
}

/// Available to this user rather than free in total: the difference is the reserve only root may spend,
/// and an install that fills it is not an install that succeeded.
///
/// A path that is not there says nothing about the disk, and neither does a host that will not answer -
/// both read as "cannot say", which every caller already treats as a check that did not run.
fn free_space_at(path: &Path) -> Option<u64> {
    // Asked of the path itself, because Windows answers for the whole volume where the path is not
    // there at all - which reads as a measurement of a directory that does not exist yet.
    if !fs::exists(path).unwrap_or(false) {
        return None;
    }
    fs4::available_space(path).ok()
}

/// Windows has no execute bit and rejects the call; everywhere else, the owner's is what running it
/// from here needs. The existing mode is read first so this only adds.
#[cfg(unix)]
fn set_executable(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt as _;

    let held = fs::metadata(path).map_err(|err| failed("make_executable", path, err))?;
    let mut mode = held.permissions();
    mode.set_mode(mode.mode() | 0o100);
    fs::set_permissions(path, mode).map_err(|err| failed("make_executable", path, err))
}

#[cfg(not(unix))]
fn set_executable(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A directory of this test's own, removed whatever the test does with it.
    struct Scratch(std::path::PathBuf);

    impl Scratch {
        fn new(named: &str) -> Self {
            let at = std::env::temp_dir().join(format!("zax-host-{named}"));
            let _ = fs::remove_dir_all(&at);
            fs::create_dir_all(&at).expect("a directory the test makes");
            Self(at)
        }

        fn at(&self, name: &str) -> std::path::PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_write_makes_the_directories_it_needs_and_leaves_no_partial_behind() {
        let scratch = Scratch::new("write");
        let held = HostFileSystem;
        let at = scratch.at("a/b/c.txt");
        held.write(&at, b"held").expect("a write");
        assert_eq!(held.read(&at).expect("a read"), b"held");
        let beside = scratch.at("a/b");
        let names: Vec<String> = held
            .list(&beside)
            .expect("a listing")
            .into_iter()
            .map(|entry| entry.name)
            .collect();
        assert_eq!(names, ["c.txt"]);
    }

    #[test]
    fn a_path_that_is_not_there_stats_as_nothing_rather_than_failing() {
        let scratch = Scratch::new("stat");
        assert_eq!(
            HostFileSystem.stat(&scratch.at("nothing")).expect("a read"),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_directory_reached_by_a_link_is_a_directory() {
        // What a game folder kept elsewhere and linked into place looks like: reading the link itself
        // answers `Other`, and every gate asking for a directory then refuses the install.
        let scratch = Scratch::new("stat-link");
        let real = scratch.at("real");
        fs::create_dir_all(&real).expect("a directory");
        fs::write(real.join("fallout2.exe"), b"MZ").expect("a file");
        let link = scratch.at("linked");
        std::os::unix::fs::symlink(&real, &link).expect("a link");

        let held = HostFileSystem.stat(&link).expect("a read").expect("a stat");
        assert_eq!(held.kind, FileKind::Dir);
        let names: Vec<String> = HostFileSystem
            .list(&link)
            .expect("a listing")
            .into_iter()
            .map(|entry| entry.name)
            .collect();
        assert_eq!(names, ["fallout2.exe"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_pointing_at_nothing_is_still_something() {
        // Absent would tell a caller about to write there that the path is free, and the write then
        // lands wherever the link points.
        let scratch = Scratch::new("stat-dangling");
        let link = scratch.at("dangling");
        std::os::unix::fs::symlink(scratch.at("gone"), &link).expect("a link");
        let held = HostFileSystem.stat(&link).expect("a read");
        assert_eq!(held.map(|stat| stat.kind), Some(FileKind::Other));
    }

    #[test]
    fn an_exclusive_create_answers_the_second_caller_no() {
        // The test and the create are one operation, which is what makes it usable as a lock.
        let scratch = Scratch::new("exclusive");
        let held = HostFileSystem;
        let at = scratch.at("lock");
        assert!(held.create_exclusive(&at, b"mine").expect("a claim"));
        assert!(!held.create_exclusive(&at, b"theirs").expect("a claim"));
        assert_eq!(held.read(&at).expect("a read"), b"mine");
    }

    #[test]
    fn an_exclusive_create_does_not_make_the_directory_it_sits_in() {
        // A claim on a directory that is not there is a claim on nothing.
        let scratch = Scratch::new("exclusive-parent");
        let err = HostFileSystem
            .create_exclusive(&scratch.at("nowhere/lock"), b"mine")
            .expect_err("no directory to claim in");
        assert!(matches!(err, Error::Io { .. }), "{err:?}");
    }

    #[test]
    fn appending_makes_the_file_and_then_adds_to_it() {
        let scratch = Scratch::new("append");
        let held = HostFileSystem;
        let at = scratch.at("log/zax.log");
        held.append(&at, b"first\n").expect("a line");
        held.append(&at, b"second\n").expect("a line");
        assert_eq!(held.read(&at).expect("a read"), b"first\nsecond\n");
    }

    #[test]
    fn removing_takes_a_directory_whole_and_a_missing_path_is_not_a_failure() {
        let scratch = Scratch::new("remove");
        let held = HostFileSystem;
        held.write(&scratch.at("tree/a/b.txt"), b"held")
            .expect("a write");
        held.remove(&scratch.at("tree")).expect("a removal");
        assert_eq!(held.stat(&scratch.at("tree")).expect("a read"), None);
        held.remove(&scratch.at("tree")).expect("nothing to remove");
    }

    #[test]
    fn a_copy_and_a_rename_both_make_the_directory_they_land_in() {
        let scratch = Scratch::new("move");
        let held = HostFileSystem;
        held.write(&scratch.at("one.txt"), b"held")
            .expect("a write");
        held.copy(&scratch.at("one.txt"), &scratch.at("into/two.txt"))
            .expect("a copy");
        assert_eq!(
            held.read(&scratch.at("into/two.txt")).expect("a read"),
            b"held"
        );
        held.rename(&scratch.at("into/two.txt"), &scratch.at("onward/three.txt"))
            .expect("a rename");
        assert_eq!(
            held.read(&scratch.at("onward/three.txt")).expect("a read"),
            b"held"
        );
    }

    #[test]
    fn a_directory_lists_its_entries_by_kind() {
        let scratch = Scratch::new("list");
        let held = HostFileSystem;
        held.write(&scratch.at("a.txt"), b"held").expect("a write");
        held.mkdir(&scratch.at("inner")).expect("a directory");
        let mut listed = held.list(&scratch.0).expect("a listing");
        listed.sort_by(|a, b| a.name.cmp(&b.name));
        assert_eq!(listed[0].name, "a.txt");
        assert_eq!(listed[0].kind, FileKind::File);
        assert_eq!(listed[1].name, "inner");
        assert_eq!(listed[1].kind, FileKind::Dir);
    }

    #[test]
    fn the_drive_holding_a_real_directory_says_how_much_is_free() {
        let scratch = Scratch::new("space");
        let free = HostFileSystem.free_space(&scratch.0).expect("a read");
        assert!(free.is_some_and(|held| held > 0), "{free:?}");
    }

    #[test]
    fn a_path_that_is_not_there_says_nothing_about_the_disk() {
        let scratch = Scratch::new("space-missing");
        assert_eq!(
            HostFileSystem
                .free_space(&scratch.at("nothing"))
                .expect("a read"),
            None
        );
    }

    #[test]
    fn a_file_can_be_made_runnable() {
        let scratch = Scratch::new("executable");
        let held = HostFileSystem;
        let at = scratch.at("setup.sh");
        held.write(&at, b"#!/bin/sh\n").expect("a write");
        held.make_executable(&at).expect("a mode");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = fs::metadata(&at).expect("a read").permissions().mode();
            assert_eq!(mode & 0o100, 0o100, "{mode:o}");
        }
    }

    #[test]
    fn a_modification_time_is_milliseconds_since_the_epoch() {
        let scratch = Scratch::new("modified");
        let held = HostFileSystem;
        let at = scratch.at("a.txt");
        held.write(&at, b"held").expect("a write");
        let stat = held.stat(&at).expect("a read").expect("the file is there");
        // Any plausible clock is past 2001, which is what a cached listing's freshness rests on.
        assert!(stat.modified > 1_000_000_000_000, "{}", stat.modified);
    }
}

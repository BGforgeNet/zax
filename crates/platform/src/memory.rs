//! The platform, in memory. Domain tests run against this so they exercise the real code paths
//! without a filesystem, a network or a child process, and so a failing test names a domain defect
//! rather than a fixture that was not cleaned up.
//!
//! Everything the outside world would have done is recorded instead: launches, downloads, opened
//! paths and archives written. Asserting on those records is how a test checks an effect that has
//! no return value.
//!
//! Paths are normalised to `/`-separated strings regardless of host, because this platform is
//! deliberately not the host: a test writes one spelling and reads it back on every machine.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::{Mutex, MutexGuard, PoisonError};

use md5::Md5;
use sha2::{Digest, Sha256};

use crate::archive::{Archive, ArchiveEntry, ArchiveEntryInfo, ArchiveEntryKind, ExtractOptions};
use crate::fs::{DirEntry, FileKind, FileStat, FileSystem};
use crate::hash::Hashing;
use crate::net::{DownloadOptions, DownloadProgress, Network, NetworkError, NetworkFailure};
use crate::paths::Paths;
use crate::process::{LaunchOptions, ProcessIdentity, ProcessLauncher, RunOutcome};
use crate::registry::Registry;
use crate::{Architecture, Error, OperatingSystem, Platform, Result};

/// Bytes for a string, one byte per code point. Lossless for the latin1 config files, and ASCII is
/// ASCII.
#[must_use]
pub fn bytes(text: &str) -> Vec<u8> {
    text.chars().map(|c| (c as u32 & 0xff) as u8).collect()
}

#[must_use]
pub fn text(data: &[u8]) -> String {
    data.iter().map(|&b| b as char).collect()
}

/// Collapses repeated and trailing separators so two spellings of one path are one key.
///
/// `\` counts as a separator at every entry point, the `&str` helpers tests read through included:
/// on a Windows host `Path::join` adds `\` to a `/` fixture path, and a helper that kept it would
/// miss the file the domain wrote.
fn normalize(path: &str) -> String {
    let absolute = path.starts_with(['/', '\\']);
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split(['/', '\\']) {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." && parts.last().is_some_and(|last| *last != "..") {
            parts.pop();
        } else {
            parts.push(part);
        }
    }
    let joined = parts.join("/");
    if absolute {
        format!("/{joined}")
    } else {
        joined
    }
}

fn normalize_path(path: &Path) -> String {
    normalize(&path.to_string_lossy())
}

fn parent_of(path: &str) -> String {
    let at = normalize(path);
    match at.rfind('/') {
        None => String::new(),
        Some(0) => "/".to_owned(),
        Some(cut) => at[..cut].to_owned(),
    }
}

/// What a canned file holds. A string is stored as its bytes; binary content is passed through.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Content {
    Text(String),
    Binary(Vec<u8>),
}

impl Content {
    #[must_use]
    pub fn as_bytes(&self) -> Vec<u8> {
        match self {
            Self::Text(s) => bytes(s),
            Self::Binary(b) => b.clone(),
        }
    }

    #[must_use]
    pub fn len(&self) -> usize {
        match self {
            Self::Text(s) => s.chars().count(),
            Self::Binary(b) => b.len(),
        }
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl From<&str> for Content {
    fn from(value: &str) -> Self {
        Self::Text(value.to_owned())
    }
}

impl From<String> for Content {
    fn from(value: String) -> Self {
        Self::Text(value)
    }
}

impl From<Vec<u8>> for Content {
    fn from(value: Vec<u8>) -> Self {
        Self::Binary(value)
    }
}

/// A canned `fetch_text` answer: a body, or a status for a server that answered with a failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Response {
    Body(String),
    Status(u16),
}

/// Answers `free_space` for one path at a time.
pub type FreeSpaceFn = dyn Fn(&str) -> Option<u64> + Send + Sync;

/// How much room `free_space` reports. `None` by default because this platform has no disk, which
/// is also the arm where a preflight's check cannot run; a test meaning to exercise the refusal
/// states a number.
pub enum FreeSpace {
    /// The same answer everywhere.
    Fixed(u64),
    /// A per-path answer: ZAX's cache and a game folder are usually different drives, and a drive's
    /// room changes as an install fills it, so a single number cannot express either.
    PerPath(Box<FreeSpaceFn>),
}

impl std::fmt::Debug for FreeSpace {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Fixed(n) => f.debug_tuple("Fixed").field(n).finish(),
            Self::PerPath(_) => f.write_str("PerPath(<callback>)"),
        }
    }
}

#[derive(Debug, Default)]
pub struct MemoryOptions {
    pub os: Option<OperatingSystem>,
    pub arch: Option<Architecture>,
    pub home: Option<String>,
    pub config: Option<String>,
    pub cache: Option<String>,
    /// Initial files, by absolute path.
    pub files: BTreeMap<String, Content>,
    /// What `command_of` answers per id. An id with no entry answers `None`, which is "cannot say".
    pub commands: BTreeMap<u32, String>,
    /// Process ids `alive` answers yes for - the ids a test is saying are still running somewhere.
    pub live_pids: Vec<u32>,
    /// Directories that exist while holding no files - an empty `mods/`, a game folder with nothing
    /// in it.
    pub dirs: Vec<String>,
    /// Canned responses for `fetch_text`, by URL. A URL with no entry fails, as an unreachable host
    /// would.
    pub responses: BTreeMap<String, Response>,
    /// What `download` writes at the destination, by URL. A URL with no entry fails, as fetching
    /// does.
    pub downloads: BTreeMap<String, Content>,
    /// What `extract` produces: file contents keyed by path inside the archive. Keyed by the
    /// archive's path, or by the text it holds - which is what a path that carries different
    /// archives at different times needs, an install's working directory being one.
    pub archives: BTreeMap<String, BTreeMap<String, Content>>,
    /// Canned `list` answers, for archives whose declared directory must differ from their contents
    /// (a bombed size declaration, a symlink entry). An archive with none is listed from its
    /// `archives` contents.
    pub listings: BTreeMap<String, Vec<ArchiveEntryInfo>>,
    /// Registry values, by key and then by value name. Both are matched case-insensitively, as
    /// Windows does.
    pub registry: BTreeMap<String, BTreeMap<String, String>>,
    /// What `run` answers, by program, or by program and subcommand where a tool answers its own
    /// subcommands differently - `"/cache/dat3 l"` before `"/cache/dat3"`. A program with no entry
    /// fails, as a host answers one that is not installed - so a test reaches the installer path
    /// only by saying what the installer does.
    pub runs: BTreeMap<String, RunOutcome>,
    pub free_space: Option<FreeSpace>,
}

/// One recorded launch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchRecord {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub log: Option<String>,
    pub env: BTreeMap<String, String>,
}

/// One recorded archive write, with what was in it at the time. The contents are captured rather
/// than looked up later because an archive routinely outlives the scratch files that went into it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZipRecord {
    pub destination: String,
    pub entries: Vec<ArchiveEntry>,
    pub contents: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractRecord {
    pub archive: String,
    pub destination: String,
    pub only: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadRecord {
    pub url: String,
    pub destination: String,
}

/// Everything the outside world was asked to do, in the order it was asked.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Records {
    pub launched: Vec<LaunchRecord>,
    /// Programs run to completion, which is what asserts the command an installer was invoked with.
    pub ran: Vec<LaunchRecord>,
    /// Paths marked runnable - there is no mode here, so the record is the effect.
    pub executable: Vec<String>,
    pub opened: Vec<String>,
    pub fetched: Vec<String>,
    pub downloaded: Vec<DownloadRecord>,
    pub extracted: Vec<ExtractRecord>,
    pub listed: Vec<String>,
    pub zipped: Vec<ZipRecord>,
}

#[derive(Debug)]
struct State {
    files: BTreeMap<String, Vec<u8>>,
    dirs: BTreeSet<String>,
    times: BTreeMap<String, i64>,
    /// Advanced by one on each write, so a rewritten file is detectably newer without a real clock.
    clock: i64,
    /// Handed out by `run` in order, so a test can name the id its installer was given without
    /// guessing it.
    next_pid: u32,
    records: Records,
}

#[derive(Debug)]
pub struct MemoryPlatform {
    os: OperatingSystem,
    arch: Architecture,
    home: std::path::PathBuf,
    config: std::path::PathBuf,
    cache: std::path::PathBuf,
    identity: ProcessIdentity,
    options: MemoryOptions,
    state: Mutex<State>,
}

impl Default for MemoryPlatform {
    fn default() -> Self {
        Self::new(MemoryOptions::default())
    }
}

impl MemoryPlatform {
    #[must_use]
    pub fn new(options: MemoryOptions) -> Self {
        let home = normalize(options.home.as_deref().unwrap_or("/home/tester"));
        let config = normalize(
            options
                .config
                .clone()
                .unwrap_or_else(|| format!("{home}/.config/zax"))
                .as_str(),
        );
        let cache = normalize(
            options
                .cache
                .clone()
                .unwrap_or_else(|| format!("{home}/.cache/zax"))
                .as_str(),
        );

        let mut state = State {
            files: BTreeMap::new(),
            dirs: BTreeSet::from([String::from("/")]),
            times: BTreeMap::new(),
            clock: 1_700_000_000_000,
            next_pid: 1000,
            records: Records::default(),
        };
        for dir in &options.dirs {
            make_dirs(&mut state, &normalize(dir));
        }
        for (path, content) in &options.files {
            put(&mut state, &normalize(path), content.as_bytes());
        }

        Self {
            os: options.os.unwrap_or(OperatingSystem::Linux),
            arch: options.arch.unwrap_or(Architecture::X64),
            home: home.into(),
            config: config.into(),
            cache: cache.into(),
            // Named rather than blank so a lock written here reads as this platform's, and fixed so
            // a test can assert what a lock file holds without the answer moving under it.
            identity: ProcessIdentity {
                host: "memory".to_owned(),
                pid: 1,
            },
            options,
            state: Mutex::new(state),
        }
    }

    /// A poisoned lock means a test panicked mid-write. The data is still coherent enough to report
    /// against, and turning that into a second panic hides the first.
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The bytes at a path, for asserting on what was written.
    #[must_use]
    pub fn file_at(&self, path: &str) -> Option<Vec<u8>> {
        self.state().files.get(&normalize(path)).cloned()
    }

    /// The bytes at a path as a string, one character per byte.
    #[must_use]
    pub fn text_at(&self, path: &str) -> Option<String> {
        self.file_at(path).as_deref().map(text)
    }

    /// Every file present, by path, for asserting that a write touched nothing else.
    #[must_use]
    pub fn all_files(&self) -> Vec<String> {
        self.state().files.keys().cloned().collect()
    }

    /// What the outside world was asked to do, as a snapshot.
    #[must_use]
    pub fn records(&self) -> Records {
        self.state().records.clone()
    }

    /// An archive's canned contents, by its normalized path or by the text sitting at that path.
    ///
    /// Both callers already normalize, and normalizing is idempotent, so there is no separate
    /// raw-key lookup: it would resolve to the same key. A fixture therefore has to be keyed the
    /// way `normalize` spells the path.
    fn canned_contents(&self, archive: &str) -> Option<&BTreeMap<String, Content>> {
        let at = normalize(archive);
        if let Some(found) = self.options.archives.get(&at) {
            return Some(found);
        }
        let held = self.state().files.get(&at).cloned()?;
        self.options.archives.get(&text(&held))
    }

    fn canned_run(&self, program: &str, args: &[String]) -> Option<&RunOutcome> {
        let first = args.first().map_or("", String::as_str);
        let with_sub = format!("{program} {first}");
        self.options
            .runs
            .get(with_sub.trim())
            .or_else(|| self.options.runs.get(program))
    }
}

fn put(state: &mut State, path: &str, data: Vec<u8>) {
    make_dirs(state, &parent_of(path));
    state.files.insert(path.to_owned(), data);
    state.clock += 1;
    state.times.insert(path.to_owned(), state.clock);
}

fn make_dirs(state: &mut State, path: &str) {
    if path.is_empty() || path == "/" {
        return;
    }
    let absolute = path.starts_with('/');
    let mut at = String::new();
    for part in path.split('/').filter(|p| !p.is_empty()) {
        if at.is_empty() {
            at = if absolute {
                format!("/{part}")
            } else {
                part.to_owned()
            };
        } else {
            at = format!("{at}/{part}");
        }
        state.dirs.insert(at.clone());
    }
}

fn stat_of(state: &State, path: &str) -> Option<FileStat> {
    if let Some(file) = state.files.get(path) {
        return Some(FileStat {
            kind: FileKind::File,
            size: file.len() as u64,
            modified: state.times.get(path).copied().unwrap_or(state.clock),
        });
    }
    if state.dirs.contains(path) || path == "/" {
        return Some(FileStat {
            kind: FileKind::Dir,
            size: 0,
            modified: state.clock,
        });
    }
    None
}

fn missing(operation: &'static str, path: &str) -> Error {
    Error::Io {
        operation,
        path: path.to_owned(),
        source: std::io::Error::from(std::io::ErrorKind::NotFound),
    }
}

impl FileSystem for MemoryPlatform {
    fn read(&self, path: &Path) -> Result<Vec<u8>> {
        let at = normalize_path(path);
        self.state()
            .files
            .get(&at)
            .cloned()
            .ok_or_else(|| missing("read", &at))
    }

    fn write(&self, path: &Path, data: &[u8]) -> Result<()> {
        put(&mut self.state(), &normalize_path(path), data.to_vec());
        Ok(())
    }

    fn create_exclusive(&self, path: &Path, data: &[u8]) -> Result<bool> {
        // One critical section, so the check and the write cannot be separated the way they can on
        // a real filesystem - which is the property the callers want rather than an accident.
        let at = normalize_path(path);
        let mut state = self.state();
        if state.files.contains_key(&at) {
            return Ok(false);
        }
        // Unlike `write`, the parent is not created: the real host opens with O_EXCL and fails with
        // ENOENT when the directory is missing, and a double that quietly succeeds there would hide
        // a caller claiming a lock on a directory that is not.
        let parent = parent_of(&at);
        if !parent.is_empty() && parent != "/" && !state.dirs.contains(&parent) {
            return Err(missing("create_exclusive", &at));
        }
        state.files.insert(at.clone(), data.to_vec());
        state.clock += 1;
        let now = state.clock;
        state.times.insert(at, now);
        Ok(true)
    }

    fn append(&self, path: &Path, data: &[u8]) -> Result<()> {
        let at = normalize_path(path);
        let mut state = self.state();
        let mut joined = state.files.get(&at).cloned().unwrap_or_default();
        joined.extend_from_slice(data);
        put(&mut state, &at, joined);
        Ok(())
    }

    fn stat(&self, path: &Path) -> Result<Option<FileStat>> {
        let state = self.state();
        Ok(stat_of(&state, &normalize_path(path)))
    }

    fn list(&self, path: &Path) -> Result<Vec<DirEntry>> {
        let at = normalize_path(path);
        let state = self.state();
        if !state.dirs.contains(&at) && at != "/" {
            return Err(missing("list", &at));
        }
        let prefix = if at == "/" {
            "/".to_owned()
        } else {
            format!("{at}/")
        };
        let mut names: BTreeMap<String, FileKind> = BTreeMap::new();
        for key in state.files.keys() {
            let Some(rest) = key.strip_prefix(&prefix) else {
                continue;
            };
            let head = rest.split('/').next().unwrap_or(rest);
            names.insert(
                head.to_owned(),
                if rest.contains('/') {
                    FileKind::Dir
                } else {
                    FileKind::File
                },
            );
        }
        for key in &state.dirs {
            if key == &at {
                continue;
            }
            let Some(rest) = key.strip_prefix(&prefix) else {
                continue;
            };
            let head = rest.split('/').next().unwrap_or(rest);
            names.insert(head.to_owned(), FileKind::Dir);
        }
        Ok(names
            .into_iter()
            .map(|(name, kind)| DirEntry { name, kind })
            .collect())
    }

    fn mkdir(&self, path: &Path) -> Result<()> {
        make_dirs(&mut self.state(), &normalize_path(path));
        Ok(())
    }

    fn copy(&self, from: &Path, to: &Path) -> Result<()> {
        let source = normalize_path(from);
        let mut state = self.state();
        let found = state
            .files
            .get(&source)
            .cloned()
            .ok_or_else(|| missing("copy", &source))?;
        put(&mut state, &normalize_path(to), found);
        Ok(())
    }

    fn remove(&self, path: &Path) -> Result<()> {
        let at = normalize_path(path);
        let under = format!("{at}/");
        let mut state = self.state();
        state
            .files
            .retain(|key, _| key != &at && !key.starts_with(&under));
        state
            .dirs
            .retain(|key| key != &at && !key.starts_with(&under));
        Ok(())
    }

    /// Moves a file, or a directory with everything under it - one pass over the keys, as a real
    /// rename is.
    fn rename(&self, from: &Path, to: &Path) -> Result<()> {
        let source = normalize_path(from);
        let target = normalize_path(to);
        let under = format!("{source}/");
        let mut state = self.state();
        if stat_of(&state, &source).is_none() {
            return Err(missing("rename", &source));
        }
        let moving: Vec<String> = state
            .files
            .keys()
            .filter(|key| *key == &source || key.starts_with(&under))
            .cloned()
            .collect();
        for key in moving {
            let moved = if key == source {
                target.clone()
            } else {
                format!("{target}{}", &key[source.len()..])
            };
            let Some(held) = state.files.remove(&key) else {
                continue;
            };
            state.times.remove(&key);
            put(&mut state, &moved, held);
        }
        let dirs: Vec<String> = state
            .dirs
            .iter()
            .filter(|key| *key == &source || key.starts_with(&under))
            .cloned()
            .collect();
        for key in dirs {
            state.dirs.remove(&key);
            let moved = if key == source {
                target.clone()
            } else {
                format!("{target}{}", &key[source.len()..])
            };
            make_dirs(&mut state, &moved);
        }
        Ok(())
    }

    fn free_space(&self, path: &Path) -> Result<Option<u64>> {
        let at = normalize_path(path);
        Ok(match &self.options.free_space {
            None => None,
            Some(FreeSpace::Fixed(n)) => Some(*n),
            Some(FreeSpace::PerPath(f)) => f(&at),
        })
    }

    fn make_executable(&self, path: &Path) -> Result<()> {
        self.state().records.executable.push(normalize_path(path));
        Ok(())
    }
}

impl Paths for MemoryPlatform {
    fn config(&self) -> &Path {
        &self.config
    }
    fn cache(&self) -> &Path {
        &self.cache
    }
    fn home(&self) -> &Path {
        &self.home
    }
}

fn record_of(program: &Path, args: &[String], options: &LaunchOptions<'_>) -> LaunchRecord {
    LaunchRecord {
        program: normalize_path(program),
        args: args.to_vec(),
        cwd: options.cwd.as_deref().map(normalize_path),
        log: options.log.as_deref().map(normalize_path),
        env: options.env.clone(),
    }
}

impl ProcessLauncher for MemoryPlatform {
    fn identity(&self) -> &ProcessIdentity {
        &self.identity
    }

    fn launch(&self, program: &Path, args: &[String], options: &LaunchOptions<'_>) -> Result<()> {
        self.state()
            .records
            .launched
            .push(record_of(program, args, options));
        Ok(())
    }

    fn run(
        &self,
        program: &Path,
        args: &[String],
        options: &LaunchOptions<'_>,
    ) -> Result<RunOutcome> {
        let name = normalize_path(program);
        self.state()
            .records
            .ran
            .push(record_of(program, args, options));
        let canned = self
            .canned_run(&name, args)
            .cloned()
            .ok_or_else(|| missing("run", &name))?;
        // Before the answer rather than after it: the id is what a caller writes down while the
        // program is running, and a test that only ever saw it afterwards would not exercise that.
        if let Some(on_start) = options.on_start {
            let pid = {
                let mut state = self.state();
                let pid = state.next_pid;
                state.next_pid += 1;
                pid
            };
            on_start(pid);
        }
        Ok(canned)
    }

    fn open(&self, target: &Path) -> Result<()> {
        self.state().records.opened.push(normalize_path(target));
        Ok(())
    }

    /// Nothing here outlives a call, so no id is running unless a test says one is - which is what a
    /// lock left by an interrupted run has to be tested against.
    fn alive(&self, pid: u32) -> Result<bool> {
        Ok(self.options.live_pids.contains(&pid))
    }

    /// Only what a test says. Absent means the host could not tell, which is the answer a caller
    /// must not act on - so a test that wants the reuse check exercised has to say what the id is
    /// running.
    fn command_of(&self, pid: u32) -> Result<Option<String>> {
        Ok(self.options.commands.get(&pid).cloned())
    }
}

impl Network for MemoryPlatform {
    fn fetch_text(&self, url: &str) -> Result<String> {
        self.state().records.fetched.push(url.to_owned());
        // A URL with no canned response stands for a host that is not there, which is what the real
        // one reports as well - so a test of the offline path gets the error the interface handles.
        match self.options.responses.get(url) {
            None => Err(NetworkError {
                kind: NetworkFailure::Offline,
                url: url.to_owned(),
                message: format!("No canned response for {url}"),
                status: None,
            }
            .into()),
            Some(Response::Status(status)) => Err(NetworkError {
                kind: NetworkFailure::Status,
                url: url.to_owned(),
                message: format!("{url} answered {status}"),
                status: Some(*status),
            }
            .into()),
            Some(Response::Body(body)) => Ok(body.clone()),
        }
    }

    fn download(&self, url: &str, destination: &Path, options: &DownloadOptions<'_>) -> Result<()> {
        let target = normalize_path(destination);
        self.state().records.downloaded.push(DownloadRecord {
            url: url.to_owned(),
            destination: target.clone(),
        });
        // Refused before the payload is looked up, so a test can cancel a download this platform has
        // no canned answer for and still get the cancel rather than the absence.
        if options
            .cancel
            .is_some_and(|flag| flag.load(std::sync::atomic::Ordering::Relaxed))
        {
            return Err(Error::Cancelled);
        }
        let payload = self
            .options
            .downloads
            .get(url)
            .ok_or_else(|| NetworkError {
                kind: NetworkFailure::Offline,
                url: url.to_owned(),
                message: format!("No canned download for {url}"),
                status: None,
            })?;
        let data = payload.as_bytes();
        // Reported in one go rather than in pieces: there is nothing here to be slow, and a caller
        // that draws progress should still see it reach the end.
        if let Some(on_progress) = options.on_progress {
            let received = data.len() as u64;
            on_progress(DownloadProgress {
                received,
                total: Some(received),
            });
        }
        put(&mut self.state(), &target, data);
        Ok(())
    }
}

impl Archive for MemoryPlatform {
    fn extract(&self, archive: &Path, destination: &Path, options: &ExtractOptions) -> Result<()> {
        let name = normalize_path(archive);
        let target = normalize_path(destination);
        self.state().records.extracted.push(ExtractRecord {
            archive: name.clone(),
            destination: target.clone(),
            only: options.only.clone(),
        });
        let inside = self
            .canned_contents(&name)
            .ok_or_else(|| Error::Archive(format!("No canned contents for {name}")))?
            .clone();
        let mut state = self.state();
        for (entry, content) in &inside {
            if !options.only.is_empty() && !options.only.iter().any(|want| want == entry) {
                continue;
            }
            put(
                &mut state,
                &normalize(&format!("{target}/{entry}")),
                content.as_bytes(),
            );
        }
        Ok(())
    }

    fn list(&self, archive: &Path) -> Result<Vec<ArchiveEntryInfo>> {
        let name = normalize_path(archive);
        self.state().records.listed.push(name.clone());
        if let Some(canned) = self.options.listings.get(&name) {
            return Ok(canned.clone());
        }
        let inside = self
            .canned_contents(&name)
            .ok_or_else(|| Error::Archive(format!("No canned contents for {name}")))?;
        Ok(inside
            .iter()
            .map(|(entry, content)| ArchiveEntryInfo {
                name: entry.clone(),
                kind: ArchiveEntryKind::File,
                size: content.len() as u64,
            })
            .collect())
    }

    fn create_zip(&self, destination: &Path, entries: &[ArchiveEntry]) -> Result<()> {
        let target = normalize_path(destination);
        let mut contents = BTreeMap::new();
        {
            let state = self.state();
            for entry in entries {
                let source = normalize_path(&entry.source);
                let found = state
                    .files
                    .get(&source)
                    .ok_or_else(|| missing("create_zip", &source))?;
                contents.insert(entry.name.clone(), text(found));
            }
        }
        let listing = entries
            .iter()
            .map(|e| e.name.clone())
            .collect::<Vec<_>>()
            .join("\n");
        let mut state = self.state();
        state.records.zipped.push(ZipRecord {
            destination: target.clone(),
            entries: entries.to_vec(),
            contents,
        });
        put(&mut state, &target, bytes(&listing));
        Ok(())
    }
}

impl Hashing for MemoryPlatform {
    fn sha256(&self, path: &Path) -> Result<String> {
        let at = normalize_path(path);
        let found = self
            .state()
            .files
            .get(&at)
            .cloned()
            .ok_or_else(|| missing("sha256", &at))?;
        Ok(hex::encode(Sha256::digest(&found)))
    }

    fn md5(&self, path: &Path) -> Result<String> {
        let at = normalize_path(path);
        let found = self
            .state()
            .files
            .get(&at)
            .cloned()
            .ok_or_else(|| missing("md5", &at))?;
        Ok(hex::encode(Md5::digest(&found)))
    }
}

impl Registry for MemoryPlatform {
    fn read(&self, key: &str, value: &str) -> Result<Option<String>> {
        let wanted_key = key.to_lowercase();
        let wanted_value = value.to_lowercase();
        for (name, values) in &self.options.registry {
            if name.to_lowercase() != wanted_key {
                continue;
            }
            for (held, data) in values {
                if held.to_lowercase() == wanted_value {
                    return Ok(Some(data.clone()));
                }
            }
        }
        Ok(None)
    }
}

impl Platform for MemoryPlatform {
    fn os(&self) -> OperatingSystem {
        self.os
    }
    fn arch(&self) -> Architecture {
        self.arch
    }
    fn fs(&self) -> &dyn FileSystem {
        self
    }
    fn paths(&self) -> &dyn Paths {
        self
    }
    fn process(&self) -> &dyn ProcessLauncher {
        self
    }
    fn net(&self) -> &dyn Network {
        self
    }
    fn archive(&self) -> &dyn Archive {
        self
    }
    fn hash(&self) -> &dyn Hashing {
        self
    }
    fn registry(&self) -> &dyn Registry {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicBool;

    fn at(path: &str) -> PathBuf {
        PathBuf::from(path)
    }

    fn seen<T: Clone>(cell: &Mutex<Vec<T>>) -> Vec<T> {
        cell.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    fn with_files(pairs: &[(&str, &str)]) -> MemoryPlatform {
        MemoryPlatform::new(MemoryOptions {
            files: pairs
                .iter()
                .map(|(p, c)| ((*p).to_owned(), Content::from(*c)))
                .collect(),
            ..MemoryOptions::default()
        })
    }

    #[test]
    fn collapses_repeated_and_trailing_separators() {
        assert_eq!(normalize("/a//b/"), "/a/b");
        assert_eq!(normalize("/a/./b"), "/a/b");
        assert_eq!(normalize("/a/b/../c"), "/a/c");
        assert_eq!(normalize("/"), "/");
    }

    #[test]
    fn reads_back_what_was_written() {
        let p = MemoryPlatform::default();
        p.write(&at("/games/f2/fallout2.cfg"), b"[sound]\n")
            .expect("writing to the memory platform cannot fail");
        assert_eq!(
            p.fs()
                .read(&at("/games//f2/fallout2.cfg"))
                .expect("the file was just written"),
            b"[sound]\n"
        );
    }

    #[test]
    fn a_helper_reads_a_file_through_either_separator() {
        // What a Windows host hands a test: the domain joins `\` onto a `/` fixture path.
        let p = MemoryPlatform::default();
        p.write(&at("/cache/zax/zax.log"), b"line\n")
            .expect("writing to the memory platform cannot fail");
        assert_eq!(p.text_at("/cache\\zax\\zax.log").as_deref(), Some("line\n"));
    }

    #[test]
    fn read_of_an_absent_path_fails() {
        let p = MemoryPlatform::default();
        assert!(p.fs().read(&at("/nope")).is_err());
    }

    #[test]
    fn stat_answers_none_for_an_absent_path() {
        let p = with_files(&[("/a/b.txt", "x")]);
        assert!(p.stat(&at("/a/b.txt")).expect("stat cannot fail").is_some());
        assert_eq!(p.stat(&at("/a/missing")).expect("stat cannot fail"), None);
    }

    #[test]
    fn writing_creates_the_parent_directories() {
        let p = MemoryPlatform::default();
        p.write(&at("/deep/nested/file"), b"x").expect("write");
        let stat = p.stat(&at("/deep/nested")).expect("stat cannot fail");
        assert_eq!(stat.map(|s| s.kind), Some(FileKind::Dir));
    }

    #[test]
    fn create_exclusive_claims_once() {
        let p = MemoryPlatform::default();
        p.mkdir(&at("/locks")).expect("mkdir");
        assert!(
            p.create_exclusive(&at("/locks/held"), b"first")
                .expect("claim")
        );
        assert!(
            !p.create_exclusive(&at("/locks/held"), b"second")
                .expect("second claim")
        );
        assert_eq!(p.fs().read(&at("/locks/held")).expect("read"), b"first");
    }

    #[test]
    fn create_exclusive_refuses_a_directory_that_is_not_there() {
        // The real host opens with O_EXCL and gets ENOENT. A claim on a directory that is not there
        // is a claim on nothing, so the double must not quietly invent the directory.
        let p = MemoryPlatform::default();
        assert!(p.create_exclusive(&at("/absent/held"), b"first").is_err());
        assert_eq!(p.all_files(), Vec::<String>::new());
    }

    #[test]
    fn append_extends_rather_than_replaces() {
        let p = MemoryPlatform::default();
        p.append(&at("/log"), b"one\n").expect("append");
        p.append(&at("/log"), b"two\n").expect("append");
        assert_eq!(p.fs().read(&at("/log")).expect("read"), b"one\ntwo\n");
    }

    #[test]
    fn a_rewrite_is_detectably_newer() {
        let p = with_files(&[("/f", "before")]);
        let first = p
            .stat(&at("/f"))
            .expect("stat")
            .expect("the file is there")
            .modified;
        p.write(&at("/f"), b"after").expect("write");
        let second = p
            .stat(&at("/f"))
            .expect("stat")
            .expect("the file is there")
            .modified;
        assert!(second > first, "{second} should be past {first}");
    }

    #[test]
    fn list_names_files_and_nested_directories() {
        let p = with_files(&[("/g/a.txt", "a"), ("/g/sub/b.txt", "b")]);
        let entries = p.fs().list(&at("/g")).expect("list");
        assert_eq!(
            entries,
            vec![
                DirEntry {
                    name: "a.txt".to_owned(),
                    kind: FileKind::File
                },
                DirEntry {
                    name: "sub".to_owned(),
                    kind: FileKind::Dir
                },
            ]
        );
    }

    #[test]
    fn list_of_a_non_directory_fails() {
        let p = MemoryPlatform::default();
        assert!(p.fs().list(&at("/not/there")).is_err());
    }

    #[test]
    fn rename_moves_a_whole_directory() {
        let p = with_files(&[("/mods/old/a.txt", "a"), ("/mods/old/deep/b.txt", "b")]);
        p.rename(&at("/mods/old"), &at("/mods/new"))
            .expect("rename");
        assert_eq!(p.fs().read(&at("/mods/new/a.txt")).expect("read"), b"a");
        assert_eq!(
            p.fs().read(&at("/mods/new/deep/b.txt")).expect("read"),
            b"b"
        );
        assert!(p.fs().read(&at("/mods/old/a.txt")).is_err());
        assert_eq!(p.stat(&at("/mods/old")).expect("stat"), None);
    }

    #[test]
    fn rename_of_an_absent_path_fails() {
        let p = MemoryPlatform::default();
        assert!(p.rename(&at("/gone"), &at("/elsewhere")).is_err());
    }

    #[test]
    fn remove_is_recursive_and_silent_when_already_gone() {
        let p = with_files(&[("/tree/a.txt", "a"), ("/tree/sub/b.txt", "b")]);
        p.remove(&at("/tree")).expect("remove");
        assert_eq!(p.all_files(), Vec::<String>::new());
        p.remove(&at("/tree")).expect("removing twice is silent");
    }

    #[test]
    fn remove_leaves_a_sibling_with_a_shared_prefix_alone() {
        let p = with_files(&[("/a/one.txt", "1"), ("/ab/two.txt", "2")]);
        p.remove(&at("/a")).expect("remove");
        assert_eq!(p.all_files(), vec!["/ab/two.txt".to_owned()]);
    }

    #[test]
    fn make_executable_records_the_path() {
        let p = MemoryPlatform::default();
        p.make_executable(&at("/mods/setup.sh")).expect("mark");
        assert_eq!(p.records().executable, vec!["/mods/setup.sh".to_owned()]);
    }

    #[test]
    fn free_space_is_unknown_unless_a_test_says_otherwise() {
        let p = MemoryPlatform::default();
        assert_eq!(p.free_space(&at("/anywhere")).expect("free space"), None);

        let sized = MemoryPlatform::new(MemoryOptions {
            free_space: Some(FreeSpace::PerPath(Box::new(|path| {
                if path.starts_with("/games") {
                    Some(10)
                } else {
                    Some(99)
                }
            }))),
            ..MemoryOptions::default()
        });
        assert_eq!(sized.free_space(&at("/games/f2")).expect("free"), Some(10));
        assert_eq!(
            sized.free_space(&at("/home/tester")).expect("free"),
            Some(99)
        );
    }

    #[test]
    fn registry_matches_key_and_value_case_insensitively() {
        let p = MemoryPlatform::new(MemoryOptions {
            registry: BTreeMap::from([(
                "HKLM\\Software\\GOG.com\\Games\\1207658886".to_owned(),
                BTreeMap::from([("PATH".to_owned(), "C:\\GOG\\Fallout2".to_owned())]),
            )]),
            ..MemoryOptions::default()
        });
        let found = p
            .registry()
            .read("hklm\\software\\gog.com\\games\\1207658886", "path")
            .expect("registry read");
        assert_eq!(found.as_deref(), Some("C:\\GOG\\Fallout2"));
        assert_eq!(
            p.registry()
                .read("HKLM\\Nothing", "PATH")
                .expect("registry read"),
            None
        );
    }

    #[test]
    fn run_answers_the_canned_outcome_and_records_the_command() {
        let outcome = RunOutcome {
            code: Some(0),
            output: "done".to_owned(),
        };
        let p = MemoryPlatform::new(MemoryOptions {
            runs: BTreeMap::from([("/cache/setup.exe".to_owned(), outcome.clone())]),
            ..MemoryOptions::default()
        });
        let args = vec!["/silent".to_owned()];
        let got = p
            .run(&at("/cache/setup.exe"), &args, &LaunchOptions::default())
            .expect("run");
        assert_eq!(got, outcome);
        let ran = p.records().ran;
        assert_eq!(ran.len(), 1);
        assert_eq!(ran[0].args, args);
    }

    #[test]
    fn run_prefers_the_subcommand_entry() {
        let listing = RunOutcome {
            code: Some(0),
            output: "listing".to_owned(),
        };
        let plain = RunOutcome {
            code: Some(0),
            output: "plain".to_owned(),
        };
        let p = MemoryPlatform::new(MemoryOptions {
            runs: BTreeMap::from([
                ("/cache/dat3 l".to_owned(), listing.clone()),
                ("/cache/dat3".to_owned(), plain),
            ]),
            ..MemoryOptions::default()
        });
        let got = p
            .run(
                &at("/cache/dat3"),
                &["l".to_owned()],
                &LaunchOptions::default(),
            )
            .expect("run");
        assert_eq!(got, listing);
    }

    #[test]
    fn run_of_an_unknown_program_fails() {
        let p = MemoryPlatform::default();
        assert!(
            p.run(&at("/nothing"), &[], &LaunchOptions::default())
                .is_err()
        );
    }

    #[test]
    fn on_start_sees_the_pid_before_the_outcome() {
        let p = MemoryPlatform::new(MemoryOptions {
            runs: BTreeMap::from([(
                "/cache/setup".to_owned(),
                RunOutcome {
                    code: Some(0),
                    output: String::new(),
                },
            )]),
            ..MemoryOptions::default()
        });
        let ids = Mutex::new(Vec::new());
        let record = |pid: u32| {
            ids.lock().unwrap_or_else(PoisonError::into_inner).push(pid);
        };
        let options = LaunchOptions {
            on_start: Some(&record),
            ..LaunchOptions::default()
        };
        p.run(&at("/cache/setup"), &[], &options).expect("run");
        p.run(&at("/cache/setup"), &[], &options).expect("run");
        assert_eq!(seen(&ids), vec![1000, 1001]);
    }

    #[test]
    fn alive_is_only_what_a_test_says() {
        let p = MemoryPlatform::new(MemoryOptions {
            live_pids: vec![4242],
            ..MemoryOptions::default()
        });
        assert!(p.alive(4242).expect("alive"));
        assert!(!p.alive(1).expect("alive"));
    }

    #[test]
    fn command_of_is_none_when_nothing_was_stated() {
        let p = MemoryPlatform::new(MemoryOptions {
            commands: BTreeMap::from([(7, "zax install".to_owned())]),
            ..MemoryOptions::default()
        });
        assert_eq!(
            p.command_of(7).expect("command").as_deref(),
            Some("zax install")
        );
        assert_eq!(p.command_of(8).expect("command"), None);
    }

    #[test]
    fn fetch_text_names_the_failure() {
        let p = MemoryPlatform::new(MemoryOptions {
            responses: BTreeMap::from([
                (
                    "https://example/ok".to_owned(),
                    Response::Body("body".to_owned()),
                ),
                ("https://example/gone".to_owned(), Response::Status(404)),
            ]),
            ..MemoryOptions::default()
        });
        assert_eq!(p.fetch_text("https://example/ok").expect("fetch"), "body");

        let Err(Error::Network(err)) = p.fetch_text("https://example/gone") else {
            panic!("a 404 should surface as a network error");
        };
        assert_eq!(err.kind, NetworkFailure::Status);
        assert_eq!(err.status, Some(404));

        let Err(Error::Network(err)) = p.fetch_text("https://example/unknown") else {
            panic!("an uncanned URL should read as an unreachable host");
        };
        assert_eq!(err.kind, NetworkFailure::Offline);
    }

    #[test]
    fn download_writes_the_payload_and_reports_progress() {
        let p = MemoryPlatform::new(MemoryOptions {
            downloads: BTreeMap::from([(
                "https://example/f.zip".to_owned(),
                Content::from("payload"),
            )]),
            ..MemoryOptions::default()
        });
        let progress = Mutex::new(Vec::new());
        let note = |step: DownloadProgress| {
            progress
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(step);
        };
        let options = DownloadOptions {
            on_progress: Some(&note),
            ..DownloadOptions::default()
        };
        p.download("https://example/f.zip", &at("/cache/f.zip"), &options)
            .expect("download");

        assert_eq!(p.text_at("/cache/f.zip").as_deref(), Some("payload"));
        assert_eq!(
            seen(&progress),
            vec![DownloadProgress {
                received: 7,
                total: Some(7)
            }]
        );
    }

    #[test]
    fn a_cancelled_download_refuses_before_the_payload_is_looked_up() {
        let p = MemoryPlatform::default();
        let flag = AtomicBool::new(true);
        let options = DownloadOptions {
            cancel: Some(&flag),
            ..DownloadOptions::default()
        };
        let err = p
            .download("https://example/uncanned", &at("/cache/f"), &options)
            .expect_err("a cancelled transfer must not succeed");
        assert!(matches!(err, Error::Cancelled), "got {err:?}");
    }

    fn archive_platform() -> MemoryPlatform {
        MemoryPlatform::new(MemoryOptions {
            archives: BTreeMap::from([(
                "/cache/mod.zip".to_owned(),
                BTreeMap::from([
                    ("readme.txt".to_owned(), Content::from("hello")),
                    ("data/x.dat".to_owned(), Content::from("bytes")),
                ]),
            )]),
            ..MemoryOptions::default()
        })
    }

    #[test]
    fn extract_writes_the_canned_contents() {
        let p = archive_platform();
        p.extract(
            &at("/cache/mod.zip"),
            &at("/games/f2"),
            &ExtractOptions::default(),
        )
        .expect("extract");
        assert_eq!(p.text_at("/games/f2/readme.txt").as_deref(), Some("hello"));
        assert_eq!(p.text_at("/games/f2/data/x.dat").as_deref(), Some("bytes"));
    }

    #[test]
    fn extract_honours_only() {
        let p = archive_platform();
        let options = ExtractOptions {
            only: vec!["readme.txt".to_owned()],
        };
        p.extract(&at("/cache/mod.zip"), &at("/out"), &options)
            .expect("extract");
        assert_eq!(p.text_at("/out/readme.txt").as_deref(), Some("hello"));
        assert_eq!(p.text_at("/out/data/x.dat"), None);
    }

    #[test]
    fn list_falls_back_to_the_canned_contents() {
        let p = archive_platform();
        let entries = Archive::list(&p, &at("/cache/mod.zip")).expect("list");
        assert_eq!(
            entries,
            vec![
                ArchiveEntryInfo {
                    name: "data/x.dat".to_owned(),
                    kind: ArchiveEntryKind::File,
                    size: 5,
                },
                ArchiveEntryInfo {
                    name: "readme.txt".to_owned(),
                    kind: ArchiveEntryKind::File,
                    size: 5,
                },
            ]
        );
    }

    #[test]
    fn a_canned_listing_wins_over_the_contents() {
        let planted = ArchiveEntryInfo {
            name: "escape".to_owned(),
            kind: ArchiveEntryKind::Link,
            size: 1,
        };
        let p = MemoryPlatform::new(MemoryOptions {
            archives: BTreeMap::from([(
                "/cache/mod.zip".to_owned(),
                BTreeMap::from([("readme.txt".to_owned(), Content::from("hello"))]),
            )]),
            listings: BTreeMap::from([("/cache/mod.zip".to_owned(), vec![planted.clone()])]),
            ..MemoryOptions::default()
        });
        assert_eq!(
            Archive::list(&p, &at("/cache/mod.zip")).expect("list"),
            vec![planted]
        );
    }

    #[test]
    fn archives_can_be_keyed_by_the_text_at_the_path() {
        let p = MemoryPlatform::new(MemoryOptions {
            files: BTreeMap::from([(
                "/work/current.zip".to_owned(),
                Content::from("second-release"),
            )]),
            archives: BTreeMap::from([(
                "second-release".to_owned(),
                BTreeMap::from([("note.txt".to_owned(), Content::from("later"))]),
            )]),
            ..MemoryOptions::default()
        });
        p.extract(
            &at("/work/current.zip"),
            &at("/out"),
            &ExtractOptions::default(),
        )
        .expect("extract");
        assert_eq!(p.text_at("/out/note.txt").as_deref(), Some("later"));
    }

    #[test]
    fn create_zip_captures_the_contents_at_the_time() {
        let p = with_files(&[("/a/one.txt", "first")]);
        let entries = vec![ArchiveEntry {
            source: at("/a/one.txt"),
            name: "one.txt".to_owned(),
        }];
        p.create_zip(&at("/out/bug.zip"), &entries).expect("zip");
        p.write(&at("/a/one.txt"), b"changed").expect("write");

        let zipped = p.records().zipped;
        assert_eq!(zipped.len(), 1);
        assert_eq!(
            zipped[0].contents.get("one.txt").map(String::as_str),
            Some("first")
        );
    }

    #[test]
    fn create_zip_of_an_absent_source_fails() {
        let p = MemoryPlatform::default();
        let entries = vec![ArchiveEntry {
            source: at("/gone"),
            name: "gone".to_owned(),
        }];
        assert!(p.create_zip(&at("/out.zip"), &entries).is_err());
    }

    #[test]
    fn hashes_match_the_published_digests_of_an_empty_file() {
        let p = with_files(&[("/empty", "")]);
        assert_eq!(
            Hashing::sha256(&p, &at("/empty")).expect("sha256"),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            Hashing::md5(&p, &at("/empty")).expect("md5"),
            "d41d8cd98f00b204e9800998ecf8427e"
        );
    }

    #[test]
    fn paths_default_under_the_home_directory() {
        let p = MemoryPlatform::default();
        assert_eq!(Paths::home(&p), at("/home/tester"));
        assert_eq!(Paths::config(&p), at("/home/tester/.config/zax"));
        assert_eq!(Paths::cache(&p), at("/home/tester/.cache/zax"));
    }
}

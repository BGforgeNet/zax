//! sfall's mod load order: `mods/mods_order.txt`, which says what the engine loads out of the `mods`
//! folder and in what order.
//!
//! The rules here are the loader's own rather than what the file looks like. An entry is a path
//! relative to `mods\` naming either a `.dat` archive or a folder; a `;` or a `#` starts a comment and
//! the rest of the line is dropped; separators are normalized and a path that could leave the game
//! folder is refused; an entry naming something absent is skipped. A mod further down the file
//! overrides one above it, and where the same mod is named twice only the last line counts.
//!
//! Disabling is commenting the line out. That is the only representation the format has, and the only
//! one that keeps the mod's place in the order for when it is turned back on.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use zax_core::config_io::SaveOutcome;
use zax_core::directories::backup_directory;
use zax_core::install::Install;
use zax_core::stamp::{LocalTime, stamp};
use zax_core::text::{Line, latin1, latin1_bytes, split_lines};
use zax_platform::fs::FileKind;
use zax_platform::{Platform, Result};

use crate::fission::{fission_enabled, fission_mounts};
use crate::records::{load_record, manifest_of, mod_name};

pub const MODS_DIRECTORY: &str = "mods";
pub const MODS_ORDER_FILE: &str = "mods_order.txt";

/// How the file is named to the user, in one piece rather than assembled at each site that mentions
/// it.
pub const MODS_ORDER_PATH: &str = "mods/mods_order.txt";

/// Which of the two mutually unreadable formats a mod order file is in.
///
/// sfall names a path per line; Fission writes pipe-separated records and skips every line without a
/// pipe, so neither reader tolerates the other's file and each rewrites the whole thing into its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OrderFormat {
    Sfall,
    Fission,
}

impl OrderFormat {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Sfall => "sfall",
            Self::Fission => "fission",
        }
    }
}

/// Where a format's list lives while another engine has the slot.
///
/// Named beside the file they belong to, and invisible to all three readers of that folder: Fission
/// scans for `mod_*.dat`, sfall loads only what the order file names, and the listing below takes
/// directories and `*.dat`.
#[must_use]
pub fn sidecar_file(format: OrderFormat) -> String {
    format!("mods_order.{}.txt", format.as_str())
}

/// Which format a file is in, read from the file rather than from a memory of who ran last.
///
/// Stored state would be wrong in exactly the cases that matter - a crash, a hand edit, a launch that
/// went around ZAX, an install never seen before - and nothing would be left to notice it.
///
/// An empty or comment-only file reads as sfall, which is the safe way round: sfall's format is what
/// ZAX writes, and Fission truncates and rebuilds whatever it finds anyway.
#[must_use]
pub fn order_format_of(text: &str) -> OrderFormat {
    for line in text.lines() {
        let body = line.trim();
        if body.is_empty() {
            continue;
        }
        // The header Fission writes carries a pipe inside a comment, which is why a comment is looked
        // at for that marker rather than for pipes generally.
        if let Some(rest) = body.strip_prefix('#')
            && rest.trim_start().starts_with("FISSION mods_order.txt")
        {
            return OrderFormat::Fission;
        }
        if body.starts_with(';') || body.starts_with('#') {
            continue;
        }
        if body.contains('|') {
            return OrderFormat::Fission;
        }
    }
    OrderFormat::Sfall
}

/// What is on disk under a mod's name. `Missing` is an entry whose file or folder is no longer there.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModKind {
    Dat,
    Folder,
    File,
    Missing,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mod {
    /// The entry as the file writes it, relative to `mods\`.
    pub name: String,
    pub enabled: bool,
    pub kind: ModKind,
    /// The installed mod this entry belongs to, when the record claims it and only it.
    pub owner: Option<String>,
}

/// An installed mod as the order list needs it: what to call it, and what it put in the mods folder.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModOwner {
    pub name: String,
    /// Deployed paths as the record holds them - relative to the install, and under `mods/`.
    pub files: Vec<String>,
}

/// Where an installed mod says its own entries load, as its manifest declares it.
///
/// One claim per mod rather than per entry: a mod that deploys several states one place for all of
/// them.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderClaim {
    /// The entries the claim places, spelled as the order file names them.
    pub entries: Vec<String>,
    /// Entries its own files win over, and entries that win over its own.
    pub overrides: Vec<String>,
    pub overridden_by: Vec<String>,
}

/// The top-level dats among a set of deployed paths, which is what an entry defaults to where none is
/// declared.
#[must_use]
pub fn order_dats(paths: &[String]) -> Vec<String> {
    paths
        .iter()
        .filter_map(|path| {
            let rest = path
                .strip_prefix("mods/")
                .or_else(|| path.strip_prefix("MODS/"))?;
            if rest.contains('/') || !rest.to_lowercase().ends_with(".dat") {
                return None;
            }
            Some(rest.to_owned())
        })
        .collect()
}

/// Something in the mods folder that the engine could load.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModsDirEntry {
    pub name: String,
    pub kind: ModKind,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModsSnapshot {
    /// The order file exactly as read, or `None` when the install has none.
    pub text: Option<String>,
    /// Which engine's format that text is in. sfall for a folder with no order file at all.
    ///
    /// Reported rather than corrected: the file is the user's, and rewriting it because they opened a
    /// tab is a write they did not ask for - it also races an engine ZAX has just started for the file
    /// it is reading.
    pub format: Option<OrderFormat>,
    /// Every name that resolves: what the folder holds, plus anything the file names that exists.
    pub present: Vec<ModsDirEntry>,
    /// What ZAX installed here. The folder cannot say who put a dat there, so this is the only thing
    /// that can tell one a mod deployed from one the user dropped in by hand.
    pub owners: Vec<ModOwner>,
    /// What the installed mods say about where they load.
    pub claims: Vec<OrderClaim>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModsSaveRequest {
    pub install_path: String,
    /// The text the edits were made against, as the read answered it.
    pub original: Option<String>,
    pub mods: Vec<Mod>,
}

fn fold(text: &str) -> String {
    text.to_lowercase()
}

/// Whether a name in `mods/` answers to a mod id - the id itself or `<id>.<ext>`, matched as the
/// loader would.
///
/// The one definition for a fact two flows judge: what presence displays as, and what a recordless
/// uninstall deletes.
#[must_use]
pub fn answers_to_id(name: &str, id: &str) -> bool {
    let name = fold(name);
    let id = fold(id);
    name == id || name.starts_with(&format!("{id}."))
}

/// An entry as the loader reads it: comment stripped, trimmed, separators normalized, leading slashes
/// dropped, and refused outright when it could point outside the game folder.
///
/// `None` when the line names no usable entry.
#[must_use]
pub fn entry_name(text: &str) -> Option<String> {
    let body = match text.find([';', '#']) {
        Some(cut) => &text[..cut],
        None => text,
    };
    let path = body
        .trim()
        .replace('/', "\\")
        .trim_start_matches('\\')
        .to_owned();
    if path.is_empty() || path.contains(':') || path.contains("..\\") {
        return None;
    }
    Some(path)
}

/// One line of the file. `name` is empty for a blank line, and for a comment that names nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
struct OrderLine {
    name: String,
    enabled: bool,
    /// The line without its terminator, kept so an untouched entry is written back byte for byte.
    body: String,
    eol: String,
}

/// Where a leading comment marker ends, or `None` when the line is not commented.
fn comment_marker(body: &str) -> Option<usize> {
    let trimmed = body.trim_start();
    if trimmed.starts_with(';') || trimmed.starts_with('#') {
        let lead = body.len() - trimmed.len();
        Some(lead + 1)
    } else {
        None
    }
}

fn parse_order(text: &str) -> (Vec<OrderLine>, String) {
    let mut lines = Vec::new();
    let mut crlf = 0usize;
    let mut lf = 0usize;
    for Line { body, eol } in split_lines(text.as_bytes()) {
        if eol == b"\r\n" {
            crlf += 1;
        } else if eol == b"\n" {
            lf += 1;
        }
        let body = latin1(body);
        let marker = comment_marker(&body);
        let source = marker.map_or(body.as_str(), |at| &body[at..]);
        lines.push(OrderLine {
            name: entry_name(source).unwrap_or_default(),
            enabled: marker.is_none(),
            body,
            eol: latin1(eol),
        });
    }
    let eol = if crlf >= lf && crlf > 0 { "\r\n" } else { "\n" };
    (lines, eol.to_owned())
}

/// Every name the order file mentions, whether the line is commented out or not.
///
/// An install has to tell a mod the file already places - wherever the user put it, enabled or not -
/// from one the folder listing turned up, which is what the file has no opinion about yet.
#[must_use]
pub fn named_in_order(text: Option<&str>) -> Vec<String> {
    parse_order(text.unwrap_or(""))
        .0
        .into_iter()
        .filter(|line| !line.name.is_empty())
        .map(|line| line.name)
        .collect()
}

/// Which installed mod each entry belongs to, keyed the way the order file spells its entries.
///
/// A deployed path answers for itself, and its first segment answers for the folder it sits in - an
/// entry names the folder rather than the files inside it.
///
/// An entry two mods both claim is left unnamed. One folder holding two mods' files is exactly the
/// case a single name would misreport, and a wrong owner is worse than none: it invites deleting
/// another mod's work.
fn owners_by_entry(owners: &[ModOwner]) -> BTreeMap<String, Option<String>> {
    let mut claims: BTreeMap<String, Option<String>> = BTreeMap::new();
    for owner in owners {
        for file in &owner.files {
            // Every recorded path is under `mods/`, which is where the order file's names start.
            let entry = fold(file).replace('/', "\\");
            let entry = entry.strip_prefix("mods\\").unwrap_or(&entry).to_owned();
            let keys = match entry.find('\\') {
                None => vec![entry.clone()],
                Some(cut) => vec![entry.clone(), entry[..cut].to_owned()],
            };
            for key in keys {
                match claims.get(&key) {
                    None => {
                        claims.insert(key, Some(owner.name.clone()));
                    }
                    Some(Some(held)) if held != &owner.name => {
                        claims.insert(key, None);
                    }
                    Some(_) => {}
                }
            }
        }
    }
    claims
}

/// The mods to show, in load order: what the file names, then whatever sits in the folder it never
/// named.
///
/// A commented line counts as a disabled mod only when it names something actually in the folder.
/// Nothing in the syntax separates `; rpu.dat` from `; the ones below are optional` - both are valid
/// paths - so the folder is what decides, and a note that names nothing stays a note.
#[must_use]
pub fn list_mods(snapshot: &ModsSnapshot) -> Vec<Mod> {
    let present: BTreeMap<String, &ModsDirEntry> = snapshot
        .present
        .iter()
        .map(|entry| (fold(&entry.name), entry))
        .collect();
    let claims = owners_by_entry(&snapshot.owners);
    let owned = |name: &str| claims.get(&fold(name)).cloned().flatten();

    let mut out: Vec<Mod> = Vec::new();
    for line in parse_order(snapshot.text.as_deref().unwrap_or("")).0 {
        if line.name.is_empty() {
            continue;
        }
        let key = fold(&line.name);
        if !line.enabled && !present.contains_key(&key) {
            continue;
        }
        // The loader drops the earlier of two lines naming the same mod, so the last one decides.
        out.retain(|held| fold(&held.name) != key);
        out.push(Mod {
            kind: present
                .get(&key)
                .map_or(ModKind::Missing, |entry| entry.kind),
            owner: owned(&line.name),
            name: line.name,
            enabled: line.enabled,
        });
    }

    let listed: BTreeSet<String> = out.iter().map(|held| fold(&held.name)).collect();
    // In the folder but named nowhere: the engine does not load it, which is what disabled means.
    for entry in &snapshot.present {
        if !listed.contains(&fold(&entry.name)) {
            out.push(Mod {
                name: entry.name.clone(),
                enabled: false,
                kind: entry.kind,
                owner: owned(&entry.name),
            });
        }
    }
    out
}

/// The same line, enabled or not. Prefixing rather than rebuilding keeps the indentation and any note
/// on it.
fn restate(line: &OrderLine, enabled: bool) -> String {
    if line.enabled == enabled {
        return line.body.clone();
    }
    if !enabled {
        return format!("; {}", line.body);
    }
    let trimmed = line.body.trim_start();
    let lead = &line.body[..line.body.len() - trimmed.len()];
    let rest = trimmed
        .strip_prefix(';')
        .or_else(|| trimmed.strip_prefix('#'))
        .unwrap_or(trimmed);
    let rest = rest
        .strip_prefix(' ')
        .or_else(|| rest.strip_prefix('\t'))
        .unwrap_or(rest);
    format!("{lead}{rest}")
}

/// The file that expresses this order, keeping as much of the old one as a reorder can.
///
/// An entry whose state did not change is written back as its own bytes, so nothing about a line the
/// user did not touch changes - not its spacing, not its trailing note. Turning one on or off adds or
/// removes the comment marker and leaves the rest of the line alone.
///
/// Comment lines directly above an entry are that entry's own note and travel with it. Everything else
/// keeps its side of the file: what was above the first entry is the file's header and stays at the
/// top, and prose set off by a blank line joins what was below the last. Blank lines between entries
/// are dropped, being separators for an order that has just changed.
#[must_use]
pub fn write_order(original: Option<&str>, mods: &[Mod]) -> String {
    let (lines, eol) = parse_order(original.unwrap_or(""));
    let named: BTreeSet<String> = mods.iter().map(|held| fold(&held.name)).collect();

    // Which lines are entries is decided against the list being written, not by syntax: a commented
    // line is one mod's line only when it names a mod that is actually here. An uncommented line
    // always is - one naming a mod no longer in the list was dropped on purpose.
    let is_entry = |at: usize| -> bool {
        lines.get(at).is_some_and(|line| {
            !line.name.is_empty() && (line.enabled || named.contains(&fold(&line.name)))
        })
    };
    let is_prose = |at: usize| -> bool {
        lines
            .get(at)
            .is_some_and(|line| !is_entry(at) && !line.body.trim().is_empty())
    };

    let first = (0..lines.len()).find(|at| is_entry(*at));
    let last = (0..lines.len()).rev().find(|at| is_entry(*at));

    /// The run of comment lines sitting directly above an entry, with no blank line between.
    fn preamble(at: usize, is_prose: &dyn Fn(usize) -> bool) -> std::ops::Range<usize> {
        let mut from = at;
        while from > 0 && is_prose(from - 1) {
            from -= 1;
        }
        from..at
    }

    // Whether a comment line belongs to the entry below it: everything down to that entry is comment
    // too.
    let attached = |at: usize| -> bool {
        for i in at + 1..lines.len() {
            if is_entry(i) {
                return true;
            }
            if !is_prose(i) {
                return false;
            }
        }
        false
    };

    let mut pieces: Vec<(String, String)> = Vec::new();
    let head = first.unwrap_or(lines.len());
    // Everything above the first entry is the file's own header and stays at the top.
    for line in &lines[..head] {
        pieces.push((line.body.clone(), line.eol.clone()));
    }

    for held in mods {
        let key = fold(&held.name);
        let at = (0..lines.len())
            .rev()
            .find(|at| is_entry(*at) && fold(&lines[*at].name) == key);
        match at {
            Some(at) => {
                if Some(at) != first {
                    for note in preamble(at, &is_prose) {
                        pieces.push((lines[note].body.clone(), lines[note].eol.clone()));
                    }
                }
                pieces.push((restate(&lines[at], held.enabled), lines[at].eol.clone()));
            }
            None => {
                let text = if held.enabled {
                    held.name.clone()
                } else {
                    format!("; {}", held.name)
                };
                pieces.push((text, eol.clone()));
            }
        }
    }

    if let (Some(first), Some(last)) = (first, last) {
        let loose: Vec<usize> = (first + 1..last)
            .filter(|at| is_prose(*at) && !attached(*at))
            .collect();
        for at in loose.into_iter().chain(last + 1..lines.len()) {
            pieces.push((lines[at].body.clone(), lines[at].eol.clone()));
        }
    }

    // Every line but the last is terminated: one that was the file's last and now is not would
    // otherwise run into the line below it. Ending without a newline is a property of the file rather
    // than of whichever line has drifted to the bottom.
    let ends_bare = lines.last().is_some_and(|line| line.eol.is_empty());
    let count = pieces.len();
    pieces
        .into_iter()
        .enumerate()
        .map(|(i, (text, held))| {
            if ends_bare && i + 1 == count {
                text
            } else {
                let terminator = if held.is_empty() { &eol } else { &held };
                format!("{text}{terminator}")
            }
        })
        .collect()
}

fn order_path(install_path: &Path) -> PathBuf {
    install_path.join(MODS_DIRECTORY).join(MODS_ORDER_FILE)
}

fn sidecar_path(install_path: &Path, format: OrderFormat) -> PathBuf {
    install_path.join(MODS_DIRECTORY).join(sidecar_file(format))
}

fn read_latin1(platform: &dyn Platform, at: &Path) -> Result<Option<String>> {
    if platform.fs().stat(at)?.map(|s| s.kind) == Some(FileKind::File) {
        Ok(Some(latin1(&platform.fs().read(at)?)))
    } else {
        Ok(None)
    }
}

/// Reads the order file and the folder beside it. Neither existing is an ordinary answer, not a
/// failure.
///
/// Reads only. The slot is swapped where an engine is about to read it, which is the launch, and
/// nowhere else: a read that rewrites the file races whatever ZAX has just started, and rewrites the
/// user's mod order because they opened a tab.
///
/// # Errors
///
/// Fails when the folder or the record cannot be read.
pub fn read_mods(platform: &dyn Platform, install: &Install) -> Result<ModsSnapshot> {
    let root = Path::new(&install.path);
    let directory = root.join(MODS_DIRECTORY);
    let text = read_latin1(platform, &directory.join(MODS_ORDER_FILE))?;

    let mut present: BTreeMap<String, ModsDirEntry> = BTreeMap::new();
    if platform.fs().stat(&directory)?.map(|s| s.kind) == Some(FileKind::Dir) {
        for entry in platform.fs().list(&directory)? {
            if entry.kind == FileKind::Dir {
                present.insert(
                    fold(&entry.name),
                    ModsDirEntry {
                        name: entry.name,
                        kind: ModKind::Folder,
                    },
                );
            } else if entry.name.to_lowercase().ends_with(".dat") {
                // Loose files other than archives are the folder's own clutter - a readme, the order
                // file itself - and offering them as mods would offer something the engine cannot
                // load.
                present.insert(
                    fold(&entry.name),
                    ModsDirEntry {
                        name: entry.name,
                        kind: ModKind::Dat,
                    },
                );
            }
        }
    }

    // An entry may name a path further down - `patches\extra.dat` - which one listing never reaches.
    for name in named_in_order(text.as_deref()) {
        if present.contains_key(&fold(&name)) {
            continue;
        }
        let mut at = directory.clone();
        for part in name.split('\\').filter(|part| !part.is_empty()) {
            at.push(part);
        }
        let kind = match platform.fs().stat(&at)?.map(|s| s.kind) {
            Some(FileKind::Dir) => Some(ModKind::Folder),
            Some(FileKind::File) if name.to_lowercase().ends_with(".dat") => Some(ModKind::Dat),
            Some(FileKind::File) => Some(ModKind::File),
            _ => None,
        };
        if let Some(kind) = kind {
            present.insert(fold(&name), ModsDirEntry { name, kind });
        }
    }

    // Incomplete entries name their mod too: an install that stopped half way still put those files
    // there.
    let record = load_record(platform, &install.path)?;
    let owners: Vec<ModOwner> = record
        .mods
        .iter()
        .map(|held| ModOwner {
            name: mod_name(held),
            files: held.files.clone(),
        })
        .collect();
    // A mod that declared no place contributes nothing, and one whose entries were never declared is
    // placed by the dats it deployed.
    let claims: Vec<OrderClaim> = record
        .mods
        .iter()
        .filter_map(|held| {
            let order = manifest_of(held)?.order?;
            let entries = if held.entries.is_empty() {
                order_dats(&held.files)
            } else {
                held.entries.clone()
            };
            Some(OrderClaim {
                entries,
                overrides: order.overrides,
                overridden_by: order.overridden_by,
            })
        })
        .collect();

    let mut listed: Vec<ModsDirEntry> = present.into_values().collect();
    listed.sort_by_key(|entry| fold(&entry.name));

    Ok(ModsSnapshot {
        format: Some(text.as_deref().map_or(OrderFormat::Sfall, order_format_of)),
        text,
        present: listed,
        owners,
        claims,
    })
}

/// Writes the order back, refusing a file that changed underneath - the guarantee a config file save
/// makes, for a file the user is equally likely to hand-edit.
///
/// # Errors
///
/// Fails when the file cannot be read or written.
pub fn save_mods(platform: &dyn Platform, request: &ModsSaveRequest) -> Result<SaveOutcome> {
    let at = order_path(Path::new(&request.install_path));
    let current = read_latin1(platform, &at)?;
    if current != request.original {
        return Ok(SaveOutcome::Stale(vec![MODS_ORDER_PATH.to_owned()]));
    }
    let body = write_order(current.as_deref(), &request.mods);
    platform.fs().write(&at, &latin1_bytes(&body))?;
    Ok(SaveOutcome::Written(vec![MODS_ORDER_PATH.to_owned()]))
}

/// What a launch would change about the mod order, when it would change anything.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderSwap {
    /// The format the file is in now, and the one the engine about to run reads.
    pub from: OrderFormat,
    pub to: OrderFormat,
    /// Loading now and not after, by the name each has in the mods folder.
    pub losing: Vec<String>,
    /// Loading after and not now.
    pub gaining: Vec<String>,
}

/// What each format would load out of this folder, by file name.
///
/// sfall loads the entries its list leaves uncommented. Fission loads the dats its own list has
/// enabled - or, where it has no list here yet, every `mod_*.dat` in the folder, since its first run
/// scans the folder and turns on everything it finds.
fn would_load(format: OrderFormat, text: Option<&str>, present: &BTreeSet<String>) -> Vec<String> {
    match format {
        OrderFormat::Sfall => {
            let snapshot = ModsSnapshot {
                text: text.map(ToOwned::to_owned),
                format: Some(format),
                present: present
                    .iter()
                    .map(|name| ModsDirEntry {
                        name: name.clone(),
                        kind: ModKind::Dat,
                    })
                    .collect(),
                ..ModsSnapshot::default()
            };
            list_mods(&snapshot)
                .into_iter()
                .filter(|held| held.enabled && held.kind != ModKind::Missing)
                .map(|held| held.name)
                .collect()
        }
        OrderFormat::Fission => {
            let enabled = match text {
                Some(text) => fission_enabled(text),
                None => present
                    .iter()
                    .filter(|name| fission_mounts(name))
                    .cloned()
                    .collect(),
            };
            enabled
                .into_iter()
                .filter(|name| present.contains(name))
                .collect()
        }
    }
}

fn mods_folder_names(platform: &dyn Platform, directory: &Path) -> Result<BTreeSet<String>> {
    let mut present = BTreeSet::new();
    if platform.fs().stat(directory)?.map(|s| s.kind) == Some(FileKind::Dir) {
        for entry in platform.fs().list(directory)? {
            if entry.kind == FileKind::Dir || entry.name.to_lowercase().ends_with(".dat") {
                present.insert(entry.name);
            }
        }
    }
    Ok(present)
}

/// What launching an engine that reads `wanted` would do to this folder's mod order, or `None` where
/// it would do nothing.
///
/// Read before the launch, so the user is told what is about to change while it can still be
/// cancelled.
///
/// # Errors
///
/// Fails when the folder cannot be read.
pub fn preview_order_swap(
    platform: &dyn Platform,
    install_path: &Path,
    wanted: OrderFormat,
) -> Result<Option<OrderSwap>> {
    let held = read_latin1(platform, &order_path(install_path))?;
    let from = held.as_deref().map_or(OrderFormat::Sfall, order_format_of);
    if from == wanted {
        return Ok(None);
    }

    let directory = install_path.join(MODS_DIRECTORY);
    let present = mods_folder_names(platform, &directory)?;
    let kept = read_latin1(platform, &directory.join(sidecar_file(wanted)))?;

    let now = would_load(from, held.as_deref(), &present);
    let next = would_load(wanted, kept.as_deref(), &present);
    Ok(Some(OrderSwap {
        from,
        to: wanted,
        losing: now
            .iter()
            .filter(|name| !next.contains(name))
            .cloned()
            .collect(),
        gaining: next
            .iter()
            .filter(|name| !now.contains(name))
            .cloned()
            .collect(),
    }))
}

/// Puts the list `wanted` reads into the slot, filing whatever was there under the format it is in.
///
/// A sidecar is only ever written by copying the slot, so it cannot hold something the slot never
/// held. Where the wanted sidecar does not exist the slot is cleared rather than left holding the
/// other format's file: that is a first run for this engine, and it builds its own. Idempotent, so a
/// repeated or interrupted swap costs nothing.
///
/// # Errors
///
/// Fails when the slot or a sidecar cannot be read, copied or removed.
pub fn swap_order_to(
    platform: &dyn Platform,
    install_path: &Path,
    wanted: OrderFormat,
) -> Result<()> {
    let slot = order_path(install_path);
    let held = read_latin1(platform, &slot)?;
    if let Some(text) = &held {
        let format = order_format_of(text);
        if format == wanted {
            return Ok(());
        }
        // Copied rather than rewritten from parsed lines: the file is the user's, and only a
        // byte-for-byte copy promises to give back what a hand-edit put there.
        platform
            .fs()
            .copy(&slot, &sidecar_path(install_path, format))?;
    }
    let sidecar = sidecar_path(install_path, wanted);
    if platform.fs().stat(&sidecar)?.map(|s| s.kind) == Some(FileKind::File) {
        platform.fs().copy(&sidecar, &slot)
    } else if held.is_some() {
        platform.fs().remove(&slot)
    } else {
        Ok(())
    }
}

/// Puts the order file back to text captured earlier, rather than to an order computed from what is on
/// disk now.
///
/// An unwound install has to leave the file as it found it, and what a mod's lines looked like is not
/// derivable afterwards: a dat the install enabled may have been sitting there disabled, and every
/// rule for rebuilding the file from the folder would enable it again. `None` is when there was no
/// file, which restoring means deleting the one the install created.
///
/// # Errors
///
/// Fails when the file cannot be copied aside, written or removed.
pub fn restore_order(
    platform: &dyn Platform,
    install_path: &Path,
    text: Option<&str>,
    now: LocalTime,
) -> Result<()> {
    let at = order_path(install_path);
    let current = read_latin1(platform, &at)?;
    if current.as_deref() == text {
        return Ok(());
    }
    if current.is_some() {
        let backup = backup_directory(platform)
            .join(stamp(now))
            .join(MODS_DIRECTORY)
            .join(MODS_ORDER_FILE);
        platform.fs().copy(&at, &backup)?;
    }
    match text {
        None => platform.fs().remove(&at),
        Some(text) => platform.fs().write(&at, &latin1_bytes(text)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use zax_core::install::GameType;
    use zax_platform::memory::{Content, MemoryOptions, MemoryPlatform};

    fn snapshot(text: &str, present: &[(&str, ModKind)]) -> ModsSnapshot {
        ModsSnapshot {
            text: Some(text.to_owned()),
            format: Some(OrderFormat::Sfall),
            present: present
                .iter()
                .map(|(name, kind)| ModsDirEntry {
                    name: (*name).to_owned(),
                    kind: *kind,
                })
                .collect(),
            ..ModsSnapshot::default()
        }
    }

    fn names(mods: &[Mod]) -> Vec<&str> {
        mods.iter().map(|held| held.name.as_str()).collect()
    }

    fn enabled_mod(name: &str) -> Mod {
        Mod {
            name: name.to_owned(),
            enabled: true,
            kind: ModKind::Dat,
            owner: None,
        }
    }

    #[test]
    fn a_line_is_read_as_the_loader_reads_it() {
        assert_eq!(entry_name("rpu.dat").as_deref(), Some("rpu.dat"));
        assert_eq!(entry_name("  rpu.dat  ").as_deref(), Some("rpu.dat"));
        assert_eq!(
            entry_name("patches/extra.dat").as_deref(),
            Some("patches\\extra.dat")
        );
        assert_eq!(entry_name("/rpu.dat").as_deref(), Some("rpu.dat"));
        assert_eq!(entry_name("rpu.dat ; a note").as_deref(), Some("rpu.dat"));
    }

    #[test]
    fn a_line_that_could_leave_the_game_folder_is_refused() {
        assert_eq!(entry_name("../outside.dat"), None);
        assert_eq!(entry_name("..\\outside.dat"), None);
        assert_eq!(entry_name("C:\\elsewhere.dat"), None);
        assert_eq!(entry_name(""), None);
        assert_eq!(entry_name("; just a note"), None);
    }

    #[test]
    fn the_format_is_read_from_the_file_rather_than_remembered() {
        assert_eq!(order_format_of(""), OrderFormat::Sfall);
        assert_eq!(order_format_of("; a note\nrpu.dat\n"), OrderFormat::Sfall);
        assert_eq!(order_format_of("1|ecco|cached\n"), OrderFormat::Fission);
        assert_eq!(
            order_format_of("# FISSION mods_order.txt\n# name|dat\n"),
            OrderFormat::Fission
        );
    }

    #[test]
    fn an_empty_file_reads_as_sfall_which_is_the_safe_way_round() {
        assert_eq!(order_format_of("\n\n; nothing here\n"), OrderFormat::Sfall);
    }

    #[test]
    fn the_file_names_the_order_and_the_folder_supplies_the_rest() {
        let snapshot = snapshot(
            "rpu.dat\n; ecco.dat\n",
            &[
                ("rpu.dat", ModKind::Dat),
                ("ecco.dat", ModKind::Dat),
                ("extra.dat", ModKind::Dat),
            ],
        );
        let mods = list_mods(&snapshot);
        assert_eq!(names(&mods), vec!["rpu.dat", "ecco.dat", "extra.dat"]);
        assert!(mods[0].enabled);
        assert!(!mods[1].enabled, "a commented line is a disabled mod");
        assert!(
            !mods[2].enabled,
            "named nowhere means the engine does not load it"
        );
    }

    #[test]
    fn a_note_that_names_nothing_in_the_folder_stays_a_note() {
        // Nothing in the syntax separates it from a disabled mod, so the folder decides.
        let snapshot = snapshot(
            "; the ones below are optional\nrpu.dat\n",
            &[("rpu.dat", ModKind::Dat)],
        );
        assert_eq!(names(&list_mods(&snapshot)), vec!["rpu.dat"]);
    }

    #[test]
    fn where_one_mod_is_named_twice_the_last_line_decides() {
        let snapshot = snapshot(
            "rpu.dat\necco.dat\nrpu.dat\n",
            &[("rpu.dat", ModKind::Dat), ("ecco.dat", ModKind::Dat)],
        );
        assert_eq!(names(&list_mods(&snapshot)), vec!["ecco.dat", "rpu.dat"]);
    }

    #[test]
    fn an_entry_naming_something_absent_reads_as_missing() {
        let snapshot = snapshot("gone.dat\n", &[]);
        let mods = list_mods(&snapshot);
        assert_eq!(mods.len(), 1);
        assert_eq!(mods[0].kind, ModKind::Missing);
    }

    #[test]
    fn an_entry_two_mods_both_claim_is_left_unnamed() {
        // A wrong owner invites deleting another mod's work.
        let mut snapshot = snapshot("shared\n", &[("shared", ModKind::Folder)]);
        snapshot.owners = vec![
            ModOwner {
                name: "One".to_owned(),
                files: vec!["mods/shared/a.dat".to_owned()],
            },
            ModOwner {
                name: "Two".to_owned(),
                files: vec!["mods/shared/b.dat".to_owned()],
            },
        ];
        assert_eq!(list_mods(&snapshot)[0].owner, None);
    }

    #[test]
    fn an_entry_one_mod_claims_names_it() {
        let mut snapshot = snapshot("ecco.dat\n", &[("ecco.dat", ModKind::Dat)]);
        snapshot.owners = vec![ModOwner {
            name: "EcCo".to_owned(),
            files: vec!["mods/ecco.dat".to_owned()],
        }];
        assert_eq!(list_mods(&snapshot)[0].owner.as_deref(), Some("EcCo"));
    }

    #[test]
    fn a_folder_entry_is_claimed_by_its_first_segment() {
        let mut snapshot = snapshot("ecco\n", &[("ecco", ModKind::Folder)]);
        snapshot.owners = vec![ModOwner {
            name: "EcCo".to_owned(),
            files: vec!["mods/ecco/data/x.frm".to_owned()],
        }];
        assert_eq!(list_mods(&snapshot)[0].owner.as_deref(), Some("EcCo"));
    }

    #[test]
    fn a_line_nobody_touched_is_written_back_byte_for_byte() {
        let original = "  rpu.dat   ; killap's\necco.dat\n";
        let mods = vec![enabled_mod("rpu.dat"), enabled_mod("ecco.dat")];
        assert_eq!(write_order(Some(original), &mods), original);
    }

    #[test]
    fn turning_one_off_adds_the_marker_and_leaves_the_rest_alone() {
        let original = "rpu.dat ; killap's\n";
        let mods = vec![Mod {
            enabled: false,
            ..enabled_mod("rpu.dat")
        }];
        assert_eq!(write_order(Some(original), &mods), "; rpu.dat ; killap's\n");
    }

    #[test]
    fn turning_one_on_removes_the_marker() {
        let original = "; rpu.dat\n";
        let mods = vec![enabled_mod("rpu.dat")];
        assert_eq!(write_order(Some(original), &mods), "rpu.dat\n");
    }

    #[test]
    fn the_files_header_stays_at_the_top() {
        // A note above the first entry reads as the file's rather than as that mod's.
        let original = "; sfall load order\n; edit with care\nrpu.dat\necco.dat\n";
        let mods = vec![enabled_mod("ecco.dat"), enabled_mod("rpu.dat")];
        let written = write_order(Some(original), &mods);
        assert!(
            written.starts_with("; sfall load order\n; edit with care\n"),
            "{written}"
        );
        assert!(written.ends_with("ecco.dat\nrpu.dat\n"), "{written}");
    }

    #[test]
    fn a_note_directly_above_an_entry_travels_with_it() {
        let original = "first.dat\n; about ecco\necco.dat\n";
        let mods = vec![enabled_mod("ecco.dat"), enabled_mod("first.dat")];
        let written = write_order(Some(original), &mods);
        assert!(
            written.contains("; about ecco\necco.dat"),
            "the note must stay with its entry: {written}"
        );
    }

    #[test]
    fn a_mod_the_file_never_named_is_appended() {
        let mods = vec![enabled_mod("rpu.dat"), enabled_mod("fresh.dat")];
        assert_eq!(
            write_order(Some("rpu.dat\n"), &mods),
            "rpu.dat\nfresh.dat\n"
        );
    }

    #[test]
    fn a_new_disabled_mod_is_written_commented_out() {
        let mods = vec![Mod {
            enabled: false,
            ..enabled_mod("fresh.dat")
        }];
        assert_eq!(write_order(None, &mods), "; fresh.dat\n");
    }

    #[test]
    fn a_file_that_ended_without_a_newline_still_does() {
        let original = "rpu.dat\necco.dat";
        let mods = vec![enabled_mod("rpu.dat"), enabled_mod("ecco.dat")];
        assert_eq!(write_order(Some(original), &mods), original);
    }

    #[test]
    fn a_dropped_mod_is_not_written_back() {
        // One naming a mod no longer in the list was dropped on purpose.
        let original = "rpu.dat\necco.dat\n";
        let mods = vec![enabled_mod("rpu.dat")];
        assert_eq!(write_order(Some(original), &mods), "rpu.dat\n");
    }

    #[test]
    fn the_top_level_dats_of_a_deployment_are_its_default_entries() {
        let files = vec![
            "mods/ecco.dat".to_owned(),
            "mods/ecco/data/x.frm".to_owned(),
            "mods/patches/extra.dat".to_owned(),
        ];
        assert_eq!(order_dats(&files), vec!["ecco.dat".to_owned()]);
    }

    #[test]
    fn a_name_answers_to_an_id_as_the_loader_would() {
        assert!(answers_to_id("ecco", "ecco"));
        assert!(answers_to_id("ECCO.dat", "ecco"));
        assert!(!answers_to_id("ecco2.dat", "ecco"));
        assert!(!answers_to_id("other.dat", "ecco"));
    }

    fn platform_with(files: &[(&str, &str)]) -> MemoryPlatform {
        MemoryPlatform::new(MemoryOptions {
            files: files
                .iter()
                .map(|(p, c)| ((*p).to_owned(), Content::from(*c)))
                .collect(),
            ..MemoryOptions::default()
        })
    }

    fn install() -> Install {
        Install::new("/games/f2", GameType::Fallout2)
    }

    #[test]
    fn a_folder_with_no_order_file_is_an_ordinary_answer() {
        let platform = platform_with(&[("/games/f2/mods/ecco.dat", "dat")]);
        let snapshot = read_mods(&platform, &install()).expect("read");
        assert_eq!(snapshot.text, None);
        assert_eq!(snapshot.format, Some(OrderFormat::Sfall));
        assert_eq!(snapshot.present.len(), 1);
    }

    #[test]
    fn loose_files_that_are_not_archives_are_the_folders_own_clutter() {
        let platform = platform_with(&[
            ("/games/f2/mods/ecco.dat", "dat"),
            ("/games/f2/mods/readme.txt", "hello"),
        ]);
        let snapshot = read_mods(&platform, &install()).expect("read");
        assert_eq!(
            snapshot
                .present
                .iter()
                .map(|e| e.name.as_str())
                .collect::<Vec<_>>(),
            vec!["ecco.dat"]
        );
    }

    #[test]
    fn an_entry_deeper_than_the_listing_reaches_is_looked_up_on_its_own() {
        let platform = platform_with(&[
            ("/games/f2/mods/mods_order.txt", "patches\\extra.dat\n"),
            ("/games/f2/mods/patches/extra.dat", "dat"),
        ]);
        let snapshot = read_mods(&platform, &install()).expect("read");
        assert!(
            snapshot
                .present
                .iter()
                .any(|e| e.name == "patches\\extra.dat"),
            "{:?}",
            snapshot.present
        );
    }

    #[test]
    fn a_save_refuses_a_file_that_changed_underneath() {
        let platform = platform_with(&[("/games/f2/mods/mods_order.txt", "rpu.dat\n")]);
        let request = ModsSaveRequest {
            install_path: "/games/f2".to_owned(),
            original: Some("something else\n".to_owned()),
            mods: vec![enabled_mod("rpu.dat")],
        };
        assert_eq!(
            save_mods(&platform, &request).expect("save"),
            SaveOutcome::Stale(vec![MODS_ORDER_PATH.to_owned()])
        );
        assert_eq!(
            platform.text_at("/games/f2/mods/mods_order.txt").as_deref(),
            Some("rpu.dat\n"),
            "the hand edit must survive"
        );
    }

    #[test]
    fn a_save_writes_the_new_order() {
        let platform = platform_with(&[("/games/f2/mods/mods_order.txt", "rpu.dat\necco.dat\n")]);
        let request = ModsSaveRequest {
            install_path: "/games/f2".to_owned(),
            original: Some("rpu.dat\necco.dat\n".to_owned()),
            mods: vec![enabled_mod("ecco.dat"), enabled_mod("rpu.dat")],
        };
        save_mods(&platform, &request).expect("save");
        assert_eq!(
            platform.text_at("/games/f2/mods/mods_order.txt").as_deref(),
            Some("ecco.dat\nrpu.dat\n")
        );
    }

    #[test]
    fn a_swap_files_the_old_list_under_its_own_format() {
        let platform = platform_with(&[("/games/f2/mods/mods_order.txt", "rpu.dat\n")]);
        swap_order_to(&platform, Path::new("/games/f2"), OrderFormat::Fission).expect("swap");
        assert_eq!(
            platform
                .text_at("/games/f2/mods/mods_order.sfall.txt")
                .as_deref(),
            Some("rpu.dat\n"),
            "the sfall list must be filed"
        );
        assert_eq!(
            platform.text_at("/games/f2/mods/mods_order.txt"),
            None,
            "a first run for this engine clears the slot"
        );
    }

    #[test]
    fn a_swap_back_restores_the_filed_list_byte_for_byte() {
        let platform = platform_with(&[("/games/f2/mods/mods_order.txt", "  rpu.dat ; a note\n")]);
        swap_order_to(&platform, Path::new("/games/f2"), OrderFormat::Fission).expect("out");
        platform
            .fs()
            .write(Path::new("/games/f2/mods/mods_order.txt"), b"1|ecco\n")
            .expect("the engine writes its own");
        swap_order_to(&platform, Path::new("/games/f2"), OrderFormat::Sfall).expect("back");

        assert_eq!(
            platform.text_at("/games/f2/mods/mods_order.txt").as_deref(),
            Some("  rpu.dat ; a note\n")
        );
    }

    #[test]
    fn a_swap_to_the_format_already_there_changes_nothing() {
        let platform = platform_with(&[("/games/f2/mods/mods_order.txt", "rpu.dat\n")]);
        swap_order_to(&platform, Path::new("/games/f2"), OrderFormat::Sfall).expect("swap");
        assert_eq!(
            platform.text_at("/games/f2/mods/mods_order.sfall.txt"),
            None
        );
    }

    #[test]
    fn a_preview_says_what_a_launch_would_change() {
        let platform = platform_with(&[
            ("/games/f2/mods/mods_order.txt", "ecco.dat\nmod_rpu.dat\n"),
            ("/games/f2/mods/ecco.dat", "dat"),
            ("/games/f2/mods/mod_rpu.dat", "dat"),
        ]);
        let swap = preview_order_swap(&platform, Path::new("/games/f2"), OrderFormat::Fission)
            .expect("preview")
            .expect("a change");
        assert_eq!(swap.from, OrderFormat::Sfall);
        assert_eq!(swap.to, OrderFormat::Fission);
        // Fission's first run scans the folder and turns on every mod_*.dat it finds.
        assert!(swap.losing.contains(&"ecco.dat".to_owned()), "{swap:?}");
        assert!(swap.gaining.is_empty(), "{swap:?}");
    }

    #[test]
    fn a_preview_of_the_format_already_there_answers_nothing() {
        let platform = platform_with(&[("/games/f2/mods/mods_order.txt", "rpu.dat\n")]);
        assert_eq!(
            preview_order_swap(&platform, Path::new("/games/f2"), OrderFormat::Sfall)
                .expect("preview"),
            None
        );
    }

    fn now() -> LocalTime {
        LocalTime {
            year: 2026,
            month: 9,
            day: 16,
            hour: 12,
            minute: 0,
            second: 0,
        }
    }

    #[test]
    fn restoring_puts_back_the_text_that_was_captured() {
        // What a mod's lines looked like is not derivable from the folder afterwards.
        let platform = platform_with(&[("/games/f2/mods/mods_order.txt", "; ecco.dat\nrpu.dat\n")]);
        restore_order(
            &platform,
            Path::new("/games/f2"),
            Some("; ecco.dat\n"),
            now(),
        )
        .expect("restore");
        assert_eq!(
            platform.text_at("/games/f2/mods/mods_order.txt").as_deref(),
            Some("; ecco.dat\n")
        );
    }

    #[test]
    fn restoring_to_nothing_deletes_the_file_the_install_created() {
        let platform = platform_with(&[("/games/f2/mods/mods_order.txt", "ecco.dat\n")]);
        restore_order(&platform, Path::new("/games/f2"), None, now()).expect("restore");
        assert_eq!(platform.text_at("/games/f2/mods/mods_order.txt"), None);
    }

    #[test]
    fn restoring_what_is_already_there_writes_nothing() {
        let platform = platform_with(&[("/games/f2/mods/mods_order.txt", "ecco.dat\n")]);
        restore_order(&platform, Path::new("/games/f2"), Some("ecco.dat\n"), now())
            .expect("restore");
        assert!(
            platform.all_files().iter().all(|p| !p.contains("backup")),
            "nothing should have been copied aside"
        );
    }
}

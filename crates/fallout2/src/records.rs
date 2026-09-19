//! What ZAX installed into each game directory, kept in ZAX's own data.
//!
//! One UTF-8 YAML file per install, beside `zax.yml` rather than under the cache: the cache is what
//! users and ZAX's own wipe buttons feel free to clear, and clearing caches must not erase the
//! knowledge of what is installed where.
//!
//! The record only adds what the directory cannot say - version, provenance, deployed files, the
//! manifest and state files as the release shipped them. Presence still comes from reading the
//! directory on every load, so losing the records degrades to today's situation: mods are seen but
//! unversioned.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use yaml_rust2::{Yaml, YamlEmitter, YamlLoader};
use zax_core::discovery::identify_install;
use zax_core::hash::fnv1a;
use zax_core::install::GameType;
use zax_platform::fs::FileKind;
use zax_platform::{Error, Platform, Result};

use crate::manifest::{
    ManifestDefaults, ModManifest, ModType, inside_mods, is_confined, is_mod_id, is_mod_version,
    may_write, parse_manifest,
};
use crate::mod_created::created_install_path;
use crate::mod_grants::grants_for;

/// Bumped when the meaning of a field changes - the same rule the manifest's `spec` carries, and read
/// as the same kind of floor: a record stating a later format is one this version may read but must
/// not write.
const RECORD_FORMAT: i64 = 1;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct InstalledMod {
    /// Bound to the manifest's own id shape: it names a working directory, and a record is a file on
    /// disk.
    pub id: String,
    pub version: String,
    /// The manifest's type as it was validated at install time, and the reason a permanent one gives.
    ///
    /// Held as its own field rather than read back out of the manifest snapshot below, so a removal
    /// is judged against something this version parsed rather than against a document a newer ZAX may
    /// have written.
    pub mod_type: Option<ModType>,
    pub reason: Option<String>,
    /// False from the first byte deployed until the install finished, so a relaunch offers retry or
    /// restore.
    pub complete: bool,
    /// Deployed paths relative to the install, every one under `mods/` - what uninstall deletes.
    pub files: Vec<String>,
    /// The mods-folder entries the release declared, as its manifest spelled them - what uninstall
    /// removes from the order file. Held rather than re-derived from `files`, which cannot name a
    /// folder entry at all.
    pub entries: Vec<String>,
    /// Which parts were chosen, by id. What an upgrade re-installs without asking, and the reason a
    /// part id is permanent: a renamed part reads here as one part removed and another added.
    pub parts: Vec<String>,
    /// The manifest exactly as the release carried it: schema and state list readable without the
    /// network.
    pub manifest: String,
    /// State files as that release shipped them, latin1 text - the base an upgrade's merge compares
    /// against. Text rather than bytes because that is what the YAML file holds; a caller merging
    /// against them encodes back to latin1 at the boundary. While a base install is unfinished, it holds
    /// the stand-in base that install merges against, which a retry could no longer read from the folder.
    pub shipped: BTreeMap<String, String>,
    /// A base install's state files as they were before its installer first ran, latin1 text, held
    /// while the install is unfinished. An interrupted installer leaves its own copies in the folder,
    /// so a retry that read the folder instead would put those back as the user's settings.
    ///
    /// Not sent across the command boundary, for the reason `carried` is not.
    #[serde(skip)]
    pub before: BTreeMap<String, String>,
    /// Fields this version has no rule for, kept as read and written back unchanged.
    ///
    /// A later ZAX may record more per mod than this one knows, and rewriting the file for an
    /// unrelated install would otherwise throw that away while every field this one knows
    /// round-tripped.
    ///
    /// Not sent across the command boundary: it is the record's own business, the interface has
    /// nothing to do with it, and a value this version cannot interpret has no meaning to give a
    /// renderer.
    #[serde(skip)]
    pub carried: BTreeMap<String, Yaml>,
}

/// An entry this version could not validate, kept whole so a rewrite from here does not erase it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpaqueMod {
    /// The id it states, where that much is readable - enough to refuse to install over what it
    /// describes.
    pub id: Option<String>,
    /// The entry exactly as it was read.
    pub raw: Yaml,
}

/// An engine ZAX put into this install.
///
/// Not a mod: it deploys outside `mods/`, so none of the manifest machinery applies to it, and what
/// it needs recording is only what the directory cannot say - which release these bytes are.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct InstalledEngine {
    pub id: String,
    /// The release's tag, as published. `continious` for a project that republishes one release in
    /// place.
    pub release: String,
    /// When that release was published, ISO 8601. The version, where a project publishes none.
    pub published: String,
    /// False from the first byte deployed until the install finished, so a crash is visible as one.
    pub complete: bool,
    /// Top-level entries deployed into the install, relative to it. A macOS bundle is one directory
    /// entry.
    pub files: Vec<String>,
    /// Where copies of anything replaced went, absent when nothing was.
    pub backup: Option<String>,
    /// The commit that release was built from, absent where the project's tag did not resolve to one.
    pub commit: Option<String>,
    /// True where the user picked this build by name. False means the folder follows the newest build
    /// the machine holds, so fetching a newer one moves it forward on the next run.
    pub pinned: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InstallRecord {
    /// The install directory, in clear - the filename is its hash, which nothing can read back.
    pub path: String,
    pub mods: Vec<InstalledMod>,
    pub engines: Vec<InstalledEngine>,
    /// The base each address of a setting more than one engine carries is measured from, keyed by
    /// `file|section|key`.
    ///
    /// What reconciliation compares against: an address differing from its base is the side that
    /// moved since, so its value is the one to carry to the rest. Losing it degrades to preferring
    /// the setting's own address, not to losing the setting.
    pub written: BTreeMap<String, String>,
    /// Entries this version could not read. Carried through every rewrite and touched by nothing
    /// else.
    pub opaque: Vec<OpaqueMod>,
    /// The format the file states, when that is later than this version writes - what makes it
    /// read-only.
    pub later_format: Option<i64>,
}

fn later_format_message(stated: i64) -> String {
    format!(
        "This game folder's mod record was written by a newer version of ZAX (record format \
         {stated}, this one writes {RECORD_FORMAT}). Update ZAX to install or remove mods here."
    )
}

/// Answers whether this version may act on the record, and on this mod within it.
///
/// Both refusals exist for the same reason: what cannot be read cannot be safely rewritten, and
/// installing over it would leave the files it describes on disk with nothing recording them.
///
/// # Errors
///
/// Answers with wording for the user when the record or the entry is one this version cannot write.
pub fn assert_usable(record: &InstallRecord, id: &str) -> Result<()> {
    if let Some(stated) = record.later_format {
        return Err(Error::Unsupported(later_format_message(stated)));
    }
    if record
        .opaque
        .iter()
        .any(|entry| entry.id.as_deref() == Some(id))
    {
        return Err(Error::Unsupported(format!(
            "\"{id}\" is recorded here in a form this version of ZAX cannot read - most likely \
             written by a newer one. Update ZAX rather than installing over it."
        )));
    }
    Ok(())
}

/// The manifest a record carries, as this version reads it - `None` where it cannot, which a newer
/// ZAX having written the record is enough to produce.
///
/// Everything read back out of a snapshot goes through here, so a record that will not parse costs
/// the same fallback everywhere rather than one per reader.
#[must_use]
pub fn manifest_of(held: &InstalledMod) -> Option<ModManifest> {
    parse_manifest(
        held.manifest.as_bytes(),
        &ManifestDefaults {
            version: Some(held.version.clone()),
            archive: None,
        },
    )
    .ok()
}

/// What to call a recorded mod.
///
/// The manifest snapshot carries the name the author gave it; an id is what is left when that
/// snapshot will not parse, which is the same fallback the availability list makes.
#[must_use]
pub fn mod_name(held: &InstalledMod) -> String {
    manifest_of(held).map_or_else(|| held.id.clone(), |manifest| manifest.name)
}

fn records_directory(platform: &dyn Platform) -> PathBuf {
    platform.paths().config().join("installed-mods")
}

/// Trailing separators dropped, so two spellings of one directory land on one record file.
fn normalize_path(path: &str) -> String {
    path.trim_end_matches(['/', '\\']).to_owned()
}

/// One install directory as a short path-safe name.
///
/// The name carries nothing but uniqueness - the path in clear inside the record is the truth - so a
/// small non-cryptographic hash serves. Exported because a transaction's working directory is keyed
/// by install too, and two spellings of that key would put one install's recovery files where
/// another's are looked for.
#[must_use]
pub fn install_key(install_path: &str) -> String {
    fnv1a(&normalize_path(install_path))
}

fn record_path(platform: &dyn Platform, install_path: &str) -> PathBuf {
    records_directory(platform).join(format!("{}.yml", install_key(install_path)))
}

fn as_text(value: Option<&Yaml>) -> Option<String> {
    value.and_then(Yaml::as_str).map(ToOwned::to_owned)
}

fn field<'a>(fields: &'a yaml_rust2::yaml::Hash, name: &str) -> Option<&'a Yaml> {
    fields.get(&Yaml::String(name.to_owned()))
}

/// What this version writes per mod - everything else in an entry is carried rather than understood.
const MOD_FIELDS: &[&str] = &[
    "id", "version", "type", "reason", "complete", "files", "entries", "parts", "manifest",
    "shipped", "before",
];

/// One recorded mod, or `None` when the entry cannot be trusted.
///
/// Entries are judged one at a time rather than the file whole - a hand-edited or damaged entry costs
/// itself, not every other mod's record - and a file list reaching outside `mods/` drops the entry, so
/// a tampered record degrades to hand-installed instead of aiming uninstall somewhere new.
fn read_mod(entry: &Yaml) -> Option<InstalledMod> {
    let fields = entry.as_hash()?;
    let id = as_text(field(fields, "id"))?;
    let version = as_text(field(fields, "version"))?;
    let manifest = as_text(field(fields, "manifest"))?;
    // Both name a directory under the cache once a transaction opens, so they pass the manifest's own
    // shapes before they are believed - a hand-edited record is the one route into these fields that
    // skipped them.
    if !is_mod_id(&id) || !is_mod_version(&version) {
        return None;
    }

    let mod_type = match as_text(field(fields, "type")).as_deref() {
        Some("pluggable") => Some(ModType::Pluggable),
        Some("permanent") => Some(ModType::Permanent),
        Some("base") => Some(ModType::Base),
        _ => None,
    };

    // Judged against what ZAX grants this id, not against what the entry claims: a record is the one
    // route into these paths that skipped the manifest, so it must not reach further than a manifest
    // could.
    //
    // A base mod is the exception, and the reason is what it is: its installer owns the whole game
    // directory, and the files it keeps for the user sit at the root by the engine's design. The
    // bound that still holds is the install directory itself.
    let granted = grants_for(&id);
    let writable = |path: &str| {
        if mod_type == Some(ModType::Base) {
            is_confined(path)
        } else {
            may_write(path, granted)
        }
    };

    let mut files = Vec::new();
    for file in field(fields, "files")
        .and_then(Yaml::as_vec)
        .into_iter()
        .flatten()
    {
        let path = as_text(Some(file))?;
        if !writable(&path) {
            return None;
        }
        files.push(path);
    }

    // Bounded the way a manifest's own are, so a hand-edited record cannot name an entry a manifest
    // could not. Confined to `mods/` whatever the mod is granted: a grant widens where files land,
    // never what the loader is told to load.
    let mut entries = Vec::new();
    for held in field(fields, "entries")
        .and_then(Yaml::as_vec)
        .into_iter()
        .flatten()
    {
        let name = as_text(Some(held))?;
        if !inside_mods(&format!("mods/{name}")) {
            return None;
        }
        entries.push(name);
    }

    // Bound the way the manifest's own part ids are: a selection names them, and an install reads
    // them back.
    let mut parts = Vec::new();
    for held in field(fields, "parts")
        .and_then(Yaml::as_vec)
        .into_iter()
        .flatten()
    {
        let part = as_text(Some(held))?;
        if !is_mod_id(&part) {
            return None;
        }
        parts.push(part);
    }

    let texts = |name: &str| -> Option<BTreeMap<String, String>> {
        let mut out = BTreeMap::new();
        if let Some(held) = field(fields, name).and_then(Yaml::as_hash) {
            for (path, content) in held {
                let path = as_text(Some(path))?;
                let text = as_text(Some(content))?;
                if !writable(&path) {
                    return None;
                }
                out.insert(path, text);
            }
        }
        Some(out)
    };
    let shipped = texts("shipped")?;
    let before = texts("before")?;

    // Anything this version has no rule for rides along untouched rather than being lost on the next
    // write.
    let mut carried = BTreeMap::new();
    for (key, value) in fields {
        let Some(name) = key.as_str() else {
            continue;
        };
        if !MOD_FIELDS.contains(&name) {
            carried.insert(name.to_owned(), value.clone());
        }
    }

    Some(InstalledMod {
        id,
        version,
        mod_type,
        reason: as_text(field(fields, "reason")),
        complete: field(fields, "complete") == Some(&Yaml::Boolean(true)),
        files,
        entries,
        parts,
        manifest,
        shipped,
        before,
        carried,
    })
}

/// The recorded bases, as text pairs.
///
/// A malformed entry is dropped rather than refusing the whole record: a lost base costs a preference
/// between two values, where a refused record costs the knowledge of what is installed.
fn read_written(entry: Option<&Yaml>) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let Some(hash) = entry.and_then(Yaml::as_hash) else {
        return out;
    };
    for (address, value) in hash {
        let (Some(address), Some(held)) = (as_text(Some(address)), as_text(Some(value))) else {
            continue;
        };
        if address.split('|').count() == 3 {
            out.insert(address, held);
        }
    }
    out
}

/// One recorded engine, or `None` when the entry is not one this version can read.
fn read_engine(entry: &Yaml) -> Option<InstalledEngine> {
    let fields = entry.as_hash()?;
    let id = as_text(field(fields, "id"))?;
    let release = as_text(field(fields, "release"))?;
    let published = as_text(field(fields, "published"))?;

    // Bound the way a base mod's paths are, not the narrower one: an engine deploys at the install
    // root, not under `mods/`. A path that fails it refuses the whole entry, as `read_mod` does.
    let mut files = Vec::new();
    for file in field(fields, "files")
        .and_then(Yaml::as_vec)
        .into_iter()
        .flatten()
    {
        let path = as_text(Some(file))?;
        if !is_confined(&path) {
            return None;
        }
        files.push(path);
    }

    Some(InstalledEngine {
        id,
        release,
        published,
        complete: field(fields, "complete") == Some(&Yaml::Boolean(true)),
        files,
        backup: as_text(field(fields, "backup")),
        commit: as_text(field(fields, "commit")),
        pinned: field(fields, "pinned") == Some(&Yaml::Boolean(true)),
    })
}

/// The record for an install, or the empty one - a first install and a lost record read the same.
///
/// # Errors
///
/// Fails when the file is there but cannot be read at all.
pub fn load_record(platform: &dyn Platform, install_path: &str) -> Result<InstallRecord> {
    let path = normalize_path(install_path);
    let at = record_path(platform, &path);
    let empty = InstallRecord {
        path: path.clone(),
        ..InstallRecord::default()
    };
    if platform.fs().stat(&at)?.map(|s| s.kind) != Some(FileKind::File) {
        return Ok(empty);
    }

    let bytes = platform.fs().read(&at)?;
    let text = String::from_utf8_lossy(&bytes);
    // A record that will not parse is a lost record, which every flow already tolerates - not a crash.
    let Ok(documents) = YamlLoader::load_from_str(&text) else {
        return Ok(empty);
    };
    let Some(root) = documents.first() else {
        return Ok(empty);
    };
    let Some(fields) = root.as_hash() else {
        return Ok(empty);
    };

    let later_format = match field(fields, "record") {
        Some(Yaml::Integer(stated)) if *stated > RECORD_FORMAT => Some(*stated),
        _ => None,
    };

    let mut mods = Vec::new();
    let mut opaque = Vec::new();
    for entry in field(fields, "mods")
        .and_then(Yaml::as_vec)
        .into_iter()
        .flatten()
    {
        if let Some(parsed) = read_mod(entry) {
            mods.push(parsed);
            continue;
        }
        // Kept rather than dropped: an entry this version cannot judge is not thereby wrong, and the
        // files it describes are on disk either way. The id, where readable, is what refuses an
        // install over it.
        let id = entry
            .as_hash()
            .and_then(|fields| as_text(field(fields, "id")))
            .filter(|id| is_mod_id(id));
        opaque.push(OpaqueMod {
            id,
            raw: entry.clone(),
        });
    }

    let engines = field(fields, "engines")
        .and_then(Yaml::as_vec)
        .into_iter()
        .flatten()
        .filter_map(read_engine)
        .collect();

    Ok(InstallRecord {
        path,
        mods,
        engines,
        written: read_written(field(fields, "written")),
        opaque,
        later_format,
    })
}

fn yaml_text(value: &str) -> Yaml {
    Yaml::String(value.to_owned())
}

fn yaml_list(values: &[String]) -> Yaml {
    Yaml::Array(values.iter().map(|held| yaml_text(held)).collect())
}

fn mod_entry(held: &InstalledMod) -> Yaml {
    let mut fields = yaml_rust2::yaml::Hash::new();
    // Carried first, so a carried field can never stand in for one this version means to write.
    for (key, value) in &held.carried {
        fields.insert(yaml_text(key), value.clone());
    }
    fields.insert(yaml_text("id"), yaml_text(&held.id));
    fields.insert(yaml_text("version"), yaml_text(&held.version));
    if let Some(mod_type) = held.mod_type {
        let name = match mod_type {
            ModType::Pluggable => "pluggable",
            ModType::Permanent => "permanent",
            ModType::Base => "base",
        };
        fields.insert(yaml_text("type"), yaml_text(name));
    }
    if let Some(reason) = &held.reason {
        fields.insert(yaml_text("reason"), yaml_text(reason));
    }
    fields.insert(yaml_text("complete"), Yaml::Boolean(held.complete));
    fields.insert(yaml_text("files"), yaml_list(&held.files));
    if !held.entries.is_empty() {
        fields.insert(yaml_text("entries"), yaml_list(&held.entries));
    }
    if !held.parts.is_empty() {
        fields.insert(yaml_text("parts"), yaml_list(&held.parts));
    }
    fields.insert(yaml_text("manifest"), yaml_text(&held.manifest));
    let mut shipped = yaml_rust2::yaml::Hash::new();
    for (path, content) in &held.shipped {
        shipped.insert(yaml_text(path), yaml_text(content));
    }
    fields.insert(yaml_text("shipped"), Yaml::Hash(shipped));
    if !held.before.is_empty() {
        let mut before = yaml_rust2::yaml::Hash::new();
        for (path, content) in &held.before {
            before.insert(yaml_text(path), yaml_text(content));
        }
        fields.insert(yaml_text("before"), Yaml::Hash(before));
    }
    Yaml::Hash(fields)
}

fn engine_entry(engine: &InstalledEngine) -> Yaml {
    let mut fields = yaml_rust2::yaml::Hash::new();
    fields.insert(yaml_text("id"), yaml_text(&engine.id));
    fields.insert(yaml_text("release"), yaml_text(&engine.release));
    fields.insert(yaml_text("published"), yaml_text(&engine.published));
    fields.insert(yaml_text("complete"), Yaml::Boolean(engine.complete));
    fields.insert(yaml_text("files"), yaml_list(&engine.files));
    if let Some(backup) = &engine.backup {
        fields.insert(yaml_text("backup"), yaml_text(backup));
    }
    if let Some(commit) = &engine.commit {
        fields.insert(yaml_text("commit"), yaml_text(commit));
    }
    if engine.pinned {
        fields.insert(yaml_text("pinned"), Yaml::Boolean(true));
    }
    Yaml::Hash(fields)
}

/// Writes the record back, or removes the file when the last mod is gone - an empty record is no
/// record.
///
/// # Errors
///
/// Refuses a record this version may not write, and fails when the file cannot be written.
pub fn save_record(platform: &dyn Platform, record: &InstallRecord) -> Result<()> {
    if let Some(stated) = record.later_format {
        return Err(Error::Unsupported(later_format_message(stated)));
    }
    let path = normalize_path(&record.path);
    let at = record_path(platform, &path);

    if record.mods.is_empty()
        && record.opaque.is_empty()
        && record.engines.is_empty()
        && record.written.is_empty()
    {
        return platform.fs().remove(&at);
    }

    let mut root = yaml_rust2::yaml::Hash::new();
    root.insert(yaml_text("record"), Yaml::Integer(RECORD_FORMAT));
    root.insert(yaml_text("path"), yaml_text(&path));
    let mut mods: Vec<Yaml> = record.mods.iter().map(mod_entry).collect();
    mods.extend(record.opaque.iter().map(|entry| entry.raw.clone()));
    root.insert(yaml_text("mods"), Yaml::Array(mods));
    if !record.engines.is_empty() {
        root.insert(
            yaml_text("engines"),
            Yaml::Array(record.engines.iter().map(engine_entry).collect()),
        );
    }
    if !record.written.is_empty() {
        let mut written = yaml_rust2::yaml::Hash::new();
        for (address, value) in &record.written {
            written.insert(yaml_text(address), yaml_text(value));
        }
        root.insert(yaml_text("written"), Yaml::Hash(written));
    }

    let mut out = String::new();
    let mut emitter = YamlEmitter::new(&mut out);
    // Every value here is one the emitter can represent, and the sink is a String.
    let _ = emitter.dump(&Yaml::Hash(root));
    let body = out.strip_prefix("---\n").unwrap_or(&out).to_owned();
    platform.fs().write(&at, body.as_bytes())
}

/// Whether the directory still holds this mod.
///
/// A recorded file list answers for itself. A base mod has none - its installer decides what lands,
/// so the record is written with an empty list on purpose - and what answers for it instead is what
/// the directory has become: the type read off the directory now, against the type the mod's manifest
/// says it makes. Without this second arm a base mod removed behind ZAX's back stays "installed and
/// current" against a folder that reads as vanilla everywhere else, since the empty list can never be
/// found missing.
fn still_installed(
    platform: &dyn Platform,
    root: &Path,
    identified: Option<GameType>,
    held: &InstalledMod,
) -> bool {
    for file in &held.files {
        let at = join_relative(root, file);
        if matches!(platform.fs().stat(&at), Ok(Some(stat)) if stat.kind == FileKind::File) {
            return true;
        }
    }
    if !held.files.is_empty() {
        return false;
    }

    // An unfinished install is a transaction marker rather than a claim about the directory - it is
    // what lets a relaunch offer the retry.
    if !held.complete {
        return true;
    }

    // The same tolerance the caller extends to an unreadable directory: a path that no longer reads
    // as an install at all says the installation is gone, not that this mod was taken out of it.
    let Some(identified) = identified else {
        return true;
    };

    // Nothing to test against - an entry written before the manifest was kept, or one this version
    // cannot parse. Kept, which is what the empty file list alone did before this arm existed.
    let Some(manifest) = manifest_of(held) else {
        return true;
    };
    let Some(becomes) = manifest.becomes else {
        return true;
    };

    // A mod that makes its own install answers from the directory it made; one that converts this
    // installation answers from what this installation now is.
    if let Some(creates) = &manifest.creates {
        let at = created_install_path(root, identified, Some(becomes), &creates.directory);
        return matches!(platform.fs().stat(&at), Ok(Some(stat)) if stat.kind == FileKind::Dir);
    }
    identified == becomes
}

fn join_relative(base: &Path, relative: &str) -> PathBuf {
    let mut at = base.to_path_buf();
    for part in relative.split('/').filter(|part| !part.is_empty()) {
        at.push(part);
    }
    at
}

/// Reconciles a record against the directory it describes.
///
/// A mod the directory no longer holds was removed behind ZAX's back and is dropped - the two cannot
/// drift far - while a directory that cannot be read at all sets the record aside untouched, the same
/// tolerance the install list extends to the install. The pruned record is saved when anything
/// changed, so the drop happens once rather than on every load.
///
/// # Errors
///
/// Fails when the pruned record cannot be written.
pub fn reconcile_record(platform: &dyn Platform, record: &InstallRecord) -> Result<InstallRecord> {
    // A record this version may not write is one it may not prune either, however stale the directory
    // looks.
    if record.later_format.is_some() {
        return Ok(record.clone());
    }
    let root = Path::new(&record.path);
    if platform.fs().stat(root)?.map(|s| s.kind) != Some(FileKind::Dir) {
        return Ok(record.clone());
    }

    // Once for the pass rather than per entry: every mod asks the same directory what it has become.
    let identified = identify_install(platform, root);

    let kept: Vec<InstalledMod> = record
        .mods
        .iter()
        .filter(|held| still_installed(platform, root, identified, held))
        .cloned()
        .collect();

    let kept_engines: Vec<InstalledEngine> = record
        .engines
        .iter()
        .filter(|engine| {
            // Either kind of entry counts: a Windows build deploys files, a macOS one a bundle.
            engine.files.is_empty()
                || engine.files.iter().any(|file| {
                    matches!(platform.fs().stat(&join_relative(root, file)), Ok(Some(_)))
                })
        })
        .cloned()
        .collect();

    if kept.len() == record.mods.len() && kept_engines.len() == record.engines.len() {
        return Ok(record.clone());
    }
    let pruned = InstallRecord {
        mods: kept,
        engines: kept_engines,
        ..record.clone()
    };
    save_record(platform, &pruned)?;
    Ok(pruned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap as Map;
    use zax_platform::memory::{Content, MemoryOptions, MemoryPlatform};

    const INSTALL: &str = "/games/f2";

    fn record_file(platform: &MemoryPlatform) -> String {
        let at = record_path(platform, INSTALL);
        platform.text_at(&at.to_string_lossy()).unwrap_or_default()
    }

    fn manifest_text(id: &str) -> String {
        format!("spec: 1\ngame: fallout2\nid: {id}\nname: {id}\n")
    }

    fn a_mod(id: &str) -> InstalledMod {
        InstalledMod {
            id: id.to_owned(),
            version: "1.0".to_owned(),
            mod_type: Some(ModType::Pluggable),
            reason: None,
            complete: true,
            files: vec![format!("mods/{id}.dat")],
            entries: vec![format!("{id}.dat")],
            parts: Vec::new(),
            manifest: manifest_text(id),
            shipped: Map::new(),
            before: Map::new(),
            carried: Map::new(),
        }
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

    #[test]
    fn two_spellings_of_one_directory_land_on_one_record() {
        assert_eq!(install_key("/games/f2"), install_key("/games/f2/"));
        assert_eq!(install_key("/games/f2"), install_key("/games/f2\\"));
        assert_ne!(install_key("/games/f2"), install_key("/games/f3"));
    }

    #[test]
    fn a_first_install_and_a_lost_record_read_the_same() {
        let platform = MemoryPlatform::default();
        let record = load_record(&platform, INSTALL).expect("load");
        assert_eq!(record.path, INSTALL);
        assert!(record.mods.is_empty());
        assert_eq!(record.later_format, None);
    }

    #[test]
    fn a_record_that_will_not_parse_reads_as_lost_rather_than_crashing() {
        let platform = MemoryPlatform::default();
        let at = record_path(&platform, INSTALL);
        platform.fs().write(&at, b"mods: [unclosed").expect("seed");
        assert!(
            load_record(&platform, INSTALL)
                .expect("load")
                .mods
                .is_empty()
        );
    }

    #[test]
    fn what_is_written_reads_back() {
        let platform = MemoryPlatform::default();
        let record = InstallRecord {
            path: INSTALL.to_owned(),
            mods: vec![a_mod("ecco")],
            ..InstallRecord::default()
        };
        save_record(&platform, &record).expect("save");

        let back = load_record(&platform, INSTALL).expect("load");
        assert_eq!(back.mods.len(), 1);
        assert_eq!(back.mods[0].id, "ecco");
        assert_eq!(back.mods[0].files, vec!["mods/ecco.dat".to_owned()]);
        assert_eq!(back.mods[0].entries, vec!["ecco.dat".to_owned()]);
        assert!(back.mods[0].complete);
    }

    #[test]
    fn an_empty_record_removes_its_file() {
        let platform = MemoryPlatform::default();
        let record = InstallRecord {
            path: INSTALL.to_owned(),
            mods: vec![a_mod("ecco")],
            ..InstallRecord::default()
        };
        save_record(&platform, &record).expect("save");
        assert!(!record_file(&platform).is_empty());

        let emptied = InstallRecord {
            path: INSTALL.to_owned(),
            ..InstallRecord::default()
        };
        save_record(&platform, &emptied).expect("save");
        assert_eq!(record_file(&platform), "");
    }

    #[test]
    fn a_file_list_reaching_outside_mods_drops_the_entry() {
        // A tampered record must degrade to hand-installed rather than aim uninstall somewhere new.
        let platform = MemoryPlatform::default();
        let at = record_path(&platform, INSTALL);
        let body = format!(
            "record: 1\npath: {INSTALL}\nmods:\n  - id: ecco\n    version: '1.0'\n    complete: true\n    files:\n      - ../outside.dat\n    manifest: \"spec: 1\"\n"
        );
        platform.fs().write(&at, body.as_bytes()).expect("seed");

        let record = load_record(&platform, INSTALL).expect("load");
        assert!(record.mods.is_empty(), "the entry must not be trusted");
        assert_eq!(record.opaque.len(), 1, "but it must be kept");
        assert_eq!(record.opaque[0].id.as_deref(), Some("ecco"));
    }

    #[test]
    fn a_base_mods_paths_may_sit_at_the_install_root() {
        // Its installer owns the whole game directory.
        let platform = MemoryPlatform::default();
        let at = record_path(&platform, INSTALL);
        let body = format!(
            "record: 1\npath: {INSTALL}\nmods:\n  - id: rpu24\n    version: '1.0'\n    type: base\n    complete: true\n    files:\n      - ddraw.ini\n    manifest: \"spec: 1\"\n"
        );
        platform.fs().write(&at, body.as_bytes()).expect("seed");

        let record = load_record(&platform, INSTALL).expect("load");
        assert_eq!(record.mods.len(), 1, "a base mod's root paths are allowed");
        assert_eq!(record.mods[0].files, vec!["ddraw.ini".to_owned()]);
    }

    #[test]
    fn a_stacking_mod_may_not_reach_the_install_root() {
        // Where the narrow rule earns its keep.
        let platform = MemoryPlatform::default();
        let at = record_path(&platform, INSTALL);
        let body = format!(
            "record: 1\npath: {INSTALL}\nmods:\n  - id: ecco\n    version: '1.0'\n    type: pluggable\n    complete: true\n    files:\n      - ddraw.ini\n    manifest: \"spec: 1\"\n"
        );
        platform.fs().write(&at, body.as_bytes()).expect("seed");
        assert!(
            load_record(&platform, INSTALL)
                .expect("load")
                .mods
                .is_empty()
        );
    }

    #[test]
    fn an_entry_this_version_cannot_read_survives_a_rewrite() {
        // The files it describes are on disk either way.
        let platform = MemoryPlatform::default();
        let at = record_path(&platform, INSTALL);
        let body =
            format!("record: 1\npath: {INSTALL}\nmods:\n  - id: future\n    somethingNew: yes\n");
        platform.fs().write(&at, body.as_bytes()).expect("seed");

        let record = load_record(&platform, INSTALL).expect("load");
        assert_eq!(record.opaque.len(), 1);
        save_record(&platform, &record).expect("save");
        assert!(
            record_file(&platform).contains("somethingNew"),
            "{}",
            record_file(&platform)
        );
    }

    #[test]
    fn a_field_this_version_has_no_rule_for_rides_along() {
        let platform = MemoryPlatform::default();
        let at = record_path(&platform, INSTALL);
        let body = format!(
            "record: 1\npath: {INSTALL}\nmods:\n  - id: ecco\n    version: '1.0'\n    complete: true\n    files: []\n    manifest: \"spec: 1\"\n    futureField: kept\n"
        );
        platform.fs().write(&at, body.as_bytes()).expect("seed");

        let record = load_record(&platform, INSTALL).expect("load");
        assert_eq!(record.mods.len(), 1);
        assert!(record.mods[0].carried.contains_key("futureField"));
        save_record(&platform, &record).expect("save");
        assert!(record_file(&platform).contains("futureField"));
    }

    #[test]
    fn a_carried_field_cannot_stand_in_for_one_this_version_writes() {
        let platform = MemoryPlatform::default();
        let mut held = a_mod("ecco");
        held.carried
            .insert("version".to_owned(), Yaml::String("999".to_owned()));
        let record = InstallRecord {
            path: INSTALL.to_owned(),
            mods: vec![held],
            ..InstallRecord::default()
        };
        save_record(&platform, &record).expect("save");
        assert_eq!(
            load_record(&platform, INSTALL).expect("load").mods[0].version,
            "1.0"
        );
    }

    #[test]
    fn a_record_from_a_newer_zax_is_read_only() {
        let platform = MemoryPlatform::default();
        let at = record_path(&platform, INSTALL);
        let body = format!("record: 99\npath: {INSTALL}\nmods: []\n");
        platform.fs().write(&at, body.as_bytes()).expect("seed");

        let record = load_record(&platform, INSTALL).expect("load");
        assert_eq!(record.later_format, Some(99));
        assert!(save_record(&platform, &record).is_err());
        assert!(assert_usable(&record, "ecco").is_err());
    }

    #[test]
    fn an_opaque_entry_refuses_an_install_over_what_it_describes() {
        let record = InstallRecord {
            path: INSTALL.to_owned(),
            opaque: vec![OpaqueMod {
                id: Some("ecco".to_owned()),
                raw: Yaml::Null,
            }],
            ..InstallRecord::default()
        };
        assert!(assert_usable(&record, "ecco").is_err());
        assert!(assert_usable(&record, "other").is_ok());
    }

    #[test]
    fn a_written_base_needs_all_three_pieces_of_its_address() {
        let platform = MemoryPlatform::default();
        let at = record_path(&platform, INSTALL);
        let body = format!(
            "record: 1\npath: {INSTALL}\nmods: []\nwritten:\n  ddraw.ini|Misc|A: '1'\n  broken: '2'\n"
        );
        platform.fs().write(&at, body.as_bytes()).expect("seed");

        let record = load_record(&platform, INSTALL).expect("load");
        assert_eq!(record.written.len(), 1);
        assert_eq!(
            record.written.get("ddraw.ini|Misc|A").map(String::as_str),
            Some("1")
        );
    }

    #[test]
    fn an_engine_round_trips() {
        let platform = MemoryPlatform::default();
        let record = InstallRecord {
            path: INSTALL.to_owned(),
            engines: vec![InstalledEngine {
                id: "fallout2-ce".to_owned(),
                release: "v1.3.0".to_owned(),
                published: "2026-01-01T00:00:00Z".to_owned(),
                complete: true,
                files: vec!["fallout2-ce".to_owned()],
                backup: None,
                commit: Some("abc123".to_owned()),
                pinned: true,
            }],
            ..InstallRecord::default()
        };
        save_record(&platform, &record).expect("save");

        let back = load_record(&platform, INSTALL).expect("load");
        assert_eq!(back.engines.len(), 1);
        assert_eq!(back.engines[0].commit.as_deref(), Some("abc123"));
        assert!(back.engines[0].pinned);
    }

    #[test]
    fn the_name_falls_back_to_the_id_when_the_snapshot_will_not_parse() {
        let mut held = a_mod("ecco");
        assert_eq!(mod_name(&held), "ecco");
        held.manifest = "not a manifest at all: [".to_owned();
        assert_eq!(mod_name(&held), "ecco");
    }

    #[test]
    fn a_mod_whose_files_are_gone_is_dropped_on_reconcile() {
        // Removed behind ZAX's back; the two cannot drift far.
        let platform = platform_with(&[("/games/f2/fallout2.exe", "MZ")]);
        let record = InstallRecord {
            path: INSTALL.to_owned(),
            mods: vec![a_mod("ecco")],
            ..InstallRecord::default()
        };
        save_record(&platform, &record).expect("save");

        let pruned = reconcile_record(&platform, &record).expect("reconcile");
        assert!(pruned.mods.is_empty());
        assert_eq!(
            record_file(&platform),
            "",
            "the pruned record is saved once"
        );
    }

    #[test]
    fn a_mod_whose_files_are_there_is_kept() {
        let platform = platform_with(&[
            ("/games/f2/fallout2.exe", "MZ"),
            ("/games/f2/mods/ecco.dat", "dat"),
        ]);
        let record = InstallRecord {
            path: INSTALL.to_owned(),
            mods: vec![a_mod("ecco")],
            ..InstallRecord::default()
        };
        assert_eq!(
            reconcile_record(&platform, &record)
                .expect("reconcile")
                .mods
                .len(),
            1
        );
    }

    #[test]
    fn a_directory_that_cannot_be_read_sets_the_record_aside_untouched() {
        let platform = MemoryPlatform::default();
        let record = InstallRecord {
            path: INSTALL.to_owned(),
            mods: vec![a_mod("ecco")],
            ..InstallRecord::default()
        };
        assert_eq!(
            reconcile_record(&platform, &record)
                .expect("reconcile")
                .mods
                .len(),
            1
        );
    }

    #[test]
    fn an_unfinished_install_is_kept_so_a_relaunch_can_offer_the_retry() {
        let platform = platform_with(&[("/games/f2/fallout2.exe", "MZ")]);
        let mut held = a_mod("ecco");
        held.files = Vec::new();
        held.complete = false;
        let record = InstallRecord {
            path: INSTALL.to_owned(),
            mods: vec![held],
            ..InstallRecord::default()
        };
        assert_eq!(
            reconcile_record(&platform, &record)
                .expect("reconcile")
                .mods
                .len(),
            1
        );
    }

    #[test]
    fn a_base_mod_removed_behind_zaxs_back_is_dropped_by_what_the_directory_became() {
        // The empty file list can never be found missing, so the type is what answers.
        let platform = platform_with(&[("/games/f2/fallout2.exe", "MZ")]);
        let mut held = a_mod("rpu24");
        held.files = Vec::new();
        held.mod_type = Some(ModType::Base);
        held.manifest = "spec: 1\ngame: fallout2\nid: rpu24\nname: RPU\ntype: base\n\
                         becomes: fallout2rpu\ninstaller.other.run: rpu-install.sh\n"
            .to_owned();
        let record = InstallRecord {
            path: INSTALL.to_owned(),
            mods: vec![held],
            ..InstallRecord::default()
        };
        save_record(&platform, &record).expect("save");

        // The directory reads as vanilla, so the mod it claims to have made is gone.
        let pruned = reconcile_record(&platform, &record).expect("reconcile");
        assert!(pruned.mods.is_empty(), "{:?}", pruned.mods);
    }

    #[test]
    fn a_base_mod_the_directory_still_reports_is_kept() {
        let platform = platform_with(&[
            ("/games/f2/fallout2.exe", "MZ"),
            ("/games/f2/mods/rpu.dat", "dat"),
        ]);
        let mut held = a_mod("rpu24");
        held.files = Vec::new();
        held.entries = Vec::new();
        held.mod_type = Some(ModType::Base);
        held.manifest = "spec: 1\ngame: fallout2\nid: rpu24\nname: RPU\ntype: base\n\
                         becomes: fallout2rpu\ninstaller.other.run: rpu-install.sh\n"
            .to_owned();
        let record = InstallRecord {
            path: INSTALL.to_owned(),
            mods: vec![held],
            ..InstallRecord::default()
        };
        assert_eq!(
            reconcile_record(&platform, &record)
                .expect("reconcile")
                .mods
                .len(),
            1,
            "the directory reports fallout2rpu, which is what it makes"
        );
    }
}

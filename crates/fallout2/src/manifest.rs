//! `f2mod.yml`: the manifest a mod's release carries and this application interprets.
//!
//! It is read from the repository at the release's tag, so `version` and `archive` may be absent
//! from the file and supplied by the release instead.
//!
//! Parsing is strict and every refusal names its cause. A manifest is downloaded data even from a
//! trusted publisher, so it gets a boundary of its own: a size cap before parsing, a YAML alias cap,
//! length-capped plain-text strings, and confinement for every path-shaped field. An unknown field
//! refuses rather than passes, so a misspelling cannot silently drop a safety check. Anything the
//! format defines that this version does not implement - a base mod's install procedure, a later
//! spec - refuses as "needs a newer ZAX" rather than half-installing.

use std::collections::{BTreeMap, BTreeSet};

use yaml_rust2::parser::{Event, EventReceiver, Parser};
use yaml_rust2::{Yaml, YamlLoader};
use zax_core::catalog::{
    ChoiceOption, Gate, NumericKind, SettingDef, SettingKind, SettingTarget, Targets, ValueTest,
};
use zax_core::install::GameType;

use crate::catalog::settings;
use crate::mod_grants::grants_for;

/// The file's name at the repository root.
///
/// It is not manager-branded: the manifest declares its own `game`, and a second manager reading
/// this format should not have to ship a file named after this application.
pub const MANIFEST_NAME: &str = "f2mod.yml";

/// Refused before parsing. A catalog-parity settings schema with help text runs tens of kilobytes;
/// something past this is not a manifest, whatever it is.
pub const MANIFEST_BYTE_CAP: usize = 256 * 1024;

/// Anchors and aliases past this refuse - an alias flood multiplies in memory, not on the wire.
const ALIAS_CAP: usize = 64;

/// The highest manifest spec this version implements, and a floor rather than a pin.
///
/// A manifest may state this or anything below it. The format is append-only within a major - a
/// field's meaning never changes and a retired one stays parsed and ignored for a major - so an older
/// spec still means here what it said when it was written, and only a later one can name something
/// this version cannot honour.
pub const MANIFEST_SPEC: i64 = 1;

const SHORT_TEXT: usize = 200;
const LONG_TEXT: usize = 1000;

/// Why a manifest was not accepted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// Something the format allows but this manifest got wrong.
    Refused(String),
    /// A capability the spec defines and this version does not implement.
    NeedsNewerZax(String),
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refused(why) => write!(f, "The manifest was refused: {why}."),
            Self::NeedsNewerZax(what) => {
                write!(f, "This mod needs a newer version of ZAX: {what}.")
            }
        }
    }
}

impl std::error::Error for Refusal {}

type Parsed<T> = Result<T, Refusal>;

fn refuse<T>(why: impl Into<String>) -> Parsed<T> {
    Err(Refusal::Refused(why.into()))
}

/// The wording the spec reserves for a capability this version does not implement.
fn needs_newer_zax<T>(what: impl Into<String>) -> Parsed<T> {
    Err(Refusal::NeedsNewerZax(what.into()))
}

/// What the release supplies for fields the manifest may leave out.
///
/// A committed manifest states neither its version nor its payload's name - the tag and the
/// release's assets do - and a manifest re-read from a record or a journal takes back the version
/// that was resolved when it was installed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ManifestDefaults {
    pub version: Option<String>,
    pub archive: Option<String>,
}

/// A mod setting is a catalog definition plus the value the release ships, kept for revert and
/// display.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct ModSetting {
    pub def: SettingDef,
    pub default: Option<String>,
}

/// A settings entry this version cannot draw, kept so the interface can say so rather than say
/// nothing.
///
/// The two classes of ignorance are not alike, and this is the second. A field that decides what
/// lands on disk refuses the manifest when unknown, because ignoring it writes the wrong thing. A
/// settings entry only ever edits a key in the mod's own ini, and the release ships its own default
/// there - so a control this version cannot render costs the user a knob and never costs
/// correctness, and refusing the mod over one would make a mod uninstallable for sitting on the
/// wrong side of a ZAX release.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct DroppedSetting {
    /// The address the manifest spelled, `section.key`.
    pub address: String,
    pub why: String,
}

/// Fires when every `present` path exists and every `absent` path does not. At least one list is
/// non-empty.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(test, derive(serde::Serialize))]
pub struct ConflictRule {
    pub present: Vec<String>,
    pub absent: Vec<String>,
    pub reason: String,
}

/// One choice inside a group.
///
/// A part names its own release asset, because that is what every real case is - four zips, four
/// dats, two zips - and no part is ever a subset of another's archive, so nothing here slices an
/// archive up.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct ModPart {
    /// Permanent the way the mod's id is: the recorded selection names it, so a rename reads as a
    /// new part.
    pub id: String,
    pub label: String,
    pub help: Option<String>,
    /// The release asset this part deploys - its own download, its own digest, its own preflight.
    pub archive: String,
    /// What this part puts in the mods folder, read exactly as the mod's own entries are.
    pub entries: Option<Vec<String>>,
    /// Another part this one is meaningless without - Cassidy's voices without its head.
    pub needs: Option<String>,
}

/// How many of a group's options may be taken.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "lowercase")]
pub enum Pick {
    /// Picks at most one - a group may end with nothing chosen.
    One,
    /// Each option on or off.
    Any,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(test, derive(serde::Serialize))]
pub struct ModPartGroup {
    pub label: String,
    pub pick: Pick,
    pub options: Vec<ModPart>,
}

/// What installing this mod does to the install.
///
/// Pluggable stacks and comes off again, permanent stacks and never does, base transforms the game
/// into another one - which is why only a base mod names an installer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "lowercase")]
pub enum ModType {
    Pluggable,
    Permanent,
    Base,
}

/// The Windows half of a base mod's install: an installer program that takes the game directory as
/// an argument.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(test, derive(serde::Serialize), serde(rename_all = "camelCase"))]
pub struct WindowsInstaller {
    /// Absent where the release names it: upstream's installer assets carry the version in their
    /// names, which only the release knows.
    pub asset: Option<String>,
    /// The toolkit the installer was built with, which is what says how to drive it. `inno` is the
    /// only one this version knows.
    pub built_with: String,
}

/// The other half: a payload extracted over the game with a script inside it that finishes the job.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(test, derive(serde::Serialize))]
pub struct OtherInstaller {
    pub asset: Option<String>,
    /// What to run once the payload is extracted, relative to the install.
    pub run: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[cfg_attr(test, derive(serde::Serialize))]
pub struct ModInstaller {
    pub windows: Option<WindowsInstaller>,
    pub other: Option<OtherInstaller>,
}

/// A mod that produces a new install inside this one rather than transforming it.
///
/// The directory is one segment because that is what the payload's own root is - Fallout et tu's zip
/// holds nothing but `Fallout1in2/` - and it becomes the confinement bound for everything the install
/// writes, exactly as `mods/` is for a stacking mod.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(test, derive(serde::Serialize))]
pub struct ModCreates {
    pub directory: String,
}

/// A value ZAX must ask the user for, with the file that says the answer is the right one.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct ModInput {
    pub id: String,
    pub label: String,
    pub help: Option<String>,
    /// A file the chosen folder must hold - Fallout 1's `master.dat` for the archive Fo1in2 unpacks.
    pub holds: String,
}

/// Unpacking an archive the user owns into the created install.
///
/// `list` and `into` are read inside the created directory, so the response file that is used is the
/// one the payload shipped and the extraction cannot aim anywhere else.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(test, derive(serde::Serialize))]
pub struct ModExtractDat {
    /// The input whose `holds` file is unpacked.
    pub from: String,
    /// The file naming what to lift out of it, one path per line.
    pub list: String,
    pub into: String,
}

/// Where a mod says it loads, named in the vocabulary the order file itself uses - entries under
/// `mods/`, rather than mod ids.
///
/// That is the only vocabulary every line can be judged in: the folder cannot say which mod put a dat
/// there, so an id would place a mod against the ones ZAX installed and against nothing else.
///
/// Stated as override rather than position, because position is not what the file decides: order in
/// `mods_order.txt` has no effect except which copy of a shared file the engine sees.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[cfg_attr(test, derive(serde::Serialize), serde(rename_all = "camelCase"))]
pub struct ModOrder {
    pub overrides: Vec<String>,
    pub overridden_by: Vec<String>,
}

/// Serialized under test only, for the corpus the specimens under `fixtures/manifests` are pinned in.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(test, derive(serde::Serialize), serde(rename_all = "camelCase"))]
pub struct ModManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    /// What the mod is and who wrote it, for the surface that offers it. None of it reaches the
    /// install.
    pub author: Option<String>,
    pub description: Option<String>,
    /// Where the mod is discussed and where it lives, which the interface offers to open.
    pub forum: Option<String>,
    pub homepage: Option<String>,
    #[cfg_attr(test, serde(rename = "type"))]
    pub mod_type: ModType,
    /// Why the mod can never be uninstalled. Present exactly when the type is permanent.
    pub reason: Option<String>,
    /// The release asset carrying the payload. Absent where the release's sole archive supplied it.
    pub archive: Option<String>,
    /// The types it installs on. `None` means any - a base mod's default is vanilla alone.
    pub install_on: Option<Vec<GameType>>,
    /// The game type the install reports afterwards. Base mods only, where it is required.
    pub becomes: Option<GameType>,
    pub installer: Option<ModInstaller>,
    pub creates: Option<ModCreates>,
    pub inputs: Option<Vec<ModInput>>,
    pub extract_dat: Option<ModExtractDat>,
    /// The lowest sfall version it works with, answered by the updater rather than a refusal.
    pub requires_sfall: Option<String>,
    /// What the mod puts in the mods folder, spelled as the loader names it.
    pub entries: Option<Vec<String>>,
    pub parts: Option<Vec<ModPartGroup>>,
    pub order: Option<ModOrder>,
    /// Installs ZAX refuses because the author declared the clash.
    pub conflicts: Vec<ConflictRule>,
    pub settings: Vec<ModSetting>,
    /// Entries the schema declares that this version cannot draw.
    pub dropped: Vec<DroppedSetting>,
    /// What each ini section is for, keyed by the name the settings' addresses use.
    pub section_help: Option<BTreeMap<String, String>>,
}

/// Every part of a manifest, flat and in declared order - the shape a selection is judged against.
#[must_use]
pub fn part_options(manifest: &ModManifest) -> Vec<&ModPart> {
    manifest
        .parts
        .as_deref()
        .unwrap_or_default()
        .iter()
        .flat_map(|group| &group.options)
        .collect()
}

// --- shapes ---------------------------------------------------------------------------------

/// The mod's own id becomes a feed match, a path piece and every setting id's prefix - lowercase, no
/// separators.
#[must_use]
pub fn is_mod_id(text: &str) -> bool {
    let mut bytes = text.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return false;
    }
    bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
}

/// Versions become path components and feed comparisons; the same bound the sfall names already pass.
#[must_use]
pub fn is_mod_version(text: &str) -> bool {
    let mut bytes = text.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    if !first.is_ascii_digit() {
        return false;
    }
    bytes.all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
}

/// The address becomes the id verbatim, so its characters are bounded the way an id's are.
fn is_address(text: &str) -> bool {
    !text.is_empty()
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// A section name, which is an address up to its first dot - so it cannot hold one.
fn is_section_name(text: &str) -> bool {
    !text.is_empty()
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

/// A relative path's segments, or `None` when it could resolve anywhere but inside the install
/// directory.
fn path_segments(path: &str) -> Option<Vec<String>> {
    if path.contains(':') {
        return None;
    }
    let pieces: Vec<String> = path
        .replace('\\', "/")
        .split('/')
        .map(str::to_owned)
        .collect();
    if pieces
        .iter()
        .any(|piece| piece.is_empty() || piece == "." || piece == "..")
    {
        return None;
    }
    Some(pieces)
}

/// Whether a relative path stays inside the install directory at all - no absolutes, no drive
/// letters, no `..`.
///
/// The bound a base mod's paths pass, its installer owning the whole directory rather than one folder
/// inside it; every other mod passes the narrower one below.
#[must_use]
pub fn is_confined(path: &str) -> bool {
    path_segments(path).is_some_and(|pieces| !pieces.is_empty())
}

/// Whether a relative path stays confined under `mods/` - no escapes, no absolutes, at least one
/// segment below it.
///
/// The one spec rule the manifest parser, the record reader and uninstall all judge by, so a tampered
/// record cannot name what a manifest could not.
#[must_use]
pub fn inside_mods(path: &str) -> bool {
    path_segments(path).is_some_and(|pieces| {
        pieces.len() > 1
            && pieces
                .first()
                .is_some_and(|first| first.to_lowercase() == "mods")
    })
}

/// Whether a path sits at least one segment below a granted directory, compared as the engine
/// compares.
fn below(path: &str, directory: &str) -> bool {
    let (Some(pieces), Some(root)) = (path_segments(path), path_segments(directory)) else {
        return false;
    };
    if pieces.len() <= root.len() {
        return false;
    }
    root.iter()
        .zip(&pieces)
        .all(|(one, other)| one.to_lowercase() == other.to_lowercase())
}

/// Whether a mod may write to a path: under `mods/` as every mod may, or below one of the
/// directories ZAX grants this one.
///
/// The grant is ZAX's own list, so a manifest cannot widen it by declaring a path and neither can a
/// hand-edited record - and it widens only where, never how far, since a granted path is confined
/// exactly as `mods/` is.
#[must_use]
pub fn may_write(path: &str, granted: &[&str]) -> bool {
    inside_mods(path) || granted.iter().any(|directory| below(path, directory))
}

// --- primitives -----------------------------------------------------------------------------

/// Everything except tab and newline; text with the rest is not something to render anywhere.
fn has_control(value: &str) -> bool {
    value
        .chars()
        .any(|c| c.is_control() && c != '\t' && c != '\n' && c != '\r')
}

fn text(value: Option<&Yaml>, where_at: &str, cap: usize) -> Parsed<String> {
    let Some(found) = value.and_then(Yaml::as_str) else {
        return refuse(format!("{where_at} must be text"));
    };
    if found.is_empty() {
        return refuse(format!("{where_at} is empty"));
    }
    // Counted in characters, as the TypeScript's `String.length` was, so the same manifest passes.
    if found.chars().count() > cap {
        return refuse(format!("{where_at} runs past {cap} characters"));
    }
    if has_control(found) {
        return refuse(format!("{where_at} contains control characters"));
    }
    Ok(found.to_owned())
}

/// A value written into or compared against a config file.
///
/// YAML reads `on: 1` as a number, and requiring authors to quote every literal is the kind of rule
/// that fails silently, so numbers are accepted and become the string the file carries.
fn literal(value: Option<&Yaml>, where_at: &str) -> Parsed<String> {
    match value {
        Some(Yaml::Integer(n)) => Ok(n.to_string()),
        Some(Yaml::Real(text)) => Ok(text.clone()),
        other => text(other, where_at, SHORT_TEXT),
    }
}

fn bound(value: Option<&Yaml>, where_at: &str) -> Parsed<f64> {
    match value {
        Some(Yaml::Integer(n)) => Ok(*n as f64),
        Some(Yaml::Real(text)) => text
            .parse::<f64>()
            .ok()
            .filter(|n| n.is_finite())
            .map_or_else(|| refuse(format!("{where_at} must be a number")), Ok),
        _ => refuse(format!("{where_at} must be a number")),
    }
}

/// A mapping's fields, with every key checked against what this version knows.
fn record<'a>(
    value: Option<&'a Yaml>,
    where_at: &str,
    allowed: &[&str],
) -> Parsed<BTreeMap<String, &'a Yaml>> {
    let Some(hash) = value.and_then(Yaml::as_hash) else {
        return refuse(format!("{where_at} must be a mapping"));
    };
    let mut out = BTreeMap::new();
    for (key, held) in hash {
        let Some(name) = key.as_str() else {
            return refuse(format!("{where_at} has a key that is not text"));
        };
        if !allowed.contains(&name) {
            return refuse(format!("{where_at} has an unknown field \"{name}\""));
        }
        out.insert(name.to_owned(), held);
    }
    Ok(out)
}

fn items<'a>(value: Option<&'a Yaml>, where_at: &str) -> Parsed<&'a Vec<Yaml>> {
    value
        .and_then(Yaml::as_vec)
        .map_or_else(|| refuse(format!("{where_at} must be a list")), Ok)
}

/// A path from a manifest, confined to the install directory - the rule every path-shaped field
/// passes through, spec text rather than an implementation detail.
///
/// Separators normalize to `/`; anything that could resolve outside - absolute paths, drive letters,
/// `..`, empty or self segments - refuses the manifest whole.
fn confined_path(value: Option<&Yaml>, where_at: &str) -> Parsed<String> {
    let path = text(value, where_at, SHORT_TEXT)?.replace('\\', "/");
    if path.starts_with('/') || path.contains(':') || path_segments(&path).is_none() {
        return refuse(format!("{where_at} (\"{path}\") leaves the game directory"));
    }
    Ok(path)
}

/// A path a mod is allowed to write - under `mods/`, or inside what ZAX grants it by name.
fn writable_path(
    value: Option<&Yaml>,
    where_at: &str,
    id: &str,
    granted: &[&str],
) -> Parsed<String> {
    let path = confined_path(value, where_at)?;
    if !may_write(&path, granted) {
        return refuse(format!(
            "{where_at} (\"{path}\") is outside what ZAX grants {id} - that grant is ZAX's to give, \
             not the manifest's to claim"
        ));
    }
    Ok(path)
}

/// The payload asset's name becomes a filename in the working directory, so it must be one - no
/// separators.
fn asset_name(value: Option<&Yaml>, where_at: &str) -> Parsed<String> {
    let name = text(value, where_at, SHORT_TEXT)?;
    if name.contains(['\\', '/', ':']) || name.starts_with('.') {
        return refuse(format!("{where_at} (\"{name}\") is not a file name"));
    }
    Ok(name)
}

/// An address the interface offers to open.
///
/// `https` alone, and no whitespace: the value is handed to whatever the machine opens links with, so
/// any other scheme would be a manifest choosing what runs there rather than naming a page to read.
fn link(value: Option<&Yaml>, where_at: &str) -> Parsed<String> {
    let url = text(value, where_at, SHORT_TEXT)?;
    if !url.starts_with("https://")
        || url.len() <= "https://".len()
        || url.chars().any(char::is_whitespace)
    {
        return refuse(format!("{where_at} (\"{url}\") is not an https address"));
    }
    Ok(url)
}

fn parse_gate(value: Option<&Yaml>, where_at: &str) -> Parsed<Gate> {
    let fields = record(value, where_at, &["id", "is", "is-not"])?;
    let id = text(
        fields.get("id").copied(),
        &format!("{where_at}'s id"),
        SHORT_TEXT,
    )?;
    let has_is = fields.contains_key("is");
    let has_is_not = fields.contains_key("is-not");
    if has_is == has_is_not {
        return refuse(format!(
            "{where_at} needs exactly one of \"is\" and \"is-not\""
        ));
    }
    let key = if has_is { "is" } else { "is-not" };
    let listed = items(fields.get(key).copied(), &format!("{where_at}'s values"))?;
    let mut values = Vec::new();
    for (at, entry) in listed.iter().enumerate() {
        values.push(literal(
            Some(entry),
            &format!("{where_at}'s value {}", at + 1),
        )?);
    }
    Ok(Gate {
        id,
        test: if has_is {
            ValueTest::Is(values)
        } else {
            ValueTest::IsNot(values)
        },
    })
}

// --- settings -------------------------------------------------------------------------------

/// The fields each kind carries beyond the shared ones - the catalog's kind union, payloads included.
fn kind_fields(kind: &str) -> Option<&'static [&'static str]> {
    Some(match kind {
        "scale" => &["max"],
        "bool" => &["on", "off"],
        "int" | "float" => &["min", "max", "unit", "sentinels"],
        "text" => &["path"],
        "choice" => &["options"],
        "key" => &[],
        _ => return None,
    })
}

fn parse_sentinels(value: Option<&Yaml>, where_at: &str) -> Parsed<BTreeMap<String, String>> {
    // The keys here are file values - data, not schema - so this is the one mapping with no field
    // allowlist.
    let Some(hash) = value.and_then(Yaml::as_hash) else {
        return refuse(format!("{where_at} must be a mapping"));
    };
    let mut out = BTreeMap::new();
    for (raw, label) in hash {
        let key = match raw {
            Yaml::Integer(n) => n.to_string(),
            Yaml::Real(text) | Yaml::String(text) => text.clone(),
            Yaml::Boolean(_)
            | Yaml::Array(_)
            | Yaml::Hash(_)
            | Yaml::Alias(_)
            | Yaml::Null
            | Yaml::BadValue => {
                return refuse(format!("{where_at} has a key that is not a value"));
            }
        };
        let named = text(Some(label), &format!("{where_at}[\"{key}\"]"), SHORT_TEXT)?;
        out.insert(key, named);
    }
    Ok(out)
}

fn numeric_kind(fields: &BTreeMap<String, &Yaml>, where_at: &str) -> Parsed<NumericKind> {
    Ok(NumericKind {
        min: match fields.get("min") {
            None => None,
            Some(held) => Some(bound(Some(held), &format!("{where_at}'s min"))?),
        },
        max: match fields.get("max") {
            None => None,
            Some(held) => Some(bound(Some(held), &format!("{where_at}'s max"))?),
        },
        unit: match fields.get("unit") {
            None => None,
            Some(held) => Some(text(Some(held), &format!("{where_at}'s unit"), SHORT_TEXT)?),
        },
        sentinels: match fields.get("sentinels") {
            None => BTreeMap::new(),
            Some(held) => parse_sentinels(Some(held), &format!("{where_at}'s sentinels"))?,
        },
    })
}

fn parse_kind(fields: &BTreeMap<String, &Yaml>, where_at: &str) -> Parsed<Option<SettingKind>> {
    let kind = text(
        fields.get("kind").copied(),
        &format!("{where_at}'s kind"),
        SHORT_TEXT,
    )?;
    Ok(Some(match kind.as_str() {
        "scale" => SettingKind::Scale {
            max: bound(fields.get("max").copied(), &format!("{where_at}'s max"))?,
        },
        // Omitted on/off mean 1/0 - what every ini bool in the corpus writes - so only the exceptions
        // say so.
        "bool" => SettingKind::Bool {
            on_value: match fields.get("on") {
                None => "1".to_owned(),
                Some(held) => literal(Some(held), &format!("{where_at}'s on"))?,
            },
            off_value: match fields.get("off") {
                None => "0".to_owned(),
                Some(held) => literal(Some(held), &format!("{where_at}'s off"))?,
            },
        },
        "int" => SettingKind::Int(numeric_kind(fields, where_at)?),
        "float" => SettingKind::Float(numeric_kind(fields, where_at)?),
        "text" => SettingKind::Text {
            path: fields.get("path").copied() == Some(&Yaml::Boolean(true)),
        },
        "choice" => {
            let listed = items(
                fields.get("options").copied(),
                &format!("{where_at}'s options"),
            )?;
            let mut options = Vec::new();
            for (at, option) in listed.iter().enumerate() {
                let one = format!("{where_at}'s option {}", at + 1);
                let parts = record(Some(option), &one, &["value", "label", "help"])?;
                options.push(ChoiceOption {
                    value: literal(parts.get("value").copied(), &format!("{one} value"))?,
                    label: text(
                        parts.get("label").copied(),
                        &format!("{one} label"),
                        SHORT_TEXT,
                    )?,
                    help: match parts.get("help") {
                        None => None,
                        Some(held) => Some(text(Some(held), &format!("{one} help"), LONG_TEXT)?),
                    },
                });
            }
            if options.is_empty() {
                return refuse(format!("{where_at}'s options are empty"));
            }
            SettingKind::Choice { options }
        }
        "key" => SettingKind::Key,
        // Unreachable: the caller drops an entry whose kind `kind_fields` does not name, which is the
        // same set this covers. Kept so adding a kind to one and not the other cannot pass silently.
        _ => return Ok(None),
    }))
}

const ENTRY_FIELDS: &[&str] = &["file", "kind", "label", "help", "default", "gated-by"];

/// Said once, because two guards reach the same conclusion and a second copy would drift from this
/// one.
fn unknown_kind(kind: &str) -> String {
    format!("its kind \"{kind}\" is not one this version knows")
}

#[derive(Debug, Default)]
struct ParsedSettings {
    settings: Vec<ModSetting>,
    dropped: Vec<DroppedSetting>,
}

/// A flat mapping keyed by each entry's real address in the ini, `section.key`, split at the first
/// dot - so a section name cannot carry one, a key can.
///
/// The id is the mod's id plus the address, verbatim - a gate names a sibling with no transform - the
/// same rule the catalog's generator applies to the engine's own files.
fn parse_settings(value: Option<&Yaml>, mod_id: &str, granted: &[&str]) -> Parsed<ParsedSettings> {
    let Some(hash) = value.and_then(Yaml::as_hash) else {
        return refuse("\"settings\" must be a mapping");
    };
    let mut out = ParsedSettings::default();

    for (raw_address, entry) in hash {
        let address = text(Some(raw_address), "a \"settings\" address", SHORT_TEXT)?;
        let where_at = format!("\"settings\" entry \"{address}\"");
        let Some(dot) = address.find('.') else {
            return refuse(format!("{where_at} is not a \"section.key\" address"));
        };
        if dot < 1 || dot == address.len() - 1 {
            return refuse(format!("{where_at} is not a \"section.key\" address"));
        }
        let section = address[..dot].to_owned();
        let key = address[dot + 1..].to_owned();

        let kind_name = entry
            .as_hash()
            .and_then(|fields| fields.get(&Yaml::String("kind".to_owned())))
            .and_then(Yaml::as_str)
            .unwrap_or("");
        let Some(extra) = kind_fields(kind_name) else {
            // Dropped without checking its other fields, which is deliberate: they belong to a shape
            // this version has no rule for, and the strictness that refuses an unknown field is there
            // to stop a misspelling dropping a safety rule. This entry carries none.
            if entry.as_hash().is_none() {
                return refuse(format!("{where_at} must be a mapping"));
            }
            out.dropped.push(DroppedSetting {
                address,
                why: unknown_kind(kind_name),
            });
            continue;
        };

        let allowed: Vec<&str> = ENTRY_FIELDS.iter().chain(extra).copied().collect();
        let parts = record(Some(entry), &where_at, &allowed)?;

        if !is_address(&address) {
            return refuse(format!("{where_at} cannot become an id"));
        }
        // Cannot collide with a catalog id: the mod id's first piece was refused out of the catalog's
        // prefixes.
        let id = format!("{mod_id}.{address}");

        // Narrowed rather than asserted, so a kind added to one of the two and not the other drops a
        // control instead of crashing.
        let Some(kind) = parse_kind(&parts, &where_at)? else {
            out.dropped.push(DroppedSetting {
                address,
                why: unknown_kind(kind_name),
            });
            continue;
        };

        // A mod setting writes one address: the manifest format names a single file, section and key,
        // and linking across engines is the catalog's business rather than something a mod declares.
        let target = SettingTarget {
            file: match parts.get("file") {
                None => format!("mods/{mod_id}.ini"),
                Some(held) => {
                    writable_path(Some(held), &format!("{where_at}'s file"), mod_id, granted)?
                }
            },
            section,
            key,
            engine: None,
            gated_by: match parts.get("gated-by") {
                None => None,
                Some(held) => Some(parse_gate(Some(held), &format!("{where_at}'s gate"))?),
            },
        };
        out.settings.push(ModSetting {
            def: SettingDef {
                id,
                targets: Targets::new(target),
                kind,
                label: text(
                    parts.get("label").copied(),
                    &format!("{where_at}'s label"),
                    SHORT_TEXT,
                )?,
                help: match parts.get("help") {
                    None => None,
                    Some(held) => Some(text(Some(held), &format!("{where_at}'s help"), LONG_TEXT)?),
                },
                conflicts_with: None,
                managed: None,
            },
            default: match parts.get("default") {
                None => None,
                Some(held) => Some(literal(Some(held), &format!("{where_at}'s default"))?),
            },
        });
    }

    drop_unsatisfied_gates(&mut out);
    Ok(out)
}

/// Judged after every entry exists, so a gate may name a sibling defined later in the file, and
/// repeated because dropping a control drops whatever waited on it.
///
/// A control gated on something absent would render but silently never take effect, which is the
/// failure gates exist to prevent.
fn drop_unsatisfied_gates(parsed: &mut ParsedSettings) {
    let catalog: BTreeSet<&str> = settings().iter().map(|def| def.id.as_str()).collect();
    loop {
        let ids: BTreeSet<String> = parsed
            .settings
            .iter()
            .map(|setting| setting.def.id.clone())
            .collect();
        let shown = |setting: &ModSetting| match &setting.def.targets.own().gated_by {
            None => true,
            Some(gate) => ids.contains(&gate.id) || catalog.contains(gate.id.as_str()),
        };
        let (kept, gone): (Vec<ModSetting>, Vec<ModSetting>) = parsed
            .settings
            .iter()
            .cloned()
            .partition(|setting| shown(setting));
        if gone.is_empty() {
            return;
        }
        for setting in gone {
            let at = setting.def.targets.own();
            parsed.dropped.push(DroppedSetting {
                address: format!("{}.{}", at.section, at.key),
                why: format!(
                    "it waits on \"{}\", which this version cannot show",
                    at.gated_by.as_ref().map_or("", |gate| gate.id.as_str())
                ),
            });
        }
        parsed.settings = kept;
    }
}

const SECTION_HELP_PREFIX: &str = "settings.sections.";

/// One flat key per described section rather than a mapping, the dotted spelling every other grouped
/// field uses.
///
/// A description must land on a section some setting is in - a dropped one counts - since one that
/// names nothing is a misspelt section, and would otherwise describe a part of the ini no setting
/// reaches.
fn parse_section_help(
    fields: &BTreeMap<String, &Yaml>,
    parsed: &ParsedSettings,
) -> Parsed<Option<BTreeMap<String, String>>> {
    let keys: Vec<&String> = fields
        .keys()
        .filter(|key| key.starts_with(SECTION_HELP_PREFIX))
        .collect();
    if keys.is_empty() {
        return Ok(None);
    }
    let mut sections: BTreeSet<String> = parsed
        .settings
        .iter()
        .map(|setting| setting.def.targets.own().section.clone())
        .collect();
    sections.extend(
        parsed
            .dropped
            .iter()
            .map(|gone| gone.address.split('.').next().unwrap_or("").to_owned()),
    );

    let mut out = BTreeMap::new();
    for key in keys {
        let section = &key[SECTION_HELP_PREFIX.len()..];
        if !is_section_name(section) {
            return refuse(format!("\"{key}\" does not name an ini section"));
        }
        if !sections.contains(section) {
            return refuse(format!("\"{key}\" describes a section no setting is in"));
        }
        out.insert(
            section.to_owned(),
            text(fields.get(key).copied(), &format!("\"{key}\""), LONG_TEXT)?,
        );
    }
    Ok(Some(out))
}

/// The mods-folder entries a mod declares.
///
/// Each is confined the way every path-shaped field is, and kept as written rather than prefixed with
/// `mods/`: the order file's own lines start below that folder.
fn parse_entries(value: Option<&Yaml>, where_at: &str) -> Parsed<Vec<String>> {
    let listed = items(value, where_at)?;
    let mut entries = Vec::new();
    for (at, name) in listed.iter().enumerate() {
        entries.push(confined_path(
            Some(name),
            &format!("{where_at} entry {}", at + 1),
        )?);
    }
    if entries.is_empty() {
        return refuse(format!(
            "{where_at} is empty, which would order nothing while claiming to"
        ));
    }
    Ok(entries)
}

/// What the mod's files win over, and what wins over them.
///
/// Both lists are entries under `mods/`, spelled as the order file spells them, so they are read
/// exactly as `entries` is. A claim naming nothing refuses: it would read as a mod stating its place
/// while placing itself nowhere. What a claim names is not required to be present.
fn parse_order(fields: &BTreeMap<String, &Yaml>) -> Parsed<ModOrder> {
    let names = |key: &str| -> Parsed<Vec<String>> {
        let full = format!("order.{key}");
        let Some(held) = fields.get(&full) else {
            return Ok(Vec::new());
        };
        let listed = items(Some(held), &format!("\"{full}\""))?;
        let mut out = Vec::new();
        for (at, name) in listed.iter().enumerate() {
            out.push(confined_path(
                Some(name),
                &format!("\"{full}\" entry {}", at + 1),
            )?);
        }
        Ok(out)
    };
    let overrides = names("overrides")?;
    let overridden_by = names("overridden-by")?;
    if overrides.is_empty() && overridden_by.is_empty() {
        return refuse(
            "\"order\" names nothing to override and nothing to be overridden by, so it states no place",
        );
    }
    Ok(ModOrder {
        overrides,
        overridden_by,
    })
}

const PART_GROUP_FIELDS: &[&str] = &["id", "label", "pick"];
const PART_FIELDS: &[&str] = &[
    "id", "group", "label", "help", "archive", "entries", "needs",
];

fn parse_part(fields: &BTreeMap<String, &Yaml>, where_at: &str) -> Parsed<ModPart> {
    let id = text(
        fields.get("id").copied(),
        &format!("{where_at}'s id"),
        SHORT_TEXT,
    )?;
    // The same bound the mod's own id passes: a part id is recorded, and a record is a file on disk.
    if !is_mod_id(&id) {
        return refuse(format!("{where_at}'s id (\"{id}\") is not an id"));
    }
    Ok(ModPart {
        id,
        label: text(
            fields.get("label").copied(),
            &format!("{where_at}'s label"),
            SHORT_TEXT,
        )?,
        help: match fields.get("help") {
            None => None,
            Some(held) => Some(text(Some(held), &format!("{where_at}'s help"), LONG_TEXT)?),
        },
        archive: asset_name(
            fields.get("archive").copied(),
            &format!("{where_at}'s archive"),
        )?,
        entries: match fields.get("entries") {
            None => None,
            Some(held) => Some(parse_entries(Some(held), &format!("{where_at}'s entries"))?),
        },
        needs: match fields.get("needs") {
            None => None,
            Some(held) => Some(text(
                Some(held),
                &format!("{where_at}'s needs"),
                SHORT_TEXT,
            )?),
        },
    })
}

struct DeclaredGroup {
    id: String,
    label: String,
    pick: Pick,
}

/// The choices a release offers, from the two lists that declare them: `part-groups` holds the
/// headers and `parts` the options, each naming the group it sits in.
///
/// Two flat lists rather than one nested one because a group inside a list is the nesting this format
/// does not have - and unlike every other wrapper here, a list inside a list is not something a
/// dotted key can spell.
///
/// Both keep the order the manifest declares them in: that order is the author's one lever over how
/// the choice reads. Group ids are read back out by nothing - no record carries one - so renaming a
/// group breaks no install, which is the opposite of a part id.
fn parse_parts(
    groups_value: Option<&Yaml>,
    parts_value: Option<&Yaml>,
) -> Parsed<Vec<ModPartGroup>> {
    let listed = items(groups_value, "\"part-groups\"")?;
    let mut declared: Vec<DeclaredGroup> = Vec::new();
    for (at, raw) in listed.iter().enumerate() {
        let where_at = format!("\"part-groups\" entry {}", at + 1);
        let fields = record(Some(raw), &where_at, PART_GROUP_FIELDS)?;
        let id = text(
            fields.get("id").copied(),
            &format!("{where_at}'s id"),
            SHORT_TEXT,
        )?;
        if !is_mod_id(&id) {
            return refuse(format!("{where_at}'s id (\"{id}\") is not an id"));
        }
        let pick = text(
            fields.get("pick").copied(),
            &format!("{where_at}'s pick"),
            SHORT_TEXT,
        )?;
        // On the refusing side of the ignorance rule, and the settings entries' opposite: `pick`
        // decides what lands on disk, so reading an unknown one as `any` would install what the
        // author never described.
        let pick = match pick.as_str() {
            "one" => Pick::One,
            "any" => Pick::Any,
            other => {
                return needs_newer_zax(format!(
                    "a \"part-groups\" entry picks \"{other}\", which this version does not implement"
                ));
            }
        };
        if declared.iter().any(|held| held.id == id) {
            return refuse(format!("\"part-groups\" names \"{id}\" twice"));
        }
        declared.push(DeclaredGroup {
            id,
            label: text(
                fields.get("label").copied(),
                &format!("{where_at}'s label"),
                SHORT_TEXT,
            )?,
            pick,
        });
    }
    if declared.is_empty() {
        return refuse("\"part-groups\" is empty, so it groups nothing");
    }

    let mut held: BTreeMap<String, Vec<ModPart>> = declared
        .iter()
        .map(|group| (group.id.clone(), Vec::new()))
        .collect();
    let mut by_id: BTreeMap<String, ModPart> = BTreeMap::new();

    for (at, raw) in items(parts_value, "\"parts\"")?.iter().enumerate() {
        let where_at = format!("\"parts\" entry {}", at + 1);
        let fields = record(Some(raw), &where_at, PART_FIELDS)?;
        let group = text(
            fields.get("group").copied(),
            &format!("{where_at}'s group"),
            SHORT_TEXT,
        )?;
        // Resolved the way a part's own `needs`, `extract-dat.from` and a setting's `gated-by`
        // resolve: a name that matches nothing refuses, rather than leaving an option in a group the
        // interface cannot draw.
        let Some(into) = held.get_mut(&group) else {
            return refuse(format!(
                "{where_at} is in the group \"{group}\", which \"part-groups\" does not declare"
            ));
        };
        let part = parse_part(&fields, &where_at)?;
        // Unique across the manifest rather than per group: the recorded selection names ids flat.
        if by_id.contains_key(&part.id) {
            return refuse(format!("\"parts\" names \"{}\" twice", part.id));
        }
        by_id.insert(part.id.clone(), part.clone());
        into.push(part);
    }

    for part in by_id.values() {
        let Some(needs) = &part.needs else {
            continue;
        };
        if needs == &part.id {
            return refuse(format!(
                "\"{}\" needs itself, so it could never be selected",
                part.id
            ));
        }
        if !by_id.contains_key(needs) {
            return refuse(format!(
                "\"{}\" needs \"{needs}\", which is not a part of this mod",
                part.id
            ));
        }
        // A cycle is a set of parts none of which could ever be selected - said at publish time
        // rather than at the first install that tries.
        let mut seen: BTreeSet<&str> = BTreeSet::from([part.id.as_str()]);
        let mut at = Some(needs.as_str());
        while let Some(here) = at {
            if !seen.insert(here) {
                return refuse(format!(
                    "\"{}\" and \"{here}\" need each other, so neither could ever be selected",
                    part.id
                ));
            }
            at = by_id.get(here).and_then(|held| held.needs.as_deref());
        }
    }

    // A group nothing joined would draw a heading over an empty box. Said against the group rather
    // than the parts, because what is missing is a part naming it.
    for group in &declared {
        if held.get(&group.id).is_some_and(Vec::is_empty) {
            return refuse(format!(
                "no part is in the group \"{}\", so it offers nothing to pick",
                group.id
            ));
        }
    }

    Ok(declared
        .into_iter()
        .map(|group| ModPartGroup {
            label: group.label,
            pick: group.pick,
            options: held.remove(&group.id).unwrap_or_default(),
        })
        .collect())
}

/// How a base mod installs, per platform.
///
/// An unknown platform takes the newer-ZAX wording rather than the unknown-field one, and so does an
/// unknown `built-with`: both decide what ZAX executes, and reading either as "not for me" would run
/// the wrong thing rather than nothing.
fn parse_installer(fields: &BTreeMap<String, &Yaml>) -> Parsed<ModInstaller> {
    let mut out = ModInstaller::default();

    if fields.contains_key("installer.windows.built-with")
        || fields.contains_key("installer.windows.asset")
    {
        let built_with = text(
            fields.get("installer.windows.built-with").copied(),
            "\"installer.windows.built-with\"",
            SHORT_TEXT,
        )?;
        if built_with != "inno" {
            return needs_newer_zax(format!(
                "its Windows installer was built with \"{built_with}\", which this version cannot run"
            ));
        }
        out.windows = Some(WindowsInstaller {
            asset: match fields.get("installer.windows.asset") {
                None => None,
                Some(held) => Some(asset_name(Some(held), "\"installer.windows.asset\"")?),
            },
            built_with,
        });
    }

    if fields.contains_key("installer.other.run") || fields.contains_key("installer.other.asset") {
        out.other = Some(OtherInstaller {
            asset: match fields.get("installer.other.asset") {
                None => None,
                Some(held) => Some(asset_name(Some(held), "\"installer.other.asset\"")?),
            },
            // Confined like every path-shaped field: it is run from inside the game directory after
            // the payload lands there, so a path leaving it would run something the payload never
            // shipped.
            run: confined_path(
                fields.get("installer.other.run").copied(),
                "\"installer.other.run\"",
            )?,
        });
    }

    if out.windows.is_none() && out.other.is_none() {
        return refuse("\"installer\" names no platform, so there is nothing to run anywhere");
    }
    Ok(out)
}

/// The directory a creating mod makes.
///
/// One segment, because it is the payload's own root and the bound every later write is judged
/// against: a name with a separator in it would be a bound with a path inside it.
fn parse_creates(value: Option<&Yaml>) -> Parsed<ModCreates> {
    let directory = confined_path(value, "\"creates.directory\"")?;
    if directory.contains('/') {
        return refuse(format!(
            "\"creates.directory\" (\"{directory}\") is not one folder of the install it sits in"
        ));
    }
    Ok(ModCreates { directory })
}

const INPUT_FIELDS: &[&str] = &["id", "label", "help", "holds"];

/// What the user is asked for, each answer checked against a file the folder must hold.
fn parse_inputs(value: Option<&Yaml>) -> Parsed<Vec<ModInput>> {
    let listed = items(value, "\"inputs\"")?;
    let mut inputs: Vec<ModInput> = Vec::new();
    for (at, raw) in listed.iter().enumerate() {
        let where_at = format!("\"inputs\" entry {}", at + 1);
        let fields = record(Some(raw), &where_at, INPUT_FIELDS)?;
        let id = text(
            fields.get("id").copied(),
            &format!("{where_at}'s id"),
            SHORT_TEXT,
        )?;
        // The same bound the mod's own id passes: it names an answer that reaches the install as a
        // path.
        if !is_mod_id(&id) {
            return refuse(format!("{where_at}'s id (\"{id}\") is not an id"));
        }
        if inputs.iter().any(|held| held.id == id) {
            return refuse(format!("\"inputs\" names \"{id}\" twice"));
        }
        inputs.push(ModInput {
            id,
            label: text(
                fields.get("label").copied(),
                &format!("{where_at}'s label"),
                SHORT_TEXT,
            )?,
            help: match fields.get("help") {
                None => None,
                Some(held) => Some(text(Some(held), &format!("{where_at}'s help"), LONG_TEXT)?),
            },
            // A file the folder holds, so a name rather than a path: what is checked is that folder.
            holds: asset_name(fields.get("holds").copied(), &format!("{where_at}'s holds"))?,
        });
    }
    if inputs.is_empty() {
        return refuse("\"inputs\" is empty, so it asks for nothing while claiming to");
    }
    Ok(inputs)
}

fn parse_extract_dat(
    fields: &BTreeMap<String, &Yaml>,
    inputs: &[ModInput],
) -> Parsed<ModExtractDat> {
    let from = text(
        fields.get("extract-dat.from").copied(),
        "\"extract-dat.from\"",
        SHORT_TEXT,
    )?;
    if !inputs.iter().any(|input| input.id == from) {
        return refuse(format!(
            "\"extract-dat.from\" names \"{from}\", which this mod does not ask for"
        ));
    }
    Ok(ModExtractDat {
        from,
        list: confined_path(
            fields.get("extract-dat.list").copied(),
            "\"extract-dat.list\"",
        )?,
        into: confined_path(
            fields.get("extract-dat.into").copied(),
            "\"extract-dat.into\"",
        )?,
    })
}

fn parse_conflicts(value: Option<&Yaml>) -> Parsed<Vec<ConflictRule>> {
    let listed = items(value, "\"conflicts\"")?;
    let mut out = Vec::new();
    for (at, rule) in listed.iter().enumerate() {
        let where_at = format!("\"conflicts\" entry {}", at + 1);
        let fields = record(Some(rule), &where_at, &["present", "absent", "reason"])?;
        let paths = |key: &str| -> Parsed<Vec<String>> {
            let Some(held) = fields.get(key) else {
                return Ok(Vec::new());
            };
            let listed = items(Some(held), &format!("{where_at}'s {key}"))?;
            let mut out = Vec::new();
            for (i, path) in listed.iter().enumerate() {
                out.push(confined_path(
                    Some(path),
                    &format!("{where_at}'s {key} {}", i + 1),
                )?);
            }
            Ok(out)
        };
        let present = paths("present")?;
        let absent = paths("absent")?;
        if present.is_empty() && absent.is_empty() {
            return refuse(format!("{where_at} tests nothing"));
        }
        out.push(ConflictRule {
            present,
            absent,
            reason: text(
                fields.get("reason").copied(),
                &format!("{where_at}'s reason"),
                LONG_TEXT,
            )?,
        });
    }
    Ok(out)
}

const MANIFEST_FIELDS: &[&str] = &[
    "spec",
    "id",
    "name",
    "version",
    "author",
    "description",
    "forum",
    "homepage",
    "game",
    "type",
    "reason",
    "archive",
    "needs.game",
    "needs.sfall",
    "entries",
    "order.overrides",
    "order.overridden-by",
    "part-groups",
    "parts",
    "becomes",
    "installer.windows.asset",
    "installer.windows.built-with",
    "installer.other.asset",
    "installer.other.run",
    "creates.directory",
    "inputs",
    "extract-dat.from",
    "extract-dat.list",
    "extract-dat.into",
    "conflicts",
    "settings",
    "install",
];

/// Whether the manifest states anything under a dotted prefix - `installer`, `order`, `extract-dat`.
fn states(fields: &BTreeMap<String, &Yaml>, prefix: &str) -> bool {
    let head = format!("{prefix}.");
    fields.keys().any(|key| key.starts_with(&head))
}

/// Counts aliases without building the document.
///
/// The TypeScript capped these through its YAML reader's own option. `yaml-rust2` has no such bound
/// and expands an alias by cloning what it points at, so the flood it guards against is available
/// here and has to be stopped before the document is built. Counted off the event stream rather than
/// by scanning for `*`, which would refuse a manifest whose prose happens to contain one.
#[derive(Default)]
struct AliasCounter {
    aliases: usize,
}

impl EventReceiver for AliasCounter {
    fn on_event(&mut self, event: Event) {
        if matches!(event, Event::Alias(_)) {
            self.aliases += 1;
        }
    }
}

/// Every platform the manifest names an installer for.
fn installer_platforms(root: &Yaml) -> Vec<String> {
    let Some(hash) = root.as_hash() else {
        return Vec::new();
    };
    let mut seen: Vec<String> = Vec::new();
    for key in hash.keys().filter_map(Yaml::as_str) {
        let Some(rest) = key.strip_prefix("installer.") else {
            continue;
        };
        let platform = rest.split('.').next().unwrap_or("");
        if !platform.is_empty() && !seen.iter().any(|held| held == platform) {
            seen.push(platform.to_owned());
        }
    }
    seen
}

/// Reads a manifest.
///
/// # Errors
///
/// Answers a [`Refusal`] naming the cause, worded for whoever has to fix the manifest.
#[expect(
    clippy::too_many_lines,
    reason = "one field at a time, in the spec's order"
)]
pub fn parse_manifest(bytes: &[u8], defaults: &ManifestDefaults) -> Parsed<ModManifest> {
    if bytes.len() > MANIFEST_BYTE_CAP {
        return refuse(format!(
            "it is {} bytes, past the {MANIFEST_BYTE_CAP} byte cap",
            bytes.len()
        ));
    }
    // Invalid UTF-8 is a refusal, not replacement characters silently standing in for the content.
    let Ok(source) = std::str::from_utf8(bytes) else {
        return refuse("it is not valid UTF-8");
    };

    let mut counter = AliasCounter::default();
    if Parser::new_from_str(source)
        .load(&mut counter, true)
        .is_err()
    {
        return refuse("it does not parse");
    }
    if counter.aliases > ALIAS_CAP {
        return refuse(format!(
            "it uses {} YAML aliases, past the {ALIAS_CAP} allowed",
            counter.aliases
        ));
    }

    let documents = match YamlLoader::load_from_str(source) {
        Ok(documents) => documents,
        Err(err) => {
            let first = err.to_string();
            let line = first.lines().next().unwrap_or("unreadable");
            return refuse(format!("it does not parse ({line})"));
        }
    };
    let root = documents.first().cloned().unwrap_or(Yaml::Null);

    // A later spec is answered ahead of everything else, the unknown-field pass included: that spec's
    // whole effect here is fields this version has no name for, and the answer to those is to update
    // ZAX rather than to name one of them a misspelling.
    if let Some(hash) = root.as_hash()
        && let Some(Yaml::Integer(stated)) = hash.get(&Yaml::String("spec".to_owned()))
        && *stated > MANIFEST_SPEC
    {
        return needs_newer_zax(format!(
            "it is written to manifest spec {stated}, this version reads spec {MANIFEST_SPEC}"
        ));
    }

    // Ahead of the unknown-field pass for the same reason a later spec is: a platform this version
    // has no name for is one a newer ZAX runs on, and `installer.haiku.run` would otherwise be
    // reported as a misspelling.
    for platform in installer_platforms(&root) {
        if platform != "windows" && platform != "other" {
            return needs_newer_zax(format!(
                "its \"installer\" names the platform \"{platform}\", which this version cannot run"
            ));
        }
    }

    // A section's description spells the section in its key, so the allowed set is whatever sections
    // are named.
    let section_keys: Vec<String> = root
        .as_hash()
        .map(|hash| {
            hash.keys()
                .filter_map(Yaml::as_str)
                .filter(|key| key.starts_with(SECTION_HELP_PREFIX))
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let allowed: Vec<&str> = MANIFEST_FIELDS
        .iter()
        .copied()
        .chain(section_keys.iter().map(String::as_str))
        .collect();
    let fields = record(Some(&root), "the manifest", &allowed)?;

    // Everything after this is judged by this version's rules, so the number that selects them is
    // checked here.
    match fields.get("spec") {
        Some(Yaml::Integer(spec)) if *spec >= 1 => {}
        Some(other) => {
            return refuse(format!("\"spec\" is {other:?}, not a spec number"));
        }
        None => return refuse("\"spec\" is missing, not a spec number"),
    }

    if fields.get("game").and_then(|held| held.as_str()) != Some("fallout2") {
        let said = fields
            .get("game")
            .and_then(|held| held.as_str())
            .unwrap_or("nothing");
        return refuse(format!("it is for \"{said}\", not Fallout 2"));
    }

    let id = text(fields.get("id").copied(), "\"id\"", SHORT_TEXT)?;
    if !is_mod_id(&id) {
        return refuse(format!("\"id\" (\"{id}\") is not an id"));
    }
    // The whole namespace, not just today's ids: a mod id inside a catalog prefix could mint setting
    // ids that a later catalog addition collides with, and a per-id check can only see the catalog as
    // it is now.
    let head = id.split('.').next().unwrap_or(&id);
    let catalog_prefixes: BTreeSet<&str> = settings()
        .iter()
        .map(|def| def.id.split('.').next().unwrap_or(""))
        .collect();
    if catalog_prefixes.contains(head) {
        return refuse(format!(
            "\"id\" (\"{id}\") is inside the catalog's \"{head}\" namespace"
        ));
    }
    // Read once, off the id: every path this manifest declares is judged against what ZAX grants it.
    let granted = grants_for(&id);

    // Stated wins over supplied: what the file says is the author's own claim, where the tag and the
    // release's assets are ZAX reading the release for one.
    let version = match fields.get("version") {
        Some(held) => literal(Some(held), "\"version\"")?,
        None => match &defaults.version {
            Some(held) => held.clone(),
            None => return refuse("it states no \"version\", and its release supplies none"),
        },
    };
    if !is_mod_version(&version) {
        return refuse(format!("\"version\" (\"{version}\") is not a version"));
    }

    let type_name = match fields.get("type") {
        None => "pluggable".to_owned(),
        Some(held) => text(Some(held), "\"type\"", SHORT_TEXT)?,
    };
    // The Fo1in2 operations are in the spec and not in this version.
    if fields.contains_key("install") {
        return needs_newer_zax(
            "it describes an install procedure, which this version does not perform",
        );
    }
    let mod_type = match type_name.as_str() {
        "pluggable" => ModType::Pluggable,
        "permanent" => ModType::Permanent,
        "base" => ModType::Base,
        other => {
            return needs_newer_zax(format!("\"{other}\" is not a mod type this version knows"));
        }
    };

    if mod_type == ModType::Permanent && !fields.contains_key("reason") {
        return refuse("a permanent mod must say why it cannot be uninstalled (\"reason\")");
    }
    if mod_type != ModType::Permanent && fields.contains_key("reason") {
        return refuse("\"reason\" belongs to permanent mods alone");
    }

    // A base mod is the only one that names an installer or creates an install, and the only one that
    // has to: these fields are what makes the install something ZAX hands over, or performs.
    let has_installer = states(&fields, "installer");
    let has_creates = fields.contains_key("creates.directory");
    for (what, stated) in [
        ("becomes", fields.contains_key("becomes")),
        ("installer", has_installer),
        ("creates", has_creates),
    ] {
        if mod_type != ModType::Base && stated {
            return refuse(format!("\"{what}\" belongs to a base mod alone"));
        }
    }

    let mut becomes = None;
    let mut installer = None;
    let mut creates = None;
    let mut inputs: Option<Vec<ModInput>> = None;
    let mut extract_dat = None;
    if mod_type == ModType::Base {
        // The two shapes of base mod, and a manifest is one or the other.
        if has_installer && has_creates {
            return refuse(
                "it names both an \"installer\" and what it \"creates\", which are the two ways of being a base mod",
            );
        }
        if !has_installer && !has_creates {
            return refuse(
                "a base mod names no \"installer\" and creates nothing, so nothing could install it",
            );
        }
        if has_installer {
            installer = Some(parse_installer(&fields)?);
        }
        if has_creates {
            creates = Some(parse_creates(fields.get("creates.directory").copied())?);
            inputs = match fields.get("inputs") {
                None => None,
                Some(held) => Some(parse_inputs(Some(held))?),
            };
            if states(&fields, "extract-dat") {
                extract_dat = Some(parse_extract_dat(
                    &fields,
                    inputs.as_deref().unwrap_or_default(),
                )?);
            }
        }
        // Required rather than defaulted to the id: the two namespaces do not coincide - RPU's id is
        // "rpu" and the type it becomes is "fallout2rpu".
        let named = text(fields.get("becomes").copied(), "\"becomes\"", SHORT_TEXT)?;
        let Some(game_type) = GameType::from_name(&named) else {
            return needs_newer_zax(format!(
                "\"becomes\" names the game type \"{named}\", which this version cannot detect"
            ));
        };
        becomes = Some(game_type);
    }

    // Both belong to the install a mod creates, and neither means anything without one.
    for (what, stated) in [
        ("inputs", fields.contains_key("inputs")),
        ("extract-dat", states(&fields, "extract-dat")),
    ] {
        if creates.is_none() && stated {
            return refuse(format!(
                "\"{what}\" belongs to a mod that creates an install"
            ));
        }
    }

    // Vanilla alone for a delegated base mod that says nothing - the direction both upstream scripts
    // enforce themselves. A creating mod goes back to anywhere: it writes only inside the directory
    // it makes.
    let mut install_on: Option<Vec<GameType>> =
        installer.as_ref().map(|_| vec![GameType::Fallout2]);
    if let Some(held) = fields.get("needs.game") {
        let listed = items(Some(held), "\"needs.game\"")?;
        let mut named = Vec::new();
        for (at, entry) in listed.iter().enumerate() {
            let name = text(
                Some(entry),
                &format!("\"needs.game\" entry {}", at + 1),
                SHORT_TEXT,
            )?;
            // A type this version has no marker for may be a future base mod's.
            let Some(game_type) = GameType::from_name(&name) else {
                return needs_newer_zax(format!(
                    "\"needs.game\" names the type \"{name}\", which this version cannot detect"
                ));
            };
            named.push(game_type);
        }
        if named.is_empty() {
            return refuse("\"needs.game\" is empty, which would install nowhere");
        }
        install_on = Some(named);
    }

    let mut requires_sfall = None;
    if let Some(held) = fields.get("needs.sfall") {
        // A bare version, read as "this or newer", because that is the only bound ZAX acts on.
        let stated = text(Some(held), "\"needs.sfall\"", SHORT_TEXT)?;
        let looks_like_version = stated.bytes().next().is_some_and(|b| b.is_ascii_digit())
            && stated
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'.');
        if !looks_like_version {
            return refuse(format!("\"needs.sfall\" (\"{stated}\") is not a version"));
        }
        requires_sfall = Some(stated);
    }

    // Declared together or not at all.
    if fields.contains_key("part-groups") != fields.contains_key("parts") {
        return refuse(
            "\"part-groups\" and \"parts\" are declared together - one without the other describes half a choice",
        );
    }
    let parts = match fields.get("parts") {
        None => None,
        Some(_) => Some(parse_parts(
            fields.get("part-groups").copied(),
            fields.get("parts").copied(),
        )?),
    };
    if parts.is_some() && fields.contains_key("archive") {
        return refuse(
            "it states both \"archive\" and \"parts\", where each part names the asset it deploys",
        );
    }
    if parts.is_some() && fields.contains_key("entries") {
        return refuse(
            "it states both \"entries\" and \"parts\", where each part declares what it puts in the mods folder",
        );
    }

    // A release supplies its sole archive as a default. For a parts manifest that asset describes
    // nothing this install would deploy, so it is passed over rather than refused.
    let archive = match fields.get("archive") {
        Some(held) => Some(asset_name(Some(held), "\"archive\"")?),
        None if parts.is_none() => defaults.archive.clone(),
        None => None,
    };

    let schema = match fields.get("settings") {
        None => ParsedSettings::default(),
        Some(held) => parse_settings(Some(held), &id, granted)?,
    };
    let section_help = parse_section_help(&fields, &schema)?;

    Ok(ModManifest {
        id,
        name: text(fields.get("name").copied(), "\"name\"", SHORT_TEXT)?,
        version,
        author: match fields.get("author") {
            None => None,
            Some(held) => Some(text(Some(held), "\"author\"", SHORT_TEXT)?),
        },
        description: match fields.get("description") {
            None => None,
            Some(held) => Some(text(Some(held), "\"description\"", LONG_TEXT)?),
        },
        forum: match fields.get("forum") {
            None => None,
            Some(held) => Some(link(Some(held), "\"forum\"")?),
        },
        homepage: match fields.get("homepage") {
            None => None,
            Some(held) => Some(link(Some(held), "\"homepage\"")?),
        },
        mod_type,
        reason: match mod_type {
            ModType::Permanent => Some(text(
                fields.get("reason").copied(),
                "\"reason\"",
                LONG_TEXT,
            )?),
            ModType::Pluggable | ModType::Base => None,
        },
        archive,
        install_on,
        becomes,
        installer,
        creates,
        inputs,
        extract_dat,
        requires_sfall,
        entries: match fields.get("entries") {
            None => None,
            Some(held) => Some(parse_entries(Some(held), "\"entries\"")?),
        },
        parts,
        order: if states(&fields, "order") {
            Some(parse_order(&fields)?)
        } else {
            None
        },
        conflicts: match fields.get("conflicts") {
            None => Vec::new(),
            Some(held) => parse_conflicts(Some(held))?,
        },
        settings: schema.settings,
        dropped: schema.dropped,
        section_help,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The least a manifest can say and still be one, so each test states only what it is about.
    fn minimal(extra: &str) -> String {
        format!("spec: 1\ngame: fallout2\nid: ecco\nname: EcCo\nversion: 1.0\n{extra}")
    }

    fn parse(text: &str) -> Parsed<ModManifest> {
        parse_manifest(text.as_bytes(), &ManifestDefaults::default())
    }

    fn accepted(text: &str) -> ModManifest {
        parse(text).unwrap_or_else(|err| panic!("this manifest should be read: {err}"))
    }

    fn refusal(text: &str) -> String {
        parse(text)
            .expect_err("this manifest should be refused")
            .to_string()
    }

    #[test]
    fn the_least_a_manifest_can_say_is_read() {
        let manifest = accepted(&minimal(""));
        assert_eq!(manifest.id, "ecco");
        assert_eq!(manifest.name, "EcCo");
        assert_eq!(manifest.version, "1.0");
        assert_eq!(manifest.mod_type, ModType::Pluggable, "the default type");
        assert!(manifest.conflicts.is_empty());
    }

    #[test]
    fn something_past_the_byte_cap_is_refused_before_parsing() {
        let huge = vec![b'#'; MANIFEST_BYTE_CAP + 1];
        let err = parse_manifest(&huge, &ManifestDefaults::default()).expect_err("past the cap");
        assert!(err.to_string().contains("byte cap"), "{err}");
    }

    #[test]
    fn an_alias_flood_is_refused() {
        // yaml-rust2 expands an alias by cloning what it points at and caps nothing, so the flood the
        // TypeScript's reader guarded against is available here and is stopped before the document is
        // built.
        let anchors = "a: &a [1, 2, 3]\n";
        let flood: String = (0..ALIAS_CAP + 10).map(|n| format!("k{n}: *a\n")).collect();
        let err = parse(&format!("{anchors}{flood}")).expect_err("a flood must be refused");
        assert!(err.to_string().contains("YAML aliases"), "{err}");
    }

    #[test]
    fn a_manifest_using_a_few_aliases_still_reads() {
        // The other direction: a guard that refused ordinary use would train its audience to ignore
        // it. Aliases are legitimate YAML and a real manifest may share a block of text.
        let text =
            "spec: 1\ngame: fallout2\nid: ecco\nname: &n EcCo\nversion: 1.0\ndescription: *n\n";
        assert_eq!(accepted(text).description.as_deref(), Some("EcCo"));
    }

    #[test]
    fn something_that_is_not_utf8_is_refused_rather_than_replaced() {
        let err = parse_manifest(&[0xff, 0xfe, 0xfd], &ManifestDefaults::default())
            .expect_err("invalid UTF-8");
        assert!(err.to_string().contains("UTF-8"), "{err}");
    }

    #[test]
    fn an_unknown_field_refuses_so_a_misspelling_cannot_drop_a_safety_check() {
        let said = refusal(&minimal("entires:\n  - x.dat\n"));
        assert!(said.contains("unknown field \"entires\""), "{said}");
    }

    #[test]
    fn a_later_spec_asks_for_a_newer_zax_rather_than_naming_a_misspelling() {
        // That spec's whole effect here is fields this version has no name for.
        let text = "spec: 99\ngame: fallout2\nid: ecco\nname: EcCo\nversion: 1.0\nwhatever: 1\n";
        let said = refusal(text);
        assert!(said.contains("needs a newer version of ZAX"), "{said}");
        assert!(said.contains("spec 99"), "{said}");
    }

    #[test]
    fn an_installer_platform_this_version_cannot_run_asks_for_a_newer_zax() {
        // `installer.haiku.run` would otherwise be reported as a misspelling.
        let said = refusal(&minimal("type: base\ninstaller.haiku.run: setup.sh\n"));
        assert!(said.contains("needs a newer version of ZAX"), "{said}");
        assert!(said.contains("haiku"), "{said}");
    }

    #[test]
    fn a_manifest_for_another_game_is_refused() {
        let said = refusal("spec: 1\ngame: fallout1\nid: x\nname: X\nversion: 1.0\n");
        assert!(said.contains("not Fallout 2"), "{said}");
    }

    #[test]
    fn an_id_inside_a_catalog_namespace_is_refused() {
        // A mod id inside a catalog prefix could mint setting ids a later catalog addition collides
        // with.
        let said = refusal("spec: 1\ngame: fallout2\nid: sfall\nname: X\nversion: 1.0\n");
        assert!(said.contains("namespace"), "{said}");
    }

    #[test]
    fn an_id_that_is_not_an_id_is_refused() {
        for bad in ["EcCo", "ec co", "/etc", ".hidden"] {
            let text = format!("spec: 1\ngame: fallout2\nid: \"{bad}\"\nname: X\nversion: 1.0\n");
            assert!(parse(&text).is_err(), "{bad} was accepted");
        }
    }

    #[test]
    fn a_version_the_release_supplies_is_used_when_the_file_states_none() {
        let text = "spec: 1\ngame: fallout2\nid: ecco\nname: EcCo\n";
        let defaults = ManifestDefaults {
            version: Some("2.0".to_owned()),
            archive: None,
        };
        let manifest = parse_manifest(text.as_bytes(), &defaults).expect("read");
        assert_eq!(manifest.version, "2.0");
    }

    #[test]
    fn what_the_file_states_wins_over_what_the_release_supplies() {
        let defaults = ManifestDefaults {
            version: Some("2.0".to_owned()),
            archive: None,
        };
        let manifest = parse_manifest(minimal("").as_bytes(), &defaults).expect("read");
        assert_eq!(manifest.version, "1.0", "the author's own claim wins");
    }

    #[test]
    fn a_manifest_with_no_version_anywhere_is_refused() {
        let said = refusal("spec: 1\ngame: fallout2\nid: ecco\nname: EcCo\n");
        assert!(said.contains("states no \"version\""), "{said}");
    }

    #[test]
    fn a_permanent_mod_must_say_why_it_cannot_be_uninstalled() {
        assert!(refusal(&minimal("type: permanent\n")).contains("reason"));
        let manifest = accepted(&minimal("type: permanent\nreason: it rewrites the maps\n"));
        assert_eq!(manifest.reason.as_deref(), Some("it rewrites the maps"));
    }

    #[test]
    fn a_reason_on_anything_but_a_permanent_mod_is_refused() {
        let said = refusal(&minimal("reason: because\n"));
        assert!(said.contains("belongs to permanent mods alone"), "{said}");
    }

    #[test]
    fn a_base_mod_names_an_installer_or_what_it_creates_but_never_both() {
        let both = minimal(
            "type: base\nbecomes: fallout2rpu\ninstaller.other.run: setup.sh\ncreates.directory: Fallout1in2\n",
        );
        assert!(refusal(&both).contains("both"), "{}", refusal(&both));

        let neither = minimal("type: base\nbecomes: fallout2rpu\n");
        assert!(
            refusal(&neither).contains("nothing could install it"),
            "{}",
            refusal(&neither)
        );
    }

    #[test]
    fn a_delegated_base_mod_installs_on_vanilla_alone_when_it_says_nothing() {
        // The direction both upstream scripts enforce themselves.
        let manifest = accepted(&minimal(
            "type: base\nbecomes: fallout2rpu\ninstaller.other.run: setup.sh\n",
        ));
        assert_eq!(
            manifest.install_on.as_deref(),
            Some([GameType::Fallout2].as_slice())
        );
    }

    #[test]
    fn a_creating_mod_goes_back_to_anywhere() {
        // It writes only inside the directory it makes.
        let manifest = accepted(&minimal(
            "type: base\nbecomes: fo1in2\ncreates.directory: Fallout1in2\n",
        ));
        assert_eq!(manifest.install_on, None);
        assert_eq!(
            manifest.creates.as_ref().map(|c| c.directory.as_str()),
            Some("Fallout1in2")
        );
    }

    #[test]
    fn a_created_directory_is_one_folder_of_the_install() {
        let said = refusal(&minimal(
            "type: base\nbecomes: fo1in2\ncreates.directory: games/Fallout1in2\n",
        ));
        assert!(said.contains("not one folder"), "{said}");
    }

    #[test]
    fn an_installer_built_with_something_unknown_asks_for_a_newer_zax() {
        let said = refusal(&minimal(
            "type: base\nbecomes: fallout2rpu\ninstaller.windows.built-with: nsis\n",
        ));
        assert!(said.contains("needs a newer version of ZAX"), "{said}");
    }

    #[test]
    fn a_base_mod_field_on_a_stacking_mod_is_refused() {
        for field in ["becomes: fallout2rpu\n", "creates.directory: X\n"] {
            let said = refusal(&minimal(field));
            assert!(said.contains("base mod alone"), "{field}: {said}");
        }
    }

    #[test]
    fn a_path_that_leaves_the_game_directory_is_refused() {
        for bad in ["../outside", "/etc/passwd", "C:/Windows", "a/../b"] {
            let text = minimal(&format!("entries:\n  - \"{bad}\"\n"));
            let said = refusal(&text);
            assert!(said.contains("leaves the game directory"), "{bad}: {said}");
        }
    }

    #[test]
    fn a_settings_file_outside_what_zax_grants_is_refused() {
        // That grant is ZAX's to give, not the manifest's to claim.
        let text = minimal(
            "settings:\n  Main.Key:\n    kind: bool\n    label: A switch\n    file: data/sound/music/x.ini\n",
        );
        let said = refusal(&text);
        assert!(said.contains("outside what ZAX grants"), "{said}");
    }

    #[test]
    fn a_settings_entry_defaults_to_the_mods_own_ini() {
        let text = minimal("settings:\n  Main.Key:\n    kind: bool\n    label: A switch\n");
        let manifest = accepted(&text);
        assert_eq!(manifest.settings.len(), 1);
        let target = manifest.settings[0].def.targets.own();
        assert_eq!(target.file, "mods/ecco.ini");
        assert_eq!(target.section, "Main");
        assert_eq!(target.key, "Key");
        assert_eq!(manifest.settings[0].def.id, "ecco.Main.Key");
    }

    #[test]
    fn a_settings_entry_with_a_kind_this_version_cannot_draw_is_dropped_not_refused() {
        // Refusing the mod over one would make it uninstallable for sitting on the wrong side of a
        // ZAX release.
        let text = minimal(
            "settings:\n  Main.Key:\n    kind: bool\n    label: A switch\n  Main.Future:\n    kind: hologram\n    label: Later\n",
        );
        let manifest = accepted(&text);
        assert_eq!(manifest.settings.len(), 1);
        assert_eq!(manifest.dropped.len(), 1);
        assert_eq!(manifest.dropped[0].address, "Main.Future");
        assert!(
            manifest.dropped[0].why.contains("hologram"),
            "{:?}",
            manifest.dropped
        );
    }

    #[test]
    fn a_control_gated_on_something_absent_is_dropped_with_it() {
        // It would render but silently never take effect, which is what gates exist to prevent.
        let text = minimal(
            "settings:\n  Main.Gate:\n    kind: hologram\n    label: Later\n  Main.Waiting:\n    kind: bool\n    label: Waits\n    gated-by:\n      id: ecco.Main.Gate\n      is: [1]\n",
        );
        let manifest = accepted(&text);
        assert!(manifest.settings.is_empty(), "{:?}", manifest.settings);
        assert_eq!(manifest.dropped.len(), 2);
    }

    #[test]
    fn a_gate_may_name_a_sibling_declared_later_in_the_file() {
        let text = minimal(
            "settings:\n  Main.Waiting:\n    kind: bool\n    label: Waits\n    gated-by:\n      id: ecco.Main.Switch\n      is: [1]\n  Main.Switch:\n    kind: bool\n    label: A switch\n",
        );
        assert_eq!(accepted(&text).settings.len(), 2);
    }

    #[test]
    fn a_gate_may_name_a_catalog_setting() {
        let catalog_id = &settings()[0].id;
        let text = minimal(&format!(
            "settings:\n  Main.Waiting:\n    kind: bool\n    label: Waits\n    gated-by:\n      id: {catalog_id}\n      is: [1]\n"
        ));
        assert_eq!(accepted(&text).settings.len(), 1);
    }

    #[test]
    fn a_gate_needs_exactly_one_of_is_and_is_not() {
        let text = minimal(
            "settings:\n  Main.Waiting:\n    kind: bool\n    label: Waits\n    gated-by:\n      id: ecco.Main.Switch\n      is: [1]\n      is-not: [0]\n",
        );
        assert!(refusal(&text).contains("exactly one"), "{}", refusal(&text));
    }

    #[test]
    fn a_bool_defaults_to_one_and_zero() {
        // What every ini bool in the corpus writes, so only the exceptions say so.
        let text = minimal("settings:\n  Main.Key:\n    kind: bool\n    label: A switch\n");
        let manifest = accepted(&text);
        assert_eq!(
            manifest.settings[0].def.kind,
            SettingKind::Bool {
                on_value: "1".to_owned(),
                off_value: "0".to_owned()
            }
        );
    }

    #[test]
    fn a_yaml_number_becomes_the_string_the_file_carries() {
        // YAML reads `on: 1` as a number, and requiring authors to quote every literal fails silently.
        let text = minimal(
            "settings:\n  Main.Key:\n    kind: bool\n    label: A switch\n    on: 2\n    off: 0\n    default: 2\n",
        );
        let manifest = accepted(&text);
        assert_eq!(
            manifest.settings[0].def.kind,
            SettingKind::Bool {
                on_value: "2".to_owned(),
                off_value: "0".to_owned()
            }
        );
        assert_eq!(manifest.settings[0].default.as_deref(), Some("2"));
    }

    #[test]
    fn a_section_description_must_land_on_a_section_some_setting_is_in() {
        let good = minimal(
            "settings:\n  Main.Key:\n    kind: bool\n    label: A switch\nsettings.sections.Main: What Main is for\n",
        );
        assert_eq!(
            accepted(&good)
                .section_help
                .as_ref()
                .and_then(|h| h.get("Main"))
                .map(String::as_str),
            Some("What Main is for")
        );

        let misspelt = minimal(
            "settings:\n  Main.Key:\n    kind: bool\n    label: A switch\nsettings.sections.Mian: Oops\n",
        );
        assert!(
            refusal(&misspelt).contains("no setting is in"),
            "{}",
            refusal(&misspelt)
        );
    }

    #[test]
    fn parts_and_part_groups_are_declared_together() {
        let text =
            minimal("parts:\n  - id: a\n    group: look\n    label: A\n    archive: a.zip\n");
        assert!(
            refusal(&text).contains("declared together"),
            "{}",
            refusal(&text)
        );
    }

    #[test]
    fn a_part_in_a_group_nothing_declares_is_refused() {
        let text = minimal(
            "part-groups:\n  - id: look\n    label: Look\n    pick: one\nparts:\n  - id: a\n    group: other\n    label: A\n    archive: a.zip\n",
        );
        assert!(
            refusal(&text).contains("does not declare"),
            "{}",
            refusal(&text)
        );
    }

    #[test]
    fn a_group_no_part_joined_is_refused() {
        // It would draw a heading over an empty box.
        let text = minimal(
            "part-groups:\n  - id: look\n    label: Look\n    pick: one\n  - id: extra\n    label: Extra\n    pick: any\nparts:\n  - id: a\n    group: look\n    label: A\n    archive: a.zip\n",
        );
        assert!(
            refusal(&text).contains("offers nothing to pick"),
            "{}",
            refusal(&text)
        );
    }

    #[test]
    fn two_parts_that_need_each_other_are_refused_at_publish_time() {
        let text = minimal(
            "part-groups:\n  - id: look\n    label: Look\n    pick: any\nparts:\n  - id: a\n    group: look\n    label: A\n    archive: a.zip\n    needs: b\n  - id: b\n    group: look\n    label: B\n    archive: b.zip\n    needs: a\n",
        );
        assert!(
            refusal(&text).contains("need each other"),
            "{}",
            refusal(&text)
        );
    }

    #[test]
    fn a_part_needing_itself_is_refused() {
        let text = minimal(
            "part-groups:\n  - id: look\n    label: Look\n    pick: any\nparts:\n  - id: a\n    group: look\n    label: A\n    archive: a.zip\n    needs: a\n",
        );
        assert!(
            refusal(&text).contains("needs itself"),
            "{}",
            refusal(&text)
        );
    }

    #[test]
    fn a_pick_this_version_does_not_implement_asks_for_a_newer_zax() {
        // Reading an unknown one as `any` would install what the author never described.
        let text = minimal(
            "part-groups:\n  - id: look\n    label: Look\n    pick: exactly-two\nparts:\n  - id: a\n    group: look\n    label: A\n    archive: a.zip\n",
        );
        assert!(
            refusal(&text).contains("needs a newer version of ZAX"),
            "{}",
            refusal(&text)
        );
    }

    #[test]
    fn a_parts_manifest_states_no_top_level_archive() {
        let text = minimal(
            "archive: whole.zip\npart-groups:\n  - id: look\n    label: Look\n    pick: one\nparts:\n  - id: a\n    group: look\n    label: A\n    archive: a.zip\n",
        );
        assert!(
            refusal(&text).contains("each part names"),
            "{}",
            refusal(&text)
        );
    }

    #[test]
    fn the_parts_come_back_flat_in_declared_order() {
        let text = minimal(
            "part-groups:\n  - id: look\n    label: Look\n    pick: one\nparts:\n  - id: a\n    group: look\n    label: A\n    archive: a.zip\n  - id: b\n    group: look\n    label: B\n    archive: b.zip\n",
        );
        let manifest = accepted(&text);
        assert_eq!(
            part_options(&manifest)
                .iter()
                .map(|p| p.id.as_str())
                .collect::<Vec<_>>(),
            vec!["a", "b"]
        );
    }

    #[test]
    fn an_order_claim_that_names_nothing_is_refused() {
        // It would read as a mod stating its place while placing itself nowhere.
        let text = minimal("order.overrides: []\norder.overridden-by: []\n");
        assert!(
            refusal(&text).contains("states no place"),
            "{}",
            refusal(&text)
        );
    }

    #[test]
    fn an_order_claim_is_read_as_the_order_file_spells_it() {
        let manifest = accepted(&minimal("order.overrides:\n  - rpu.dat\n"));
        assert_eq!(
            manifest.order.as_ref().map(|o| o.overrides.clone()),
            Some(vec!["rpu.dat".to_owned()])
        );
    }

    #[test]
    fn a_link_must_be_https() {
        // The value is handed to whatever the machine opens links with.
        for bad in ["http://example.com", "javascript:alert(1)", "file:///etc"] {
            let text = minimal(&format!("forum: \"{bad}\"\n"));
            assert!(
                refusal(&text).contains("not an https address"),
                "{bad}: {}",
                refusal(&text)
            );
        }
        assert_eq!(
            accepted(&minimal("forum: https://example.com/t/1\n"))
                .forum
                .as_deref(),
            Some("https://example.com/t/1")
        );
    }

    #[test]
    fn an_asset_name_is_a_file_name_rather_than_a_path() {
        // Single-quoted in YAML: inside double quotes a backslash starts an escape, so `\f` would be
        // read as a form feed and refused as a control character before the name rule is reached.
        for bad in ["dir/file.zip", "..\\file.zip", "C:file.zip", ".hidden"] {
            let text = minimal(&format!("archive: '{bad}'\n"));
            assert!(
                refusal(&text).contains("not a file name"),
                "{bad}: {}",
                refusal(&text)
            );
        }
    }

    #[test]
    fn a_conflict_that_tests_nothing_is_refused() {
        let text = minimal("conflicts:\n  - reason: it clashes\n");
        assert!(
            refusal(&text).contains("tests nothing"),
            "{}",
            refusal(&text)
        );
    }

    #[test]
    fn a_conflict_is_read_with_both_lists() {
        let text = minimal(
            "conflicts:\n  - present:\n      - mods/other.dat\n    reason: they overwrite each other\n",
        );
        let manifest = accepted(&text);
        assert_eq!(manifest.conflicts.len(), 1);
        assert_eq!(
            manifest.conflicts[0].present,
            vec!["mods/other.dat".to_owned()]
        );
        assert!(manifest.conflicts[0].absent.is_empty());
    }

    #[test]
    fn text_past_its_cap_is_refused() {
        let long = "x".repeat(SHORT_TEXT + 1);
        let text = minimal(&format!("author: {long}\n"));
        assert!(refusal(&text).contains("runs past"), "{}", refusal(&text));
    }

    #[test]
    fn text_with_control_characters_is_refused() {
        let text = minimal("author: \"a\\u0007b\"\n");
        assert!(
            refusal(&text).contains("control characters"),
            "{}",
            refusal(&text)
        );
    }

    #[test]
    fn extract_dat_must_name_an_input_the_mod_asks_for() {
        let text = minimal(
            "type: base\nbecomes: fo1in2\ncreates.directory: Fallout1in2\ninputs:\n  - id: fallout1\n    label: Your Fallout 1 folder\n    holds: master.dat\nextract-dat.from: nowhere\nextract-dat.list: undat.txt\nextract-dat.into: data\n",
        );
        assert!(
            refusal(&text).contains("does not ask for"),
            "{}",
            refusal(&text)
        );
    }

    #[test]
    fn extract_dat_reads_when_its_input_is_declared() {
        let text = minimal(
            "type: base\nbecomes: fo1in2\ncreates.directory: Fallout1in2\ninputs:\n  - id: fallout1\n    label: Your Fallout 1 folder\n    holds: master.dat\nextract-dat.from: fallout1\nextract-dat.list: undat_files.txt\nextract-dat.into: data\n",
        );
        let manifest = accepted(&text);
        let extract = manifest.extract_dat.as_ref().expect("extract-dat");
        assert_eq!(extract.from, "fallout1");
        assert_eq!(extract.into, "data");
        assert_eq!(manifest.inputs.as_ref().map(Vec::len), Some(1));
    }

    #[test]
    fn inputs_belong_to_a_mod_that_creates_an_install() {
        let text = minimal(
            "inputs:\n  - id: fallout1\n    label: Your Fallout 1 folder\n    holds: master.dat\n",
        );
        assert!(
            refusal(&text).contains("creates an install"),
            "{}",
            refusal(&text)
        );
    }

    #[test]
    fn a_needs_sfall_that_is_not_a_version_is_refused() {
        assert!(refusal(&minimal("needs.sfall: \">=4.5\"\n")).contains("not a version"));
        assert_eq!(
            accepted(&minimal("needs.sfall: \"4.5\"\n"))
                .requires_sfall
                .as_deref(),
            Some("4.5")
        );
    }

    #[test]
    fn an_empty_needs_game_is_refused() {
        let text = minimal("needs.game: []\n");
        assert!(
            refusal(&text).contains("install nowhere"),
            "{}",
            refusal(&text)
        );
    }

    #[test]
    fn a_needs_game_type_this_version_cannot_detect_asks_for_a_newer_zax() {
        let text = minimal("needs.game:\n  - fallout4\n");
        assert!(
            refusal(&text).contains("needs a newer version of ZAX"),
            "{}",
            refusal(&text)
        );
    }

    #[test]
    fn the_confinement_helpers_agree_with_the_parser() {
        assert!(is_confined("mods/ecco.dat"));
        assert!(!is_confined("../escape"));
        assert!(!is_confined("/etc/passwd"));

        assert!(inside_mods("mods/ecco.dat"));
        assert!(
            inside_mods("MODS/ecco.dat"),
            "the engine compares without case"
        );
        assert!(!inside_mods("mods"), "at least one segment below it");
        assert!(!inside_mods("data/ecco.dat"));

        assert!(may_write("mods/ecco.dat", &[]));
        assert!(!may_write("data/sound/music/x.mp3", &[]));
        assert!(may_write("data/sound/music/x.mp3", &["data/sound/music"]));
        assert!(
            !may_write("data/sound/music", &["data/sound/music"]),
            "a grant is one segment below, as mods/ is"
        );
    }
}

/// One specimen per shape the manifest format takes, each pinned to what it parses to.
///
/// The format is append-only within a spec major, and this is what makes that a test rather than an
/// intention: a change that alters what an already-published manifest means breaks a specimen here,
/// whether or not a unit test covered that combination of fields. Only valid manifests are pinned - a
/// refusal is not append-only, since a new field turns a text refused as unknown into one that parses.
#[cfg(test)]
mod corpus {
    use std::path::{Path, PathBuf};

    use serde_json::Value;

    use super::*;

    fn corpus() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/manifests")
    }

    /// The pins were written from the TypeScript parser, whose absent fields were left out rather than
    /// null, and whose setting carried its definition's fields beside its default rather than under one
    /// key. Both are spelling; neither changes what the manifest means.
    fn as_pinned(value: Value) -> Value {
        match value {
            Value::Object(fields) => {
                let mut out = serde_json::Map::new();
                for (key, held) in fields {
                    match (key.as_str(), held) {
                        (_, Value::Null) => {}
                        // A number with no sentinels carries an empty map here and nothing in the pins.
                        ("sentinels", Value::Object(map)) if map.is_empty() => {}
                        ("def", Value::Object(def)) => {
                            for (inner, value) in def {
                                if !value.is_null() {
                                    out.insert(inner, as_pinned(value));
                                }
                            }
                        }
                        (_, held) => {
                            out.insert(key, as_pinned(held));
                        }
                    }
                }
                Value::Object(out)
            }
            Value::Array(items) => Value::Array(items.into_iter().map(as_pinned).collect()),
            scalar @ (Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_)) => scalar,
        }
    }

    /// Where two values first part, and how - a whole manifest printed on one line hides the field.
    fn first_difference(parsed: &Value, pinned: &Value, at: &str) -> Option<String> {
        match (parsed, pinned) {
            (Value::Object(ours), Value::Object(theirs)) => {
                let keys: std::collections::BTreeSet<&String> =
                    ours.keys().chain(theirs.keys()).collect();
                keys.into_iter()
                    .find_map(|key| match (ours.get(key), theirs.get(key)) {
                        (Some(one), Some(other)) => {
                            first_difference(one, other, &format!("{at}.{key}"))
                        }
                        (one, other) => {
                            Some(format!("{at}.{key}: parsed {one:?}, pinned {other:?}"))
                        }
                    })
            }
            (Value::Array(ours), Value::Array(theirs)) if ours.len() == theirs.len() => ours
                .iter()
                .zip(theirs)
                .enumerate()
                .find_map(|(index, (one, other))| {
                    first_difference(one, other, &format!("{at}[{index}]"))
                }),
            // JSON has one number type, and the pins were written where `10` and `10.0` are one value.
            (Value::Number(one), Value::Number(other)) if one.as_f64() == other.as_f64() => None,
            (one, other) if one == other => None,
            (one, other) => Some(format!("{at}: parsed {one}, pinned {other}")),
        }
    }

    fn string_at(pinned: &Value, key: &str) -> Option<String> {
        pinned
            .get("defaults")
            .and_then(|defaults| defaults.get(key))
            .and_then(Value::as_str)
            .map(str::to_owned)
    }

    #[test]
    fn covers_every_publishing_shape_the_format_has() {
        let mut names: Vec<String> = std::fs::read_dir(corpus())
            .expect("the corpus directory")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".yml"))
            .collect();
        names.sort();
        assert_eq!(
            names,
            [
                "base.yml",
                "creates.yml",
                "entries.yml",
                "full.yml",
                "minimal.yml",
                "parts.yml",
                "settings.yml",
                "tagged.yml",
            ]
        );
    }

    #[test]
    fn every_specimen_reads_as_it_is_pinned() {
        let mut read = 0;
        for entry in std::fs::read_dir(corpus()).expect("the corpus directory") {
            let path = entry.expect("a corpus entry").path();
            if path.extension().is_none_or(|ext| ext != "yml") {
                continue;
            }
            let pinned: Value = serde_json::from_slice(
                &std::fs::read(path.with_extension("json")).expect("a pin beside the specimen"),
            )
            .expect("a pin is JSON");
            let defaults = ManifestDefaults {
                version: string_at(&pinned, "version"),
                archive: string_at(&pinned, "archive"),
            };
            let manifest = parse_manifest(&std::fs::read(&path).expect("the specimen"), &defaults)
                .unwrap_or_else(|err| panic!("{} should be read: {err}", path.display()));
            let parsed = as_pinned(serde_json::to_value(&manifest).expect("a manifest serializes"));
            assert_eq!(
                first_difference(&parsed, &pinned["parses"], "parses"),
                None,
                "{}",
                path.display()
            );
            read += 1;
        }
        // A moved corpus reads as nothing to compare, which the loop above would pass.
        assert_eq!(read, 8);
    }

    #[test]
    fn the_drafted_fo2tweaks_manifest_still_parses() {
        // A full-sized schema for a real mod's ini, drafted here: FO2tweaks publishes no manifest by
        // either route. The shapes are the specimens' job; this is that the whole of it still reads.
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/fo2tweaks/f2mod.yml");
        let manifest = parse_manifest(
            &std::fs::read(path).expect("the drafted manifest"),
            &ManifestDefaults {
                version: Some("14.7".to_owned()),
                archive: None,
            },
        )
        .unwrap_or_else(|err| panic!("the drafted manifest should be read: {err}"));
        assert_eq!(manifest.id, "fo2tweaks");
        assert!(!manifest.settings.is_empty());
    }
}

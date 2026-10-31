//! The mod index: the one document ZAX reads to know which mods exist, what each release is, and
//! where its files are.
//!
//! An indexer builds it from the followed repositories and serves it; every installed ZAX reads it, so
//! this module is the contract a deployed copy is held to. It grows by addition only. A field this
//! version does not know is passed over, and anything that would change what lands on disk is named
//! under a `requires` list first, so a version without it says it needs updating instead of
//! installing the wrong thing. A change those two rules cannot carry publishes a second index beside
//! this one rather than changing this one.
//!
//! Nothing here orders versions: the indexer ranks a mod's releases, and ZAX compares ranks.

use std::collections::BTreeMap;

use zax_platform::{Error, Result};

use crate::manifest::{ModManifest, parse_indexed_manifest, part_options};
use crate::mod_feed::ReleaseAsset;

/// The index format this version reads. A breaking change is published at a new address rather than
/// under a higher number here, so any other number is a document this version cannot read.
pub const INDEX_FORMAT: u32 = 1;

/// Every capability this version implements, by the name the indexer derives for it.
///
/// The one list both sides judge by: the indexer names a release's needs from it, and a release
/// naming anything else is one this version must not install.
pub const FEATURES: &[&str] = &[
    "base.inno",
    "base.script",
    "base.creates",
    "extract-dat",
    "grants",
    "line",
    "parts",
];

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Index {
    pub format: u32,
    /// When the indexer built it, RFC 3339. What tells a stale index from a current one.
    pub generated: String,
    /// The load order an edition states for itself, keyed by the game type's name, plus `shared`: what
    /// the editions agree on, for an install neither speaks for. A type this version does not know is
    /// passed over by whoever looks it up.
    #[serde(default)]
    pub orders: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub mods: Vec<IndexedMod>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct IndexedMod {
    pub id: String,
    /// What to call the mod where no release can be read.
    pub name: String,
    /// Whether the mod is the installation rather than something stacked on it, stated for the mod
    /// rather than read from a release for the same reason as `name`.
    #[serde(default)]
    pub base: bool,
    /// The stretch of a repository's numbering this mod follows, where one repository publishes
    /// parallel lines.
    #[serde(default)]
    pub line: Option<IndexedLine>,
    /// What judging this mod at all takes, beyond what each release needs.
    #[serde(default)]
    pub requires: Vec<String>,
    /// Newest first, as the indexer ranked them. Final releases only: prereleases, when offered, go in a
    /// list of their own, which a version that does not know it passes over instead of offering them.
    #[serde(default)]
    pub releases: Vec<IndexedRelease>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct IndexedLine {
    pub prefix: String,
    /// Whether this line inherits the bare counter the repository ran before it split.
    pub counter: bool,
}

impl IndexedLine {
    #[must_use]
    pub fn holds(&self, version: &str) -> bool {
        line_holds(&self.prefix, self.counter, version)
    }
}

/// The number a version ends on - 30 for `v30`, 34 for `2.3.34`, 30 for the `2.3.3u30` an install of
/// that era stamps. RPU's counter ran through all three spellings, so it is what orders a line whatever
/// scheme wrote it.
#[must_use]
pub fn counter_of(version: &str) -> Option<u64> {
    let digits = version.len() - version.trim_end_matches(|c: char| c.is_ascii_digit()).len();
    version[version.len() - digits..].parse().ok()
}

/// Whether a version belongs to a line: its own numbering, or the counter the line inherited. The one
/// rule both the indexer and a stamped install's placement judge by.
#[must_use]
pub fn line_holds(prefix: &str, counter: bool, version: &str) -> bool {
    version.starts_with(prefix)
        || (counter && !version.is_empty() && version.bytes().all(|b| b.is_ascii_digit()))
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct IndexedRelease {
    pub version: String,
    /// Higher is newer, within one mod. The only ordering ZAX applies to a mod's versions.
    pub rank: u64,
    /// When the release was published, RFC 3339.
    pub published: String,
    #[serde(default)]
    pub requires: Vec<String>,
    /// Every file the manifest names, keyed by the name it uses.
    #[serde(default)]
    pub assets: Vec<IndexedAsset>,
    /// The release's manifest as YAML text with every value explicit, read by the same parser as an
    /// author's file. Text rather than a JSON object because YAML keeps a scalar as it was written:
    /// `1.10` through a JSON number would come back as `1.1`, and a shipped default is compared as
    /// text.
    pub manifest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct IndexedAsset {
    pub name: String,
    pub url: String,
    pub size: u64,
    /// Lowercase hex, as the host states it. Always present: a release whose host states no digest is
    /// not indexed.
    pub sha256: String,
}

/// Reads the index.
///
/// # Errors
///
/// Fails where the text is not an index, or is one in a format this version does not read.
pub fn read_index(text: &str) -> Result<Index> {
    let index: Index = serde_json::from_str(text)
        .map_err(|err| Error::Unsupported(format!("The mod index could not be read: {err}.")))?;
    if index.format != INDEX_FORMAT {
        return Err(Error::Unsupported(format!(
            "The mod index is in format {}, and this version of ZAX reads format {INDEX_FORMAT}. \
             Update ZAX to see mods.",
            index.format
        )));
    }
    Ok(index)
}

/// When the index was built, in milliseconds since the epoch, read from the `YYYY-MM-DDTHH:MM:SS`
/// UTC instant the indexer writes; nothing for any other shape. Only an age is derived from it, so
/// the fraction and the zone suffix are not read.
#[must_use]
pub fn generated_millis(generated: &str) -> Option<i64> {
    let number = |range: std::ops::Range<usize>| -> Option<i64> {
        let digits = generated.get(range)?;
        digits
            .bytes()
            .all(|byte| byte.is_ascii_digit())
            .then(|| digits.parse().ok())?
    };
    let shaped = generated.as_bytes();
    if shaped.len() < 19
        || shaped[4] != b'-'
        || shaped[7] != b'-'
        || shaped[10] != b'T'
        || shaped[13] != b':'
        || shaped[16] != b':'
    {
        return None;
    }
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let seconds = number(11..13)? * 3600 + number(14..16)? * 60 + number(17..19)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    // Days from the civil date, counted in 400-year eras that start on 1 March so the leap day is last.
    let shifted = if month <= 2 { year - 1 } else { year };
    let era = shifted.div_euclid(400);
    let of_era = shifted - era * 400;
    let of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let of_cycle = of_era * 365 + of_era / 4 - of_era / 100 + of_year;
    let days = era * 146_097 + of_cycle - 719_468;
    Some((days * 86_400 + seconds) * 1000)
}

/// What a release needs that this version lacks, the mod's own needs included. Empty where it can be
/// installed.
#[must_use]
pub fn missing_features(listed: &IndexedMod, release: &IndexedRelease) -> Vec<String> {
    let mut missing: Vec<String> = Vec::new();
    for feature in listed.requires.iter().chain(&release.requires) {
        if !FEATURES.contains(&feature.as_str()) && !missing.contains(feature) {
            missing.push(feature.clone());
        }
    }
    missing
}

/// One release as ZAX holds it: the manifest read through the indexed parser, its exact text for the
/// record, and the assets in the shape a download verifies against.
#[derive(Debug, Clone, PartialEq)]
pub struct ReadRelease {
    pub manifest: ModManifest,
    pub manifest_text: String,
    pub assets: Vec<ReleaseAsset>,
}

/// Reads one release's manifest and assets, holding them to each other and to the mod they are listed
/// under.
///
/// # Errors
///
/// Fails where the release needs what this version lacks, where its manifest is refused, or where the
/// manifest names a file the release does not list - each a release this version must not install.
pub fn read_release(listed: &IndexedMod, release: &IndexedRelease) -> Result<ReadRelease> {
    let missing = missing_features(listed, release);
    if !missing.is_empty() {
        return Err(Error::Unsupported(format!(
            "{} {} needs a newer version of ZAX (it uses {}).",
            listed.name,
            release.version,
            missing.join(", ")
        )));
    }
    let manifest_text = release.manifest.clone();
    let manifest = parse_indexed_manifest(manifest_text.as_bytes()).map_err(|refusal| {
        Error::Unsupported(format!(
            "The manifest of {} {} was refused: {refusal}.",
            listed.name, release.version
        ))
    })?;
    if manifest.id != listed.id || manifest.version != release.version {
        return Err(Error::Unsupported(format!(
            "The index lists {} {} with a manifest for {} {}.",
            listed.id, release.version, manifest.id, manifest.version
        )));
    }

    let assets: Vec<ReleaseAsset> = release
        .assets
        .iter()
        .map(|asset| ReleaseAsset {
            name: asset.name.clone(),
            url: asset.url.clone(),
            digest: Some(format!("sha256:{}", asset.sha256)),
            size: Some(asset.size),
        })
        .collect();
    for named in named_assets(&manifest) {
        if !assets.iter().any(|asset| asset.name == named) {
            return Err(Error::Unsupported(format!(
                "{} {} names the file {named}, which the index does not list for it.",
                listed.name, release.version
            )));
        }
    }
    Ok(ReadRelease {
        manifest,
        manifest_text,
        assets,
    })
}

/// Every asset a manifest names: its payload, each part's, and each installer route's.
fn named_assets(manifest: &ModManifest) -> Vec<String> {
    let mut out: Vec<String> = manifest.archive.iter().cloned().collect();
    out.extend(
        part_options(manifest)
            .iter()
            .map(|part| part.archive.clone()),
    );
    if let Some(installer) = &manifest.installer {
        out.extend(
            installer
                .windows
                .iter()
                .filter_map(|route| route.asset.clone()),
        );
        out.extend(
            installer
                .other
                .iter()
                .filter_map(|route| route.asset.clone()),
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn asset(name: &str) -> serde_json::Value {
        json!({ "name": name, "url": format!("https://example/{name}"), "size": 7, "sha256": "ab" })
    }

    /// An index of one mod with one release, so each test states only what it is about.
    fn index(manifest: serde_json::Value, extra: serde_json::Value) -> serde_json::Value {
        let mut release = json!({
            "version": "1.0",
            "rank": 1,
            "published": "2026-10-31T00:00:00Z",
            "assets": [asset("ecco.zip")],
            // JSON text is YAML, so a test can build the document as a value.
            "manifest": manifest.to_string(),
        });
        if let (Some(into), Some(from)) = (release.as_object_mut(), extra.as_object()) {
            for (key, value) in from {
                into.insert(key.clone(), value.clone());
            }
        }
        json!({
            "format": 1,
            "generated": "2026-10-31T00:00:00Z",
            "mods": [{ "id": "ecco", "name": "EcCo", "releases": [release] }],
        })
    }

    fn manifest() -> serde_json::Value {
        json!({
            "spec": 1, "game": "fallout2", "id": "ecco", "name": "EcCo", "version": "1.0",
            "archive": "ecco.zip",
        })
    }

    fn read(document: &serde_json::Value) -> Result<ReadRelease> {
        let index = read_index(&document.to_string())?;
        let listed = &index.mods[0];
        read_release(listed, &listed.releases[0])
    }

    #[test]
    fn a_release_reads_with_its_digest_in_the_shape_a_download_verifies() {
        let read = read(&index(manifest(), json!({}))).expect("a release");
        assert_eq!(read.manifest.id, "ecco");
        assert_eq!(read.manifest.archive.as_deref(), Some("ecco.zip"));
        assert_eq!(read.assets[0].digest.as_deref(), Some("sha256:ab"));
        assert_eq!(read.assets[0].size, Some(7));
    }

    #[test]
    fn fields_this_version_does_not_know_are_passed_over_at_every_level() {
        let mut document = index(
            json!({
                "spec": 1, "game": "fallout2", "id": "ecco", "name": "EcCo", "version": "1.0",
                "archive": "ecco.zip", "later": true,
                "conflicts": [{ "present": ["mods/x.dat"], "reason": "No.", "later": 1 }],
                "settings": { "main.a": { "kind": "bool", "label": "A", "later": 1 } },
            }),
            json!({ "later": { "nested": 1 } }),
        );
        document["later"] = json!(1);
        document["mods"][0]["later"] = json!(1);
        document["mods"][0]["releases"][0]["assets"][0]["later"] = json!(1);
        let read = read(&document).expect("a release");
        assert_eq!(read.manifest.conflicts.len(), 1);
        assert_eq!(read.manifest.settings.len(), 1);
    }

    #[test]
    fn a_release_needing_what_this_version_lacks_is_refused_naming_it() {
        let refused = read(&index(
            manifest(),
            json!({ "requires": ["parts", "supersedes"] }),
        ))
        .expect_err("needs a newer ZAX");
        let text = refused.to_string();
        assert!(text.contains("needs a newer version of ZAX"), "{text}");
        assert!(text.contains("supersedes"), "{text}");
        assert!(
            !text.contains("parts"),
            "a feature this version has is not named: {text}"
        );
    }

    #[test]
    fn a_mod_needing_what_this_version_lacks_refuses_every_release() {
        let mut document = index(manifest(), json!({}));
        document["mods"][0]["requires"] = json!(["line.calendar"]);
        assert!(read(&document).is_err());
    }

    #[test]
    fn a_manifest_naming_a_file_the_release_does_not_list_is_refused() {
        let mut document = index(manifest(), json!({}));
        document["mods"][0]["releases"][0]["assets"] = json!([asset("other.zip")]);
        let text = read(&document).expect_err("an unlisted file").to_string();
        assert!(text.contains("ecco.zip"), "{text}");
    }

    #[test]
    fn a_manifest_for_another_mod_or_version_is_refused() {
        let mut document = index(manifest(), json!({}));
        document["mods"][0]["releases"][0]["version"] = json!("2.0");
        assert!(read(&document).is_err());
    }

    #[test]
    fn the_indexed_manifest_is_held_to_the_authors_boundary() {
        let mut escaping = manifest();
        escaping["entries"] = json!(["../ddraw.dll"]);
        assert!(read(&index(escaping, json!({}))).is_err());
    }

    #[test]
    fn grants_are_read_from_the_index_and_widen_where_a_setting_may_write() {
        let mut granted = manifest();
        granted["grants"] = json!(["data/sound/music"]);
        granted["settings"] = json!({
            "main.a": { "kind": "bool", "label": "A", "file": "data/sound/music/hq.ini" },
        });
        let held = read(&index(granted, json!({}))).expect("a granted mod");
        assert_eq!(held.manifest.grants, vec!["data/sound/music".to_owned()]);
        assert_eq!(held.manifest.settings.len(), 1);

        let mut ungranted = manifest();
        ungranted["settings"] = json!({
            "main.a": { "kind": "bool", "label": "A", "file": "data/sound/music/hq.ini" },
        });
        assert!(read(&index(ungranted, json!({}))).is_err());
    }

    #[test]
    fn the_build_instant_reads_as_milliseconds_since_the_epoch() {
        assert_eq!(generated_millis("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            generated_millis("2026-10-31T10:34:11.113448548Z"),
            Some(1_793_442_851_000)
        );
        // The leap day sits at the end of the shifted year, so the day after it is one day on.
        assert_eq!(
            generated_millis("2024-03-01T00:00:00Z").zip(generated_millis("2024-02-29T00:00:00Z")),
            Some((1_709_251_200_000, 1_709_164_800_000))
        );
        assert_eq!(generated_millis("yesterday"), None);
        assert_eq!(generated_millis("2026-13-01T00:00:00Z"), None);
    }

    #[test]
    fn another_format_is_refused_as_needing_an_update() {
        let mut document = index(manifest(), json!({}));
        document["format"] = json!(2);
        let text = read_index(&document.to_string())
            .expect_err("format 2")
            .to_string();
        assert!(text.contains("Update ZAX"), "{text}");
    }
}

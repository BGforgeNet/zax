//! The journal one mod install writes before it touches the game directory, and everything a retry or
//! a restore reads back out of it.
//!
//! Created once, at the start of the first attempt, and never rewritten: what it captures - the release
//! being installed, the record entry that install replaces, the load order as it stood - is true of the
//! moment before anything was written, and a second attempt that re-captured it would be capturing the
//! first attempt's wreckage. That is the whole reason this is a file rather than a set of values passed
//! along: the install runs again on a retry, and by then the directory no longer says what it used to.
//!
//! It lives in the working directory beside the downloaded archive and the copies deployment set aside,
//! so one directory holds the entire recovery and clearing it discards the transaction whole.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use yaml_rust2::{Yaml, YamlEmitter, YamlLoader};
use zax_core::directories::temporary_directory;
use zax_core::install::Install;
use zax_platform::fs::FileKind;
use zax_platform::{Error, Platform, Result};

use crate::manifest::{ManifestDefaults, ModType, parse_manifest};
use crate::mod_feed::{ModRelease, ReleaseAsset};
use crate::records::{InstalledMod, install_key};

/// Bumped when the meaning of a field changes; a journal this version cannot read is not resumed.
const TRANSACTION_FORMAT: i64 = 3;

const JOURNAL: &str = "transaction.json";

/// Where one payload came from, kept verbatim so a retry fetches what the first attempt did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
pub struct PinnedAsset {
    pub name: String,
    pub url: String,
    pub digest: String,
}

impl From<&PinnedAsset> for ReleaseAsset {
    fn from(pinned: &PinnedAsset) -> Self {
        Self {
            name: pinned.name.clone(),
            url: pinned.url.clone(),
            digest: Some(pinned.digest.clone()),
            size: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModTransaction {
    pub id: String,
    /// The release this transaction installs, pinned - its manifest verbatim, and where the payload is.
    /// A retry resumes these rather than whatever the feed now calls newest: the copies waiting beside
    /// them were set aside against this version, and an install that changed release mid-flight would
    /// leave a recovery that no longer matches what is on disk.
    pub archive: Option<PinnedAsset>,
    /// One pinned asset per chosen part, for a release that has them, and the selection that chose
    /// them. A retry finishes the same parts from the same files: the copies waiting beside them are
    /// those parts', and asking the interface again would let a second answer land on the first
    /// attempt's half-deployed directory. Empty for a release with no parts.
    pub parts: BTreeMap<String, PinnedAsset>,
    pub selection: Vec<String>,
    pub manifest_text: String,
    /// The version this install resolved to, part of the pin rather than re-derivable: a manifest read
    /// from the repository states no version, so the tag it came from is the only thing that knows
    /// which release a retry is finishing.
    pub version: String,
    /// The record entry this install replaces, or nothing when it replaces nothing. The restore's
    /// target.
    pub previous: Option<InstalledMod>,
    /// `mods_order.txt` exactly as it stood, or nothing when the install had none - the other half of
    /// that target.
    pub order: Option<String>,
    /// Which of the payload's paths were already on disk when the transaction opened. Recorded because
    /// after a failed attempt the directory can no longer answer it: every path the attempt deployed
    /// looks occupied, and a retry that read presence off the directory would set the half-installed
    /// file aside as if it were the user's original.
    pub preexisting: Vec<String>,
}

/// The journal as it sits on disk. Its own shape rather than serde on the types above, because
/// `InstalledMod` carries a YAML value for the fields a newer ZAX may have written and JSON has no
/// place to put one - so the entry travels as the YAML the record itself holds.
#[derive(Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
struct Journal {
    transaction: i64,
    id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    archive: Option<PinnedAsset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    parts: Option<BTreeMap<String, PinnedAsset>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    selection: Option<Vec<String>>,
    #[serde(rename = "manifestText")]
    manifest_text: String,
    version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    previous: Option<RecordedMod>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    order: Option<String>,
    #[serde(default)]
    preexisting: Vec<String>,
}

/// One record entry as the journal writes it.
#[derive(Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
struct RecordedMod {
    id: String,
    version: String,
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    mod_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    complete: bool,
    files: Vec<String>,
    entries: Vec<String>,
    parts: Vec<String>,
    manifest: String,
    shipped: BTreeMap<String, String>,
    /// The fields the record could not interpret, as the YAML document they were read from - the one
    /// representation that cannot lose a value JSON has no type for.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    carried: String,
}

fn type_name(mod_type: ModType) -> &'static str {
    match mod_type {
        ModType::Pluggable => "pluggable",
        ModType::Permanent => "permanent",
        ModType::Base => "base",
    }
}

fn type_named(name: &str) -> Option<ModType> {
    match name {
        "pluggable" => Some(ModType::Pluggable),
        "permanent" => Some(ModType::Permanent),
        "base" => Some(ModType::Base),
        _ => None,
    }
}

/// The carried fields as one YAML mapping, or an empty string where there are none.
fn carried_text(carried: &BTreeMap<String, Yaml>) -> String {
    if carried.is_empty() {
        return String::new();
    }
    let mut hash = yaml_rust2::yaml::Hash::new();
    for (key, value) in carried {
        hash.insert(Yaml::String(key.clone()), value.clone());
    }
    let mut out = String::new();
    let mut emitter = YamlEmitter::new(&mut out);
    // Every value here came out of a YAML document, and the sink is a String.
    let _ = emitter.dump(&Yaml::Hash(hash));
    out
}

fn carried_from(text: &str) -> BTreeMap<String, Yaml> {
    let mut out = BTreeMap::new();
    let Ok(documents) = YamlLoader::load_from_str(text) else {
        return out;
    };
    let Some(Yaml::Hash(hash)) = documents.first() else {
        return out;
    };
    for (key, value) in hash {
        if let Yaml::String(key) = key {
            out.insert(key.clone(), value.clone());
        }
    }
    out
}

/// Where one transaction keeps everything: keyed by install and mod, and deliberately not by version.
/// By install, because the same release installed into two game directories is two transactions and
/// sharing one directory would let whichever finished first delete the other's recovery. Not by
/// version, because a retry has to find the directory the first attempt opened even if the feed has
/// moved on since.
#[must_use]
pub fn mod_work_directory(platform: &dyn Platform, install: &Install, id: &str) -> PathBuf {
    temporary_directory(platform).join(format!("mod-{}-{id}", install_key(&install.path)))
}

/// The transaction this install has open for this mod, or nothing where it has none or where the
/// journal is one this version cannot resume from.
///
/// # Errors
///
/// Fails where the journal is there but cannot be read.
pub fn read_transaction(
    platform: &dyn Platform,
    install: &Install,
    id: &str,
) -> Result<Option<ModTransaction>> {
    let at = mod_work_directory(platform, install, id).join(JOURNAL);
    if platform.fs().stat(&at)?.map(|stat| stat.kind) != Some(FileKind::File) {
        return Ok(None);
    }
    let body = platform.fs().read(&at)?;
    let Ok(journal) = serde_json::from_slice::<Journal>(&body) else {
        return Ok(None);
    };
    // A journal written to a format this version does not know is not a journal it can resume from
    // safely.
    if journal.transaction != TRANSACTION_FORMAT {
        return Ok(None);
    }
    // One or the other: a parts release has no single payload, and a journal with neither pins nothing.
    if journal.archive.is_none() && journal.parts.is_none() {
        return Ok(None);
    }
    Ok(Some(ModTransaction {
        id: journal.id,
        archive: journal.archive,
        parts: journal.parts.unwrap_or_default(),
        selection: journal.selection.unwrap_or_default(),
        manifest_text: journal.manifest_text,
        version: journal.version,
        previous: journal.previous.map(|held| InstalledMod {
            id: held.id,
            version: held.version,
            mod_type: held.mod_type.as_deref().and_then(type_named),
            reason: held.reason,
            complete: held.complete,
            files: held.files,
            entries: held.entries,
            parts: held.parts,
            manifest: held.manifest,
            shipped: held.shipped,
            carried: carried_from(&held.carried),
        }),
        order: journal.order,
        preexisting: journal.preexisting,
    }))
}

/// Writes the journal, which happens once per transaction.
///
/// # Errors
///
/// Fails where the working directory cannot be written to.
pub fn write_transaction(
    platform: &dyn Platform,
    install: &Install,
    transaction: &ModTransaction,
) -> Result<()> {
    let at = mod_work_directory(platform, install, &transaction.id).join(JOURNAL);
    let journal = Journal {
        transaction: TRANSACTION_FORMAT,
        id: transaction.id.clone(),
        archive: transaction.archive.clone(),
        parts: (!transaction.parts.is_empty()).then(|| transaction.parts.clone()),
        selection: (!transaction.selection.is_empty()).then(|| transaction.selection.clone()),
        manifest_text: transaction.manifest_text.clone(),
        version: transaction.version.clone(),
        previous: transaction.previous.as_ref().map(|held| RecordedMod {
            id: held.id.clone(),
            version: held.version.clone(),
            mod_type: held.mod_type.map(type_name).map(str::to_owned),
            reason: held.reason.clone(),
            complete: held.complete,
            files: held.files.clone(),
            entries: held.entries.clone(),
            parts: held.parts.clone(),
            manifest: held.manifest.clone(),
            shipped: held.shipped.clone(),
            carried: carried_text(&held.carried),
        }),
        order: transaction.order.clone(),
        preexisting: transaction.preexisting.clone(),
    };
    let body = serde_json::to_vec(&journal)
        .map_err(|err| Error::Unsupported(format!("The transaction cannot be written: {err}")))?;
    platform.fs().write(&at, &body)
}

/// The pinned release, as the feed would have answered it. What makes a retry install the version its
/// unfinished attempt started on, without asking the network which version that was.
///
/// # Errors
///
/// Fails where the pinned manifest will not parse, which a journal this version wrote cannot produce.
pub fn release_of(transaction: &ModTransaction) -> Result<ModRelease> {
    let manifest = parse_manifest(
        transaction.manifest_text.as_bytes(),
        &ManifestDefaults {
            version: Some(transaction.version.clone()),
            archive: transaction
                .archive
                .as_ref()
                .map(|pinned| pinned.name.clone()),
        },
    )
    .map_err(|refusal| Error::Unsupported(refusal.to_string()))?;
    Ok(ModRelease {
        manifest,
        manifest_text: transaction.manifest_text.clone(),
        archive: transaction.archive.as_ref().map(ReleaseAsset::from),
        parts: transaction
            .parts
            .iter()
            .map(|(id, pinned)| (id.clone(), ReleaseAsset::from(pinned)))
            .collect(),
        installer: None,
        installer_route: None,
        line: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use zax_core::install::GameType;
    use zax_platform::memory::{Content, MemoryOptions, MemoryPlatform};

    const MANIFEST: &str =
        "spec: 1\nid: ecco\nname: EcCo\ngame: fallout2\ntype: pluggable\narchive: ecco.zip\n";

    fn install() -> Install {
        Install::new("/games/f2", GameType::Fallout2)
    }

    fn pinned() -> PinnedAsset {
        PinnedAsset {
            name: "ecco.zip".to_owned(),
            url: "https://example/ecco.zip".to_owned(),
            digest: format!("sha256:{}", "a".repeat(64)),
        }
    }

    fn transaction() -> ModTransaction {
        ModTransaction {
            id: "ecco".to_owned(),
            archive: Some(pinned()),
            parts: BTreeMap::new(),
            selection: Vec::new(),
            manifest_text: MANIFEST.to_owned(),
            version: "1.0".to_owned(),
            previous: None,
            order: None,
            preexisting: Vec::new(),
        }
    }

    fn platform() -> MemoryPlatform {
        MemoryPlatform::new(MemoryOptions::default())
    }

    fn held(platform: &MemoryPlatform) -> PathBuf {
        mod_work_directory(platform, &install(), "ecco").join(JOURNAL)
    }

    #[test]
    fn a_transaction_written_is_read_back_whole() {
        let platform = platform();
        let before = ModTransaction {
            selection: vec!["wide".to_owned()],
            parts: BTreeMap::from([("wide".to_owned(), pinned())]),
            order: Some("ecco.dat\n".to_owned()),
            preexisting: vec!["mods/ecco.dat".to_owned()],
            ..transaction()
        };
        write_transaction(&platform, &install(), &before).expect("a journal");
        let after = read_transaction(&platform, &install(), "ecco")
            .expect("a read")
            .expect("the journal is there");
        assert_eq!(after, before);
    }

    #[test]
    fn a_record_entry_survives_the_journal_with_the_fields_this_version_cannot_read() {
        // A newer ZAX may record more per mod, and a restore that dropped those would erase them.
        let platform = platform();
        let carried = BTreeMap::from([(
            "sidecars".to_owned(),
            Yaml::Array(vec![Yaml::String("a".to_owned()), Yaml::Integer(2)]),
        )]);
        let previous = InstalledMod {
            id: "ecco".to_owned(),
            version: "0.9".to_owned(),
            mod_type: Some(ModType::Permanent),
            reason: Some("it rewrites the scripts".to_owned()),
            complete: true,
            files: vec!["mods/ecco.dat".to_owned()],
            entries: vec!["ecco.dat".to_owned()],
            parts: vec!["wide".to_owned()],
            manifest: MANIFEST.to_owned(),
            shipped: BTreeMap::from([("ddraw.ini".to_owned(), "[Misc]\n".to_owned())]),
            carried,
        };
        let before = ModTransaction {
            previous: Some(previous.clone()),
            ..transaction()
        };
        write_transaction(&platform, &install(), &before).expect("a journal");
        let after = read_transaction(&platform, &install(), "ecco")
            .expect("a read")
            .expect("the journal is there");
        assert_eq!(after.previous, Some(previous));
    }

    #[test]
    fn an_install_with_no_transaction_has_none_to_resume() {
        let platform = platform();
        assert_eq!(
            read_transaction(&platform, &install(), "ecco").expect("a read"),
            None
        );
    }

    #[test]
    fn a_journal_in_a_format_this_version_does_not_know_is_not_resumed() {
        let platform = platform();
        write_transaction(&platform, &install(), &transaction()).expect("a journal");
        let body = platform.fs().read(&held(&platform)).expect("a read");
        let text = String::from_utf8(body).expect("the journal is JSON");
        let ahead = text.replace(
            &format!("\"transaction\":{TRANSACTION_FORMAT}"),
            "\"transaction\":99",
        );
        platform
            .fs()
            .write(&held(&platform), ahead.as_bytes())
            .expect("a write");
        assert_eq!(
            read_transaction(&platform, &install(), "ecco").expect("a read"),
            None
        );
    }

    #[test]
    fn a_journal_that_will_not_parse_is_not_resumed() {
        let platform = MemoryPlatform::new(MemoryOptions::default());
        platform
            .fs()
            .write(&held(&platform), b"{ not json")
            .expect("a write");
        assert_eq!(
            read_transaction(&platform, &install(), "ecco").expect("a read"),
            None
        );
    }

    #[test]
    fn a_journal_pinning_neither_a_payload_nor_a_part_is_not_resumed() {
        let platform = platform();
        let body = format!(
            r#"{{"transaction":{TRANSACTION_FORMAT},"id":"ecco","manifestText":"x",
                 "version":"1.0","preexisting":[]}}"#
        );
        platform
            .fs()
            .write(&held(&platform), body.as_bytes())
            .expect("a write");
        assert_eq!(
            read_transaction(&platform, &install(), "ecco").expect("a read"),
            None
        );
    }

    #[test]
    fn the_pinned_release_is_the_version_the_attempt_started_on() {
        // Without asking the network which version that was.
        let release = release_of(&transaction()).expect("a release");
        assert_eq!(release.manifest.version, "1.0");
        assert_eq!(release.manifest.id, "ecco");
        assert_eq!(
            release.archive.as_ref().map(|asset| asset.name.as_str()),
            Some("ecco.zip")
        );
        assert_eq!(
            release
                .archive
                .as_ref()
                .and_then(|asset| asset.digest.as_deref()),
            Some(pinned().digest.as_str())
        );
    }

    #[test]
    fn two_installs_of_one_mod_keep_their_recoveries_apart() {
        // Sharing one directory would let whichever finished first delete the other's.
        let platform = platform();
        let other = Install::new("/games/second", GameType::Fallout2);
        assert_ne!(
            mod_work_directory(&platform, &install(), "ecco"),
            mod_work_directory(&platform, &other, "ecco")
        );
    }

    #[test]
    fn the_working_directory_does_not_change_with_the_version() {
        // A retry has to find the directory the first attempt opened even if the feed has moved on.
        let platform = platform();
        let at = mod_work_directory(&platform, &install(), "ecco");
        let name = at.file_name().and_then(|one| one.to_str()).expect("a name");
        assert!(!name.contains("1.0"), "{name}");
        assert!(name.ends_with("-ecco"), "{name}");
    }

    #[test]
    fn the_journal_sits_beside_what_the_attempt_downloaded() {
        // One directory holds the entire recovery, so clearing it discards the transaction whole.
        let platform = MemoryPlatform::new(MemoryOptions {
            files: BTreeMap::from([(
                mod_work_directory(
                    &MemoryPlatform::new(MemoryOptions::default()),
                    &install(),
                    "ecco",
                )
                .join("ecco.zip")
                .to_string_lossy()
                .into_owned(),
                Content::from("payload"),
            )]),
            ..MemoryOptions::default()
        });
        write_transaction(&platform, &install(), &transaction()).expect("a journal");
        let work = mod_work_directory(&platform, &install(), "ecco");
        platform.fs().remove(&work).expect("a removal");
        assert_eq!(
            read_transaction(&platform, &install(), "ecco").expect("a read"),
            None
        );
        assert_eq!(
            platform.fs().stat(&work.join("ecco.zip")).expect("a read"),
            None
        );
    }
}

//! Turning the source files and the repositories' releases into the index.
//!
//! A release that cannot be described is listed as skipped, with its reason, so ZAX can say why a
//! version is missing. A failure to read GitHub is not that: it fails the whole build, so the index
//! already published stays up rather than being replaced by one with that mod's releases missing.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use yaml_rust2::{Yaml, YamlEmitter, YamlLoader};
use zax_fallout2::index::{
    Channel, INDEX_FORMAT, Index, IndexedAsset, IndexedLine, IndexedMod, IndexedRelease,
    SkippedRelease, counter_of,
};
use zax_fallout2::manifest::{
    MANIFEST_NAME, ManifestDefaults, ModManifest, parse_indexed_manifest,
    parse_manifest_with_grants, part_options,
};
use zax_fallout2::mod_feed::{ReleaseAsset, sole_archive, sole_executable, version_from_tag};
use zax_fallout2::recommended_order::agreed_order;
use zax_platform::net::DownloadOptions;
use zax_platform::{Error, Platform, Result};

use crate::github::{Github, GithubAsset, GithubRelease};
use crate::source::Source;

/// What the indexer remembers between runs: the hash of every asset it had to hash itself, so an
/// asset is downloaded once, and a stated one, so a replaced asset is noticed.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct State {
    /// Keyed `<repository id>/<tag>/<asset name>`: what a release names an asset by, which a
    /// re-upload under the same name keeps.
    #[serde(default)]
    pub hashes: BTreeMap<String, StoredHash>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct StoredHash {
    pub sha256: String,
    pub size: u64,
}

/// The index and what a maintainer should read about how it was built.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Built {
    pub index: Index,
    pub notes: Vec<String>,
}

/// Builds the index.
///
/// # Errors
///
/// Fails where GitHub cannot be read, where two sources state an order for one game, or where the
/// indexer's own output would not read back as what it read - a defect here, never a release's.
pub fn build(
    platform: &dyn Platform,
    github: &Github<'_>,
    sources: &[Source],
    state: &mut State,
    generated: &str,
    work: &Path,
) -> Result<Built> {
    let mut notes = Vec::new();
    let mut mods = Vec::new();
    for source in sources {
        mods.push(index_mod(
            platform, github, source, state, work, &mut notes,
        )?);
    }
    Ok(Built {
        index: Index {
            format: INDEX_FORMAT,
            generated: generated.to_owned(),
            orders: orders(sources)?,
            mods,
        },
        notes,
    })
}

fn orders(sources: &[Source]) -> Result<BTreeMap<String, Vec<String>>> {
    let mut out: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for source in sources {
        let Some(order) = &source.order else {
            continue;
        };
        if out
            .insert(order.game.clone(), order.entries.clone())
            .is_some()
        {
            return Err(Error::Unsupported(format!(
                "Two sources state the load order for {}; one of them is {}.",
                order.game, source.id
            )));
        }
    }
    // Led by the first edition by name, so the result does not depend on the order files are read in.
    let editions: Vec<Vec<&str>> = out
        .values()
        .map(|entries| entries.iter().map(String::as_str).collect())
        .collect();
    if let Some((lead, rest)) = editions.split_first()
        && !rest.is_empty()
    {
        let rest: Vec<&[&str]> = rest.iter().map(Vec::as_slice).collect();
        let shared: Vec<String> = agreed_order(lead, &rest)
            .into_iter()
            .map(ToOwned::to_owned)
            .collect();
        out.insert("shared".to_owned(), shared);
    }
    Ok(out)
}

fn index_mod(
    platform: &dyn Platform,
    github: &Github<'_>,
    source: &Source,
    state: &mut State,
    work: &Path,
    notes: &mut Vec<String>,
) -> Result<IndexedMod> {
    let repository = github.repository_name(source.repository_id)?;
    if repository != source.repository {
        notes.push(format!(
            "{}: {} is now {repository}; update the source.",
            source.id, source.repository
        ));
    }

    let mut releases: Vec<IndexedRelease> = Vec::new();
    let mut skipped = Vec::new();
    let mut versions: BTreeSet<String> = BTreeSet::new();
    for release in github.releases(&repository)? {
        if release.draft {
            continue;
        }
        // A tag naming no version is not a release for ZAX at all, so it is passed over in silence.
        let Some(tagged) = version_from_tag(&release.tag) else {
            continue;
        };
        if source
            .line
            .as_ref()
            .is_some_and(|line| !line.holds(&tagged))
        {
            continue;
        }
        let context = Context {
            platform,
            github,
            source,
            repository: &repository,
            work,
        };
        match index_release(&context, &release, tagged, state)? {
            Outcome::Indexed(indexed) => {
                // Newest first from GitHub, so the first release of a version is the one kept.
                if versions.insert(indexed.version.clone()) {
                    releases.push(indexed);
                }
            }
            Outcome::OtherMod => {}
            Outcome::Skipped(reason) => skipped.push(SkippedRelease {
                tag: release.tag.clone(),
                reason,
            }),
        }
    }

    releases.sort_by(|a, b| compare_release_versions(source.line.as_ref(), &b.version, &a.version));
    let count = releases.len();
    for (at, release) in releases.iter_mut().enumerate() {
        release.rank = u64::try_from(count - at).unwrap_or(u64::MAX);
    }

    Ok(IndexedMod {
        id: source.id.clone(),
        name: source.name.clone(),
        base: source.base,
        line: source.line.clone(),
        requires: if source.line.is_some() {
            vec!["line".to_owned()]
        } else {
            Vec::new()
        },
        releases,
        skipped,
    })
}

struct Context<'a> {
    platform: &'a dyn Platform,
    github: &'a Github<'a>,
    source: &'a Source,
    repository: &'a str,
    work: &'a Path,
}

enum Outcome {
    Indexed(IndexedRelease),
    /// Another id's release, in a repository two ids share.
    OtherMod,
    Skipped(String),
}

fn release_asset(asset: &GithubAsset) -> ReleaseAsset {
    ReleaseAsset {
        name: asset.name.clone(),
        url: asset.url.clone(),
        digest: asset.digest.clone(),
        size: Some(asset.size),
    }
}

fn index_release(
    context: &Context<'_>,
    release: &GithubRelease,
    tagged: String,
    state: &mut State,
) -> Result<Outcome> {
    let source = context.source;
    let (text, carried) =
        match context
            .github
            .file_at(context.repository, &release.tag, MANIFEST_NAME)?
        {
            Some(text) => (text, false),
            None => match &source.document {
                Some(document) => (document.clone(), true),
                None => {
                    return Ok(Outcome::Skipped(format!(
                        "It publishes no {MANIFEST_NAME} at this tag."
                    )));
                }
            },
        };

    // What the maintainers know sits beside a payload is set aside only for the document they wrote:
    // an author's own manifest names its payload where the release has two.
    let candidates: Vec<ReleaseAsset> = release
        .assets
        .iter()
        .filter(|asset| {
            !carried
                || !source
                    .companions
                    .iter()
                    .any(|ending| asset.name.ends_with(ending.as_str()))
        })
        .map(release_asset)
        .collect();
    let defaults = ManifestDefaults {
        version: Some(tagged),
        archive: sole_archive(&candidates).map(|asset| asset.name.clone()),
    };
    let mut manifest = match parse_manifest_with_grants(text.as_bytes(), &defaults, &source.grants)
    {
        Ok(manifest) => manifest,
        Err(refusal) => {
            return Ok(Outcome::Skipped(format!(
                "Its manifest was refused: {refusal}"
            )));
        }
    };
    if manifest.id != source.id
        || source
            .line
            .as_ref()
            .is_some_and(|line| !line.holds(&manifest.version))
    {
        return Ok(Outcome::OtherMod);
    }

    // Every value the release supplied is written into the document, so ZAX infers nothing.
    let mut explicit: Vec<(&str, String)> = vec![("version", manifest.version.clone())];
    if let Some(archive) = &manifest.archive {
        explicit.push(("archive", archive.clone()));
    }
    if let Some(installer) = manifest.installer.as_mut() {
        if let Some(windows) = installer.windows.as_mut() {
            let Some(name) = windows
                .asset
                .clone()
                .or_else(|| sole_executable(&candidates).map(|asset| asset.name.clone()))
            else {
                return Ok(Outcome::Skipped(
                    "Its Windows installer names no asset, and the release publishes no single \
                     executable."
                        .to_owned(),
                ));
            };
            windows.asset = Some(name.clone());
            explicit.push(("installer.windows.asset", name));
        }
        if let Some(other) = installer.other.as_mut() {
            let Some(name) = other
                .asset
                .clone()
                .or_else(|| sole_archive(&candidates).map(|asset| asset.name.clone()))
            else {
                return Ok(Outcome::Skipped(
                    "Its installer for other systems names no asset, and the release publishes no \
                     single archive."
                        .to_owned(),
                ));
            };
            other.asset = Some(name.clone());
            explicit.push(("installer.other.asset", name));
        }
    }

    let mut assets = Vec::new();
    for name in named_assets(&manifest) {
        let Some(asset) = release.assets.iter().find(|asset| asset.name == name) else {
            return Ok(Outcome::Skipped(format!(
                "Its manifest names {name}, which the release does not publish."
            )));
        };
        let key = format!("{}/{}/{}", source.repository_id, release.tag, asset.name);
        match hash_of(context, &key, asset, state)? {
            Ok(sha256) => assets.push(IndexedAsset {
                name: asset.name.clone(),
                url: asset.url.clone(),
                size: asset.size,
                sha256,
            }),
            Err(reason) => return Ok(Outcome::Skipped(reason)),
        }
    }

    let document = emit_document(&text, &explicit, &source.grants)?;
    // The document ZAX will read has to say exactly what was read here; a difference is this
    // indexer's defect, and publishing it would install something nobody described.
    match parse_indexed_manifest(document.as_bytes()) {
        Ok(reread) if reread == manifest => {}
        Ok(_) => {
            return Err(Error::Unsupported(format!(
                "{} {}: the written manifest reads back differently.",
                source.id, manifest.version
            )));
        }
        Err(refusal) => {
            return Err(Error::Unsupported(format!(
                "{} {}: the written manifest is refused: {refusal}",
                source.id, manifest.version
            )));
        }
    }

    Ok(Outcome::Indexed(IndexedRelease {
        version: manifest.version.clone(),
        rank: 0,
        channel: if release.prerelease {
            Channel::Testing
        } else {
            Channel::Stable
        },
        published: release.published.clone(),
        requires: requires_of(&manifest),
        assets,
        manifest: document,
    }))
}

/// Every asset a manifest names, in the order a reader meets them, each once.
fn named_assets(manifest: &ModManifest) -> Vec<String> {
    let mut out: Vec<String> = manifest.archive.iter().cloned().collect();
    out.extend(
        part_options(manifest)
            .iter()
            .map(|part| part.archive.clone()),
    );
    if let Some(installer) = &manifest.installer {
        out.extend(installer.windows.iter().filter_map(|one| one.asset.clone()));
        out.extend(installer.other.iter().filter_map(|one| one.asset.clone()));
    }
    let mut seen = BTreeSet::new();
    out.retain(|name| seen.insert(name.clone()));
    out
}

/// The features a release needs, derived from what its manifest uses, so no maintainer has to
/// remember to name one.
fn requires_of(manifest: &ModManifest) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(installer) = &manifest.installer {
        if installer.windows.is_some() {
            out.push("base.inno");
        }
        if installer.other.is_some() {
            out.push("base.script");
        }
    }
    if manifest.creates.is_some() {
        out.push("base.creates");
    }
    if manifest.extract_dat.is_some() {
        out.push("extract-dat");
    }
    if manifest.parts.is_some() {
        out.push("parts");
    }
    if !manifest.grants.is_empty() {
        out.push("grants");
    }
    out.into_iter().map(ToOwned::to_owned).collect()
}

/// An asset's SHA-256: the one GitHub states, or the indexer's own of the bytes. The inner error is a
/// reason to skip the release; the outer one fails the build.
fn hash_of(
    context: &Context<'_>,
    key: &str,
    asset: &GithubAsset,
    state: &mut State,
) -> Result<std::result::Result<String, String>> {
    let stated = asset
        .digest
        .as_deref()
        .and_then(|digest| digest.strip_prefix("sha256:"))
        .map(str::to_ascii_lowercase);
    let changed = || {
        Err(format!(
            "{} changed after the release was published; a correction is a new release.",
            asset.name
        ))
    };
    if let Some(held) = state.hashes.get(key) {
        if stated.as_ref().is_some_and(|stated| *stated != held.sha256) || held.size != asset.size {
            return Ok(changed());
        }
        return Ok(Ok(held.sha256.clone()));
    }
    let sha256 = match stated {
        Some(stated) => stated,
        None => {
            let at = context.work.join(&asset.name);
            context
                .platform
                .net()
                .download(&asset.url, &at, &DownloadOptions::default())?;
            let computed = context.platform.hash().sha256(&at)?;
            context.platform.fs().remove(&at)?;
            computed
        }
    };
    state.hashes.insert(
        key.to_owned(),
        StoredHash {
            sha256: sha256.clone(),
            size: asset.size,
        },
    );
    Ok(Ok(sha256))
}

/// The author's document with the values the release supplied written in, emitted as YAML so every
/// scalar the author wrote keeps its spelling.
fn emit_document(text: &str, explicit: &[(&str, String)], grants: &[String]) -> Result<String> {
    let unreadable =
        |why: String| Error::Unsupported(format!("The manifest could not be rewritten: {why}"));
    let mut documents =
        YamlLoader::load_from_str(text).map_err(|err| unreadable(err.to_string()))?;
    let Some(Yaml::Hash(fields)) = documents.first_mut() else {
        return Err(unreadable("it is not a mapping".to_owned()));
    };
    for (key, value) in explicit {
        fields.insert(Yaml::String((*key).to_owned()), Yaml::String(value.clone()));
    }
    if !grants.is_empty() {
        fields.insert(
            Yaml::String("grants".to_owned()),
            Yaml::Array(grants.iter().cloned().map(Yaml::String).collect()),
        );
    }
    let root = Yaml::Hash(fields.clone());
    let mut out = String::new();
    YamlEmitter::new(&mut out)
        .dump(&root)
        .map_err(|err| unreadable(err.to_string()))?;
    out.push('\n');
    Ok(out)
}

/// How two of one mod's versions compare. A line orders by its counter, as ZAX did before the
/// index; otherwise component by component, where a suffix after the numbers marks a version before
/// the bare one, so `2.0-rc1` comes before `2.0` and `1.10-fix` after `1.9`.
fn compare_release_versions(line: Option<&IndexedLine>, a: &str, b: &str) -> Ordering {
    if line.is_some()
        && let (Some(left), Some(right)) = (counter_of(a), counter_of(b))
    {
        return left.cmp(&right);
    }
    let (left, left_rest) = split_version(a);
    let (right, right_rest) = split_version(b);
    for at in 0..left.len().max(right.len()) {
        let one = left.get(at).copied().unwrap_or(0);
        let other = right.get(at).copied().unwrap_or(0);
        if one != other {
            return one.cmp(&other);
        }
    }
    match (left_rest.is_empty(), right_rest.is_empty()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        (false, false) => left_rest.cmp(right_rest),
    }
}

/// The numeric components a version leads with, and whatever follows the last of them.
fn split_version(version: &str) -> (Vec<u64>, &str) {
    let trimmed = version
        .strip_prefix('v')
        .or_else(|| version.strip_prefix('V'))
        .unwrap_or(version);
    let mut numbers = Vec::new();
    let mut at = 0;
    for part in trimmed.split('.') {
        let digits = part.len() - part.trim_start_matches(|c: char| c.is_ascii_digit()).len();
        if digits == 0 {
            return (numbers, &trimmed[at..]);
        }
        numbers.push(part[..digits].parse().unwrap_or(u64::MAX));
        if digits < part.len() {
            return (numbers, &trimmed[at + digits..]);
        }
        at += part.len() + 1;
    }
    (numbers, "")
}

#[cfg(test)]
mod tests;

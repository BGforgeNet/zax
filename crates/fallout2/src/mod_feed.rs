//! Where mods come from, and whether this install can take them.
//!
//! The feed list ships in code, reviewable and changed only by a ZAX release, never fetched from
//! somewhere writable - installing a mod is trusting its publisher, and this list is where that trust
//! is granted. A feed entry names a repository and the mod id it follows; two entries may share a
//! repository and each takes the newest release whose manifest carries its id, which is how parallel
//! release lines interleave in one list.
//!
//! A release describes itself one way: the manifest is read from the repository at the release's tag,
//! which supplies the version, and the payload is the sole archive asset unless the manifest names one.
//! That costs a mod author no build step at all, and a manifest committed at the tag is tied to the
//! release by git rather than by anything ZAX has to check.
//!
//! GitHub allows an unauthenticated address 60 API requests an hour, shared with the update check, so
//! the release listing is cached with a short life and a stale copy answers when the network cannot. A
//! tag's tree does not change once pushed, so the manifest read from one is kept for good.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use serde_json::Value;
use zax_core::install::{GameType, Install};
use zax_core::version::compare_versions;
use zax_platform::fs::FileKind;
use zax_platform::{Error, Platform, Result};

use crate::base_version::{BaseVersion, installed_base_version};
use crate::manifest::ModPart;
use crate::manifest::{
    MANIFEST_NAME, ManifestDefaults, ModInput, ModManifest, ModType, is_mod_version,
    parse_manifest, part_options,
};
use crate::mod_choice::ChoiceGroup;
use crate::mod_created::{created_install_path, no_upgrade_here};
use crate::mod_parts::{CarriedSelection, carry_over, offered_parts};
use crate::mod_vendored::vendored_manifest_for;
use crate::mods::{MODS_DIRECTORY, answers_to_id};
use crate::records::InstallRecord;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModFeed {
    /// `owner/name`, the repository whose releases are read.
    pub repository: &'static str,
    /// The manifest id this entry follows through that repository's releases.
    pub id: &'static str,
    /// What to call the mod before any manifest has been read. A feed that could not answer has no
    /// document to take a name from, and its own id is not a name; where the manifest does arrive, the
    /// author's `name` wins.
    pub name: &'static str,
    /// Whether the mod is the installation rather than something stacked on it. Declared on the row as
    /// well as in the manifest because a feed that failed has no manifest to ask: a base mod that
    /// cannot be read is worth saying so, and a stacking mod whose repository has simply not adopted
    /// the format is not.
    pub base: bool,
    /// Which of the repository's releases this entry follows, where one repository publishes more than
    /// one line. RPU is the only case and needs declaring because its releases cannot say: it ran a
    /// single counter to `v30` and split into `2.3.32` and `2.4.32` at 32, publishing no manifest of
    /// its own for either.
    pub line: Option<ModLine>,
}

/// One of a repository's parallel release lines. `prefix` is what its versions start with, and
/// `counter` marks the line that the pre-split history belongs to - RPU's bare `v30` and everything
/// below it is 2.3's past, and an install that stamps no version at all is that line's to repair
/// rather than the newer line's to take over.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct ModLine {
    pub prefix: &'static str,
    pub counter: bool,
}

/// Whether a version belongs to a line: its own numbering, or the counter the line inherited.
fn held_by_line(line: &ModLine, version: &str) -> bool {
    version.starts_with(line.prefix)
        || (line.counter && !version.is_empty() && version.bytes().all(|b| b.is_ascii_digit()))
}

/// The number a version ends on - 30 for `v30`, 34 for `2.3.34`, 30 for the `2.3.3u30` an install of
/// that era stamps. RPU's counter ran through all three spellings, so it is what orders a line whatever
/// scheme wrote it.
fn counter_of(version: &str) -> Option<u64> {
    let digits = version.len() - version.trim_end_matches(|c: char| c.is_ascii_digit()).len();
    version[version.len() - digits..].parse().ok()
}

/// How two of one row's versions compare. A line orders by its counter, because the schemes either
/// side of RPU's split are not comparable component by component: `30` would read as a major version
/// above `2.4.34`.
#[must_use]
pub fn compare_in_line(line: Option<&ModLine>, a: &str, b: &str) -> Ordering {
    if line.is_none() {
        return compare_versions(a, b);
    }
    match (counter_of(a), counter_of(b)) {
        (Some(left), Some(right)) => left.cmp(&right),
        _ => compare_versions(a, b),
    }
}

/// What reading a repository takes: the releases to list and the id to follow through them. The rest
/// of a row describes the mod where no manifest arrives, which is the listing's business rather than
/// the fetch's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FeedSource {
    pub repository: &'static str,
    pub id: &'static str,
    pub line: Option<ModLine>,
}

impl From<&ModFeed> for FeedSource {
    fn from(feed: &ModFeed) -> Self {
        Self {
            repository: feed.repository,
            id: feed.id,
            line: feed.line,
        }
    }
}

/// Base mods first: what an install is comes before what is stacked on it, and that is the order it is
/// read in.
pub const MOD_FEEDS: &[ModFeed] = &[
    // Two entries over one repository, which is what parallel release lines are: a 2.3 install upgrades
    // within 2.3 and never crosses, so 2.4 is a different mod rather than a branch of this one.
    ModFeed {
        repository: "BGforgeNet/Fallout2_Restoration_Project",
        id: "rpu23",
        name: "RPU 2.3",
        base: true,
        line: Some(ModLine {
            prefix: "2.3.",
            counter: true,
        }),
    },
    ModFeed {
        repository: "BGforgeNet/Fallout2_Restoration_Project",
        id: "rpu24",
        name: "RPU 2.4",
        base: true,
        line: Some(ModLine {
            prefix: "2.4.",
            counter: false,
        }),
    },
    ModFeed {
        repository: "BGforgeNet/Fallout2_Unofficial_Patch",
        id: "upu",
        name: "UPU",
        base: true,
        line: None,
    },
    ModFeed {
        repository: "rotators/Fo1in2",
        id: "fo1in2",
        name: "ET TU",
        base: true,
        line: None,
    },
    ModFeed {
        repository: "BGforgeNet/FO2tweaks",
        id: "fo2tweaks",
        name: "FO2tweaks",
        base: false,
        line: None,
    },
];

/// Which of the two installer routes a host takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "lowercase")]
pub enum InstallerRoute {
    Windows,
    Other,
}

/// A base mod's installer for the platform ZAX is running on, and which of the two routes it is.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct ReleaseInstaller {
    pub route: InstallerRoute,
    pub asset: ReleaseAsset,
}

/// One release as ZAX holds it: the parsed manifest, its exact bytes, and where the payload is.
#[derive(Debug, Clone, PartialEq)]
pub struct ModRelease {
    pub manifest: ModManifest,
    /// The manifest's text as fetched - recorded with the install and pinned by an open transaction.
    pub manifest_text: String,
    /// The payload asset the manifest names, with what the release states about it.
    pub archive: Option<ReleaseAsset>,
    /// A part's asset by part id, for a manifest that declares parts. Only the parts this release
    /// actually publishes are here: a release missing one asset still offers the others, rather than
    /// nothing. Empty for a manifest declaring none.
    pub parts: BTreeMap<String, ReleaseAsset>,
    /// Resolved here rather than at the install so eligibility can say "not for this system" without
    /// downloading anything.
    pub installer: Option<ReleaseInstaller>,
    /// The route this host would take, kept even where its asset did not resolve. Without it a miss
    /// cannot be told from a mod that does not install here at all, and the two send the reader to
    /// different places.
    pub installer_route: Option<InstallerRoute>,
    /// The release line this came from, carried because versions of one line compare on their own
    /// counter and an install stamping another line's version is another mod rather than an older copy
    /// of this one.
    pub line: Option<ModLine>,
}

const FEED_CACHE_MS: i64 = 30 * 60 * 1000;

/// One listing per repository for the length of a read, so rows sharing a repository share its
/// request and its immutable tag-cache entries.
#[derive(Debug, Default)]
pub struct FeedRead {
    releases: HashMap<String, Vec<FeedRelease>>,
}

fn slug(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut pending = false;
    for ch in text.chars() {
        if ch.is_alphanumeric() || ch == '_' || ch == '.' || ch == '-' {
            if pending {
                out.push('-');
                pending = false;
            }
            out.push(ch);
        } else {
            pending = true;
        }
    }
    if pending {
        out.push('-');
    }
    out
}

fn feeds_directory(platform: &dyn Platform) -> PathBuf {
    platform.paths().cache().join("feeds")
}

/// Where a repository's listing is cached, and where one release's manifest is - the base path, which
/// the reader completes with the suffix that says what it found. Public because a host can seed this
/// cache instead of answering the network for it, and it must write the paths the reader reads.
#[must_use]
pub fn feed_cache_path(platform: &dyn Platform, repository: &str, tag: Option<&str>) -> PathBuf {
    let base = feeds_directory(platform).join(slug(repository));
    match tag {
        None => base.with_extension("json"),
        Some(tag) => {
            let mut name = base.into_os_string();
            name.push(format!("-{}", slug(tag)));
            PathBuf::from(name)
        }
    }
}

/// GitHub's release feed for a repository, newest first.
///
/// 100 is the most one request may ask for, and this asks for it rather than taking the default 30: a
/// mod with a long history is normal - the one followed feed passed thirty releases some time ago - and
/// a page that stops short does not say so, it just answers without the releases it left out. Still one
/// request, so a repository past a hundred releases has its oldest lines invisible; the newest version
/// is on the first page either way, and it is a hotfix to an older line that would go unseen.
fn releases_url(repository: &str) -> String {
    format!("https://api.github.com/repos/{repository}/releases?per_page=100")
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct ReleaseAsset {
    pub name: String,
    pub url: String,
    /// GitHub states `sha256:<hex>`; kept verbatim and split where it is checked.
    pub digest: Option<String>,
    pub size: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FeedRelease {
    tag: String,
    assets: Vec<ReleaseAsset>,
}

fn read_releases(body: &str) -> Vec<FeedRelease> {
    let Ok(raw) = serde_json::from_str::<Value>(body) else {
        return Vec::new();
    };
    let Some(entries) = raw.as_array() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries {
        let Some(tag) = entry.get("tag_name").and_then(Value::as_str) else {
            continue;
        };
        let mut assets = Vec::new();
        for asset in entry
            .get("assets")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default()
        {
            let (Some(name), Some(url)) = (
                asset.get("name").and_then(Value::as_str),
                asset.get("browser_download_url").and_then(Value::as_str),
            ) else {
                continue;
            };
            assets.push(ReleaseAsset {
                name: name.to_owned(),
                url: url.to_owned(),
                digest: asset
                    .get("digest")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                size: asset.get("size").and_then(Value::as_u64),
            });
        }
        out.push(FeedRelease {
            tag: tag.to_owned(),
            assets,
        });
    }
    out
}

/// The repository's releases, from the cache while it is fresh, the network when it is not, and the
/// stale cache again when the network refuses - a listing that worked yesterday beats an empty tab
/// today, and the install path re-verifies everything that matters against digests anyway.
fn read_repository_releases(
    platform: &dyn Platform,
    repository: &str,
    now: i64,
) -> Result<Vec<FeedRelease>> {
    let cache_path = feed_cache_path(platform, repository, None);
    let cached = platform.fs().stat(&cache_path)?;
    let held = cached.is_some_and(|stat| stat.kind == FileKind::File);
    if let Some(stat) = cached
        && stat.kind == FileKind::File
        && now - stat.modified < FEED_CACHE_MS
    {
        let body = platform.fs().read(&cache_path)?;
        return Ok(read_releases(&String::from_utf8_lossy(&body)));
    }
    let body = match platform.net().fetch_text(&releases_url(repository)) {
        Ok(body) => body,
        Err(err) => {
            if matches!(err, Error::Network(_)) && held {
                let body = platform.fs().read(&cache_path)?;
                return Ok(read_releases(&String::from_utf8_lossy(&body)));
            }
            return Err(err);
        }
    };
    platform.fs().write(&cache_path, body.as_bytes())?;
    Ok(read_releases(&body))
}

/// Shares a repository listing between rows for the length of one read.
fn fetch_releases(
    platform: &dyn Platform,
    repository: &str,
    now: i64,
    read: &mut FeedRead,
) -> Result<Vec<FeedRelease>> {
    if let Some(held) = read.releases.get(repository) {
        return Ok(held.clone());
    }
    let listed = read_repository_releases(platform, repository, now)?;
    read.releases.insert(repository.to_owned(), listed.clone());
    Ok(listed)
}

/// The manifest as committed, at the tag the release names - the route that costs an author no build
/// step.
fn repository_manifest_url(repository: &str, tag: &str) -> String {
    format!("https://raw.githubusercontent.com/{repository}/{tag}/{MANIFEST_NAME}")
}

/// Payload assets ZAX can open. Anything else on a release - checksums, signatures, notes - is not a
/// payload.
const ARCHIVE_SUFFIXES: &[&str] = &[".zip", ".7z", ".rar", ".tar.gz", ".tgz", ".tar"];

/// Whether an asset is one 7-Zip opens. A payload that is not is a single file, deployed as it stands.
#[must_use]
pub fn is_archive_name(name: &str) -> bool {
    let name = name.to_lowercase();
    ARCHIVE_SUFFIXES.iter().any(|end| name.ends_with(end))
}

/// The payload when the manifest does not name one: a release's sole archive-shaped asset. Two of them
/// is an ambiguity only the author can settle, so the manifest's `archive` stays in the format for that
/// case - and so does a release of loose files, where nothing distinguishes the payload from anything
/// else published.
fn sole(assets: &[ReleaseAsset], wanted: impl Fn(&str) -> bool) -> Option<&ReleaseAsset> {
    let mut matching = assets.iter().filter(|asset| wanted(&asset.name));
    let first = matching.next()?;
    matching.next().is_none().then_some(first)
}

fn sole_archive(assets: &[ReleaseAsset]) -> Option<&ReleaseAsset> {
    sole(assets, is_archive_name)
}

/// The Windows installer when the manifest does not name one, under the same rule as the payload: a
/// release's sole executable. Matched on the shape rather than on `built-with`, which would be a table
/// with one row - and a toolkit this version does not know refuses at parse, so the guess never reaches
/// an unknown one.
fn sole_executable(assets: &[ReleaseAsset]) -> Option<&ReleaseAsset> {
    sole(assets, |name| name.to_lowercase().ends_with(".exe"))
}

/// Which route a host takes. Both exist because upstream publishes both, and a host is on one or the
/// other.
fn route_for(platform: &dyn Platform) -> InstallerRoute {
    if platform.os() == zax_platform::OperatingSystem::Windows {
        InstallerRoute::Windows
    } else {
        InstallerRoute::Other
    }
}

/// What the manifest declares for a route: whether it declares one at all, and the asset it names.
fn declared_installer(manifest: &ModManifest, route: InstallerRoute) -> Option<Option<&str>> {
    let installer = manifest.installer.as_ref()?;
    match route {
        InstallerRoute::Windows => installer.windows.as_ref().map(|one| one.asset.as_deref()),
        InstallerRoute::Other => installer.other.as_ref().map(|one| one.asset.as_deref()),
    }
}

/// A tag's version: `v14.7` is 14.7. A tag shaped like anything else names no version and is passed
/// over.
fn version_from_tag(tag: &str) -> Option<String> {
    let version = tag
        .strip_prefix('v')
        .or_else(|| tag.strip_prefix('V'))
        .unwrap_or(tag);
    is_mod_version(version).then(|| version.to_owned())
}

/// A release's manifest, fetched once - a tag's tree does not change once pushed. Its absence is kept
/// too: a repository that ships none would otherwise cost one request per release on every listing
/// refresh. Where the repository has none, ZAX's own copy answers for the mods that have one.
fn fetch_manifest_text(
    platform: &dyn Platform,
    feed: &FeedSource,
    release: &FeedRelease,
    version: Option<&str>,
) -> Result<Option<String>> {
    let base = feed_cache_path(platform, feed.repository, Some(&release.tag));
    let kept = with_suffix(&base, ".yml");
    if platform.fs().stat(&kept)?.map(|stat| stat.kind) == Some(FileKind::File) {
        let held = platform.fs().read(&kept)?;
        return Ok(Some(String::from_utf8_lossy(&held).into_owned()));
    }

    // ZAX's own copy, for a mod that describes itself nowhere. Last rather than first: wherever the
    // author has said anything, their word is the description, so adopting the format takes effect by
    // publishing rather than by ZAX noticing. A tag naming no version gets no copy, a vendored document
    // stating none of its own.
    let fallback = version.and_then(|_| vendored_manifest_for(feed.id));

    let missing = with_suffix(&base, ".none");
    if platform.fs().stat(&missing)?.map(|stat| stat.kind) == Some(FileKind::File) {
        return Ok(fallback.map(str::to_owned));
    }

    let text = match platform
        .net()
        .fetch_text(&repository_manifest_url(feed.repository, &release.tag))
    {
        Ok(text) => text,
        // A tag with no manifest is a release that is not for ZAX, not a broken feed - every other
        // failure is, ZAX carrying a copy or not: offering from a copy while the network is down would
        // offer an install that cannot be downloaded, and would hide an author's own manifest behind
        // ZAX's guess at the same time.
        Err(Error::Network(failure)) if failure.status == Some(404) => {
            platform.fs().write(&missing, &[])?;
            return Ok(fallback.map(str::to_owned));
        }
        Err(err) => return Err(err),
    };
    platform.fs().write(&kept, text.as_bytes())?;
    Ok(Some(text))
}

/// The cache path with a suffix appended to the whole name, rather than replacing an extension the
/// tag's own text may have put there.
fn with_suffix(base: &Path, suffix: &str) -> PathBuf {
    let mut name = base.to_path_buf().into_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

/// Which of a base manifest's routes this host takes, and the asset it resolves to - or nothing for a
/// miss.
fn installer_for(
    route: InstallerRoute,
    manifest: &ModManifest,
    assets: &[ReleaseAsset],
) -> Option<ReleaseInstaller> {
    let declared = declared_installer(manifest, route)?;
    // Named wins over inferred, as the manifest's own version wins over the tag's: what the file says
    // is the author's claim, and the shape below is ZAX reading the release for an author who made none.
    let asset = match declared {
        Some(named) => assets.iter().find(|entry| entry.name == named),
        None => match route {
            InstallerRoute::Windows => sole_executable(assets),
            InstallerRoute::Other => sole_archive(assets),
        },
    }?;
    Some(ReleaseInstaller {
        route,
        asset: asset.clone(),
    })
}

/// Why there is no installer to run here, told apart by what the manifest declares. A mod with no route
/// for this platform does not install here at all; a route whose asset is missing from the release is
/// the author's mistake, not the user's system. One message for both sends half its readers to look in
/// the wrong place.
#[must_use]
pub fn installer_miss(manifest: &ModManifest, route: Option<InstallerRoute>) -> String {
    let Some(declared) = route.and_then(|route| declared_installer(manifest, route)) else {
        return format!("{} does not install on this system.", manifest.name);
    };
    let what = match route {
        Some(InstallerRoute::Windows) => "Windows installer",
        _ => "installer for this system",
    };
    if let Some(named) = declared {
        return format!(
            "{} names \"{named}\" as its {what}, which this release does not publish.",
            manifest.name
        );
    }
    let shape = match route {
        Some(InstallerRoute::Windows) => "executable",
        _ => "archive",
    };
    format!(
        "{}'s {what} names no asset, and this release publishes no single {shape} to take as one.",
        manifest.name
    )
}

/// The releases worth asking about. Every one of them, normally: what a release says about itself is
/// knowable only by asking it. For a row ZAX carries a document for, a release that cannot win is not
/// worth a request - the carried document states no version, so such a release's version is its tag's,
/// and only the highest of those can win.
///
/// This is what keeps a first listing from costing one 404 per release across a repository's whole
/// history.
fn worth_asking(feed: &FeedSource, releases: Vec<FeedRelease>) -> Vec<FeedRelease> {
    // A line's releases are the only ones this entry follows, whatever else the repository publishes -
    // and the filter comes first, so the highest below is the highest of this line rather than of both.
    let mine: Vec<FeedRelease> = match &feed.line {
        None => releases,
        Some(line) => releases
            .into_iter()
            .filter(|release| {
                version_from_tag(&release.tag).is_some_and(|tagged| held_by_line(line, &tagged))
            })
            .collect(),
    };
    if vendored_manifest_for(feed.id).is_none() {
        return mine;
    }
    let mut highest: Option<String> = None;
    for release in &mine {
        let Some(tagged) = version_from_tag(&release.tag) else {
            continue;
        };
        let better = highest.as_ref().is_none_or(|held| {
            compare_in_line(feed.line.as_ref(), &tagged, held) == Ordering::Greater
        });
        if better {
            highest = Some(tagged);
        }
    }
    // Guarded rather than compared straight: with no version-shaped tag anywhere, `highest` is nothing
    // and every tag that names no version would match it.
    let Some(highest) = highest else {
        return Vec::new();
    };
    mine.into_iter()
        .filter(|release| version_from_tag(&release.tag).as_deref() == Some(highest.as_str()))
        .collect()
}

/// What a walk over a repository's releases learned besides the release it picked: whether any manifest
/// was reachable at all, and the first one that would not parse. Both go into the message when nothing
/// wins, where "this needs a newer ZAX" is truer than "nothing found".
#[derive(Debug, Default)]
struct FeedNotes {
    saw_manifest: bool,
    first_refusal: Option<String>,
}

/// One release read as this feed's mod, or nothing where it is not one - another id, another line, or
/// no manifest at all. Shared by the walk that picks the current release and by the fetch of a version
/// the user named, so an older release is assembled exactly as the newest one is.
fn release_from(
    platform: &dyn Platform,
    feed: &FeedSource,
    release: &FeedRelease,
    notes: &mut FeedNotes,
) -> Result<Option<ModRelease>> {
    let tagged = version_from_tag(&release.tag);
    let Some(text) = fetch_manifest_text(platform, feed, release, tagged.as_deref())? else {
        return Ok(None);
    };
    notes.saw_manifest = true;
    let inferred = sole_archive(&release.assets);
    let manifest = match parse_manifest(
        text.as_bytes(),
        &ManifestDefaults {
            version: tagged,
            archive: inferred.map(|asset| asset.name.clone()),
        },
    ) {
        Ok(manifest) => manifest,
        Err(refusal) => {
            notes
                .first_refusal
                .get_or_insert_with(|| refusal.to_string());
            return Ok(None);
        }
    };
    if manifest.id != feed.id {
        return Ok(None);
    }
    // A line is a stretch of the numbering, so a document is this row's only if its version falls in
    // it - the tag filter cannot answer for a release whose own document states the version.
    if feed
        .line
        .as_ref()
        .is_some_and(|line| !held_by_line(line, &manifest.version))
    {
        return Ok(None);
    }
    let archive = manifest.archive.as_ref().and_then(|named| {
        release
            .assets
            .iter()
            .find(|asset| asset.name == *named)
            .cloned()
    });
    let mut parts = BTreeMap::new();
    for part in part_options(&manifest) {
        if let Some(asset) = release
            .assets
            .iter()
            .find(|entry| entry.name == part.archive)
        {
            parts.insert(part.id.clone(), asset.clone());
        }
    }
    let route = route_for(platform);
    let installer = installer_for(route, &manifest, &release.assets);
    let installer_route = declared_installer(&manifest, route).map(|_| route);
    Ok(Some(ModRelease {
        manifest_text: text,
        line: feed.line,
        archive,
        parts,
        installer,
        installer_route,
        manifest,
    }))
}

/// Every version this row's releases name, newest first. Read from the listing already cached for the
/// current release, so putting a choice in front of the user costs no request of its own. These are
/// what the tags say: a release stating its own version in a document it publishes could name another,
/// which the fetch then finds.
///
/// # Errors
///
/// Fails where the repository's listing cannot be read.
pub fn list_mod_versions(
    platform: &dyn Platform,
    feed: &FeedSource,
    now: i64,
) -> Result<Vec<String>> {
    let mut read = FeedRead::default();
    let mut seen: Vec<String> = Vec::new();
    for release in fetch_releases(platform, feed.repository, now, &mut read)? {
        let Some(tagged) = version_from_tag(&release.tag) else {
            continue;
        };
        if feed
            .line
            .as_ref()
            .is_some_and(|line| !held_by_line(line, &tagged))
        {
            continue;
        }
        if !seen.contains(&tagged) {
            seen.push(tagged);
        }
    }
    seen.sort_by(|a, b| compare_in_line(feed.line.as_ref(), b, a));
    Ok(seen)
}

/// The release naming one particular version, for installing something other than the newest. The whole
/// listing is searched rather than the shortlist `worth_asking` keeps: that one exists to avoid asking
/// about releases which cannot win, and a version the user named has already won.
///
/// # Errors
///
/// Fails where the listing cannot be read, where a manifest refused to parse and nothing else matched,
/// or where no release publishes that version.
pub fn fetch_feed_at(
    platform: &dyn Platform,
    feed: &FeedSource,
    version: &str,
    now: i64,
) -> Result<ModRelease> {
    let mut read = FeedRead::default();
    let mut notes = FeedNotes::default();
    for release in fetch_releases(platform, feed.repository, now, &mut read)? {
        if version_from_tag(&release.tag).as_deref() != Some(version) {
            continue;
        }
        if let Some(built) = release_from(platform, feed, &release, &mut notes)? {
            return Ok(built);
        }
    }
    Err(refusal_from(&notes).unwrap_or_else(|| {
        Error::Unsupported(format!(
            "No release of {} publishes \"{}\" {version}.",
            feed.repository, feed.id
        ))
    }))
}

fn refusal_from(notes: &FeedNotes) -> Option<Error> {
    notes
        .first_refusal
        .as_ref()
        .map(|why| Error::Unsupported(why.clone()))
}

fn fetch_feed_using(
    platform: &dyn Platform,
    feed: &FeedSource,
    now: i64,
    read: &mut FeedRead,
) -> Result<ModRelease> {
    let releases = worth_asking(feed, fetch_releases(platform, feed.repository, now, read)?);
    let mut notes = FeedNotes::default();
    let mut best: Option<ModRelease> = None;

    for release in &releases {
        let Some(built) = release_from(platform, feed, release, &mut notes)? else {
            continue;
        };
        // Strictly higher, so a version published twice keeps its newest release's assets.
        let better = best.as_ref().is_none_or(|held| {
            compare_in_line(
                feed.line.as_ref(),
                &built.manifest.version,
                &held.manifest.version,
            ) == Ordering::Greater
        });
        if better {
            best = Some(built);
        }
    }

    if let Some(best) = best {
        return Ok(best);
    }
    Err(refusal_from(&notes).unwrap_or_else(|| {
        Error::Unsupported(if notes.saw_manifest {
            format!(
                "No release of {} carries a manifest for \"{}\".",
                feed.repository, feed.id
            )
        } else {
            format!(
                "No release of {} ships a ZAX manifest yet.",
                feed.repository
            )
        })
    }))
}

/// The current release of a feed's mod: of every release whose manifest carries the followed id, the
/// one with the highest manifest version - release order alone would let a hotfix backported to an
/// older line shadow the current one.
///
/// # Errors
///
/// Fails where the listing cannot be read, or where no release of the repository answers for this id.
pub fn fetch_feed(platform: &dyn Platform, feed: &FeedSource, now: i64) -> Result<ModRelease> {
    fetch_feed_using(platform, feed, now, &mut FeedRead::default())
}

/// What the interface offers for one mod on one install, decided from what is already known.
///
/// Tagged with the kind, which is the field every surface branches on, and spelled the way the
/// interface reads it: `install-over` rather than `installOver`, as the TypeScript named them.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Availability {
    Install,
    /// Present without a record - hand-installed - so the offer is the latest release laid over it.
    InstallOver,
    /// A build from between releases, named by the commit it was built from - see `base_version`.
    Nightly {
        commit: String,
    },
    Installed,
    Upgrade {
        from: String,
    },
    /// Recorded at one type and offered at another. The version rises, but what the install *is*
    /// changes with it - a mod taking its own removability away, and later a stacking mod becoming a
    /// base one - so the offer names the change instead of calling it an update. `was` is what is on
    /// disk, which is what decides whether it can still be removed.
    Convert {
        from: String,
        was: ModType,
    },
    /// A feed answering with an older version than the record - what a rolled-back feed looks like.
    Downgrade {
        from: String,
    },
    /// An install that never finished; the working directory decides between resume and restore.
    Retry {
        version: String,
    },
    /// Recorded as installed while no known feed follows the id - still removable, never updatable.
    Unfollowed,
    /// ZAX refuses this release. `from` is what the record says is installed, which several of these
    /// arms sit in front of - the sfall gate answers before the version comparison, so a refused row is
    /// often an installed mod. Absent where nothing is installed, or where the refusal is the install
    /// type and no version applies.
    Blocked {
        why: String,
        from: Option<String>,
    },
}

#[derive(Debug, Clone)]
pub struct ModContext<'a> {
    pub install: &'a Install,
    pub record: &'a InstallRecord,
    /// The installed sfall version, or nothing when the install has none.
    pub sfall: Option<&'a str>,
    /// Whether anything under `mods/` answers to the mod's name - the hand-installed case.
    pub present: bool,
    /// What a base install says about itself in `ddraw.ini`, where ZAX has no record of installing it.
    /// This is the common state rather than an edge: upstream's Windows route is an exe installer, so
    /// most base installs were never ZAX's, and without this they are a game type with no version and
    /// no update on offer. The outer `None` is "nothing read it"; the inner one is "read, and it stamps
    /// nothing".
    pub base_version: Option<Option<BaseVersion>>,
}

/// Whether a lined base mod is this installation's to offer: its own line's stamp, or - for the line
/// the pre-split history belongs to - an installation stating no version at all, which no later line
/// ever wrote.
fn offered_on_line(line: &ModLine, held: Option<&BaseVersion>) -> bool {
    match held {
        Some(BaseVersion::Release { version }) => held_by_line(line, version),
        _ => line.counter,
    }
}

/// A refusal that carries the installed version along with it; `blocked_by_type` has none to carry.
fn refuse(why: String, from: Option<String>) -> Availability {
    Availability::Blocked { why, from }
}

#[must_use]
#[expect(
    clippy::too_many_lines,
    reason = "one decision with many arms, each a sentence about what the install already holds; \
              splitting it would put the order the arms answer in out of one reader's sight"
)]
pub fn availability(release: &ModRelease, context: &ModContext<'_>) -> Availability {
    let manifest = &release.manifest;
    let held = context.record.mods.iter().find(|one| one.id == manifest.id);
    // A created install the user deleted by hand is gone, whatever the record says - and deleting that
    // folder is exactly what ZAX tells them to do, since it will not remove one itself. The directory
    // decides, and a record describing a folder that is not there would otherwise report it installed
    // for good.
    let recorded = if manifest.creates.is_some() && !context.present {
        None
    } else {
        held
    };

    if let Some(recorded) = recorded
        && !recorded.complete
    {
        return Availability::Retry {
            version: recorded.version.clone(),
        };
    }

    // The sfall requirement is the new release's and binds upgrades too; the updater answers it either
    // way.
    if let Some(wanted) = &manifest.requires_sfall {
        let behind = context
            .sfall
            .is_none_or(|have| compare_versions(have, wanted) == Ordering::Less);
        if behind {
            let has = context.sfall.unwrap_or("none");
            return refuse(
                format!(
                    "{} needs sfall {wanted} or newer - this install has {has}. ZAX's sfall updater \
                     can raise it first.",
                    manifest.name
                ),
                recorded.map(|one| one.version.clone()),
            );
        }
    }

    if let Some(recorded) = recorded {
        match compare_versions(&manifest.version, &recorded.version) {
            Ordering::Less => {
                return Availability::Downgrade {
                    from: recorded.version.clone(),
                };
            }
            Ordering::Equal => return Availability::Installed,
            Ordering::Greater => {}
        }
    }

    // A mod that creates an install answers from the created directory's own stamp, and it answers
    // here - before the offers below - so an install already at this version reads as installed even on
    // a host where a later step could not run.
    if manifest.creates.is_some()
        && let Some(Some(BaseVersion::Release { version })) = &context.base_version
    {
        // Straight version comparison, with no line to cross: lines are a property of RPU's release
        // lines, and a mod that creates an install publishes one sequence.
        match compare_versions(&manifest.version, version) {
            Ordering::Equal => return Availability::Installed,
            Ordering::Less => {
                return Availability::Downgrade {
                    from: version.clone(),
                };
            }
            Ordering::Greater => {}
        }
    }

    // An install this mod made is installed once. Every arm above answers where the version on disk is
    // this release's or newer; anything else would be laying a release over a whole game, and there is
    // no such operation to offer - upstream publishes an unpack into a folder that has none and nothing
    // else, and doing it anyway would overwrite the mod's own configuration and load order with the
    // release's defaults.
    //
    // Any of the three is that install being there: a record of it, a version stamped in it, or the
    // directory itself. A reading that found no stamp is not the second.
    if manifest.creates.is_some()
        && (recorded.is_some() || matches!(context.base_version, Some(Some(_))) || context.present)
    {
        let stamped = match &context.base_version {
            Some(Some(BaseVersion::Release { version })) => Some(version.clone()),
            _ => None,
        };
        return refuse(
            no_upgrade_here(manifest, context.install.game_type),
            recorded.map(|one| one.version.clone()).or(stamped),
        );
    }

    // Everything from here on is an offer to download, which a release that never names its payload
    // cannot make. For a parts release the payload is whatever parts resolved: one asset short is not
    // nothing to install.
    if manifest.creates.is_some() {
        // Its payload is an ordinary archive, so the archive check below is the one that applies - said
        // here because the installer arm is the other kind of base mod's and does not fit this one.
        if release.archive.is_none() {
            return refuse(
                format!(
                    "The {} release does not say which of its files is the mod.",
                    manifest.name
                ),
                recorded.map(|one| one.version.clone()),
            );
        }
    } else if manifest.mod_type == ModType::Base {
        // A base mod's payload is its installer, and a release that publishes one for another system is
        // not a release that named nothing - the mod is real and this machine cannot run it, which is
        // what it says.
        if release.installer.is_none() {
            return refuse(
                installer_miss(manifest, release.installer_route),
                recorded.map(|one| one.version.clone()),
            );
        }
    } else if release.archive.is_none() && offered_parts(release).is_empty() {
        return refuse(
            if manifest.parts.is_some() {
                format!(
                    "The {} release publishes none of the files its parts name.",
                    manifest.name
                )
            } else {
                format!(
                    "The {} release does not say which of its files is the mod.",
                    manifest.name
                )
            },
            recorded.map(|one| one.version.clone()),
        );
    }

    if let Some(recorded) = recorded {
        // A record written before the type was kept carries none, and unknown is not a change.
        if let Some(was) = recorded.mod_type
            && was != manifest.mod_type
        {
            return Availability::Convert {
                from: recorded.version.clone(),
                was,
            };
        }
        return Availability::Upgrade {
            from: recorded.version.clone(),
        };
    }

    // A mod that creates an install has nowhere to put one here, or the arm above would have refused
    // it: what is left is a first install, on a host of a type the manifest allows.
    if manifest.creates.is_some() {
        return blocked_by_type(manifest, context).unwrap_or(Availability::Install);
    }

    // Presence always comes from the directory. For a base mod that means the type the directory
    // reports and nothing else - a hand-installed RPU is the common state, and this arm is both its
    // upgrade path and its repair. A file in `mods/` answering to the mod's id is somebody else's dat
    // with a similar name, and reading it as "already installed" would walk past the gate that keeps a
    // base mod off a changed game.
    if manifest.mod_type == ModType::Base {
        if Some(context.install.game_type) != manifest.becomes {
            return blocked_by_type(manifest, context).unwrap_or(Availability::Install);
        }
        let held = context.base_version.as_ref().and_then(Option::as_ref);
        // A nightly stamps the commit it was built from where a release stamps its number, so nothing
        // here can order it against what the feed offers - and a build from after the last release is
        // the common case. Reported as what it is rather than as an install with no version, which is
        // what it was read as.
        if let Some(BaseVersion::Nightly { commit }) = held {
            return Availability::Nightly {
                commit: commit.clone(),
            };
        }
        // What the install stamped into `ddraw.ini` stands in for the record it has not got. Where the
        // mod is published in parallel lines that stamp also says WHICH of them is here, and only one
        // base mod fits an installation: another line's version is that other mod already installed,
        // refused in the same sentence as any other base mod meeting an installation it does not
        // install on.
        if let Some(line) = &release.line
            && !offered_on_line(line, held)
        {
            return blocked_by_type(manifest, context).unwrap_or(Availability::InstallOver);
        }
        if let Some(BaseVersion::Release { version }) = held {
            return match compare_in_line(release.line.as_ref(), &manifest.version, version) {
                Ordering::Equal => Availability::Installed,
                Ordering::Greater => Availability::Upgrade {
                    from: version.clone(),
                },
                Ordering::Less => Availability::Downgrade {
                    from: version.clone(),
                },
            };
        }
        return Availability::InstallOver;
    }
    if context.present {
        return Availability::InstallOver;
    }

    // The game-type gate protects a first install alone - install-over and upgrades are the same mod
    // already.
    blocked_by_type(manifest, context).unwrap_or(Availability::Install)
}

/// The game-type gate: what a mod says it installs on, against what this install is.
fn blocked_by_type(manifest: &ModManifest, context: &ModContext<'_>) -> Option<Availability> {
    let allowed = manifest.install_on.as_ref()?;
    if allowed.contains(&context.install.game_type) {
        return None;
    }
    let wanted: Vec<&str> = allowed.iter().map(|one| one.name()).collect();
    Some(Availability::Blocked {
        why: format!(
            "{} installs on {} - this install is {}.",
            manifest.name,
            wanted.join(" or "),
            context.install.game_type.name()
        ),
        from: None,
    })
}

/// Whether the mod is already in the install's `mods/`.
///
/// A release that declares its `entries` is judged against those, which is the only thing that answers
/// for a payload whose filename an id cannot reach: an id carries no underscore and most of these
/// filenames do, so `cassidy_head.dat` matches no id that could be minted for it. Without a declaration
/// the id's own convention stands - `<id>` or `<id>.*`, file or folder alike - which is what every
/// manifest written before the field relied on.
///
/// # Errors
///
/// Fails where the mods folder is there but cannot be listed.
pub fn present_in_mods(
    platform: &dyn Platform,
    install_path: &str,
    id: &str,
    entries: &[String],
) -> Result<bool> {
    let directory = Path::new(install_path).join(MODS_DIRECTORY);
    if platform.fs().stat(&directory)?.map(|stat| stat.kind) != Some(FileKind::Dir) {
        return Ok(false);
    }
    let held = platform.fs().list(&directory)?;
    // A declared entry may be nested - `patches/extra.dat` - and only its first piece is a name the mods
    // folder itself lists. Matching on that over-reports where the folder exists without its dat, which
    // is the harmless direction: it offers the release laid over what is there rather than beside it.
    if !entries.is_empty() {
        return Ok(entries.iter().any(|entry| {
            let top = entry.split('/').next().unwrap_or(entry).to_lowercase();
            held.iter().any(|found| found.name.to_lowercase() == top)
        }));
    }
    Ok(held.iter().any(|entry| answers_to_id(&entry.name, id)))
}

/// One mod as the interface lists it, everything plain enough to cross the process boundary.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct ModOffer {
    pub id: String,
    pub name: String,
    pub version: String,
    pub mod_type: ModType,
    /// What the release says about itself. The pages are flags: the interface asks for one by name.
    pub author: Option<String>,
    pub description: Option<String>,
    pub forum: bool,
    pub homepage: bool,
    /// A permanent mod's declared reason, standing where the Remove control would be.
    pub reason: Option<String>,
    /// What a base mod turns this install into, which is the thing worth knowing before installing one.
    pub becomes: Option<GameType>,
    /// The directory a creating mod makes inside this install, where it makes one.
    pub creates: Option<String>,
    /// What the user must be asked for before this can be installed, so the interface reads no manifest.
    pub asks: Vec<ModInput>,
    /// The choice to make before installing this release, and where this install stands in it.
    pub choices: Option<ChoiceOffer>,
    /// Set on a row the record alone describes, where no feed follows the mod: `version` is then what is
    /// on disk rather than what is offered. Both readings otherwise have the same shape, and a retry row
    /// arrives either way, so nothing downstream could tell an offered version from an installed one
    /// without this.
    pub no_feed: bool,
    pub availability: Availability,
}

/// Everything the interface needs to draw a choice it cannot compute: the renderer reads no manifest.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct ChoiceOffer {
    /// The groups this release can deliver, in the order the manifest declares them.
    pub groups: Vec<ChoiceGroup<ModPart>>,
    pub carried: CarriedSelection,
}

/// A feed that could not answer, and why.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct FeedFailure {
    pub repository: String,
    pub id: String,
    pub name: String,
    pub why: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct ModListing {
    pub offers: Vec<ModOffer>,
    /// Feeds that could not answer, each with why - offline, no manifest yet, needs a newer ZAX. Base
    /// mods only: a stacking mod nobody can read is not news, and four such rows would bury the mods
    /// that did answer.
    pub failures: Vec<FeedFailure>,
}

/// What one feed has published, with nothing of any install in it - a repository publishes one release,
/// whichever game folder is on screen. This is the half of an offer that survives a change of game.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct PublishedMod {
    pub id: String,
    pub name: String,
    pub version: String,
    pub mod_type: ModType,
    /// What the release says about itself, for the row offering it. Absent where the manifest says
    /// nothing.
    pub author: Option<String>,
    pub description: Option<String>,
    /// Whether the mod publishes each page, rather than where: the address is the backend's to resolve.
    pub forum: bool,
    pub homepage: bool,
    pub reason: Option<String>,
    pub becomes: Option<GameType>,
    pub creates: Option<String>,
    pub asks: Vec<ModInput>,
    /// The choice this release offers, without an install's answer to it. Empty where it offers none.
    pub choice: Vec<ChoiceGroup<ModPart>>,
}

/// Every feed's current release, and the feeds that could not answer. Read once, not once per install.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct ModFeedListing {
    pub published: Vec<PublishedMod>,
    pub failures: Vec<FeedFailure>,
}

/// Where one install stands against the published mods, which is everything a change of game
/// invalidates.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct ModInstallState {
    /// By mod id, for the published mods this install could say something about.
    pub standing: BTreeMap<String, Standing>,
    /// Rows only this install's record knows about, complete as they are drawn - no feed describes them.
    pub unfollowed: Vec<ModOffer>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct Standing {
    pub availability: Availability,
    pub carried: CarriedSelection,
}

/// The per-app half of an offer: what the release says about itself, before any folder is considered.
fn published_from(release: &ModRelease) -> PublishedMod {
    let manifest = &release.manifest;
    PublishedMod {
        id: manifest.id.clone(),
        name: manifest.name.clone(),
        version: manifest.version.clone(),
        mod_type: manifest.mod_type,
        author: manifest.author.clone(),
        description: manifest.description.clone(),
        forum: manifest.forum.is_some(),
        homepage: manifest.homepage.is_some(),
        reason: manifest.reason.clone(),
        becomes: manifest.becomes,
        creates: manifest
            .creates
            .as_ref()
            .map(|creates| creates.directory.clone()),
        asks: manifest.inputs.clone().unwrap_or_default(),
        choice: offered_parts(release),
    }
}

/// Every feed's current release. A feed that cannot answer costs its own row, not the listing: the
/// other mods are still installable while one repository is unreachable or unadopted. The releases come
/// back beside the listing because deciding where a mod stands needs the whole release, and only this
/// reads the feeds.
#[must_use]
pub fn read_mod_feeds(platform: &dyn Platform, now: i64) -> (ModFeedListing, Vec<ModRelease>) {
    // One reader for the whole pass, so rows sharing a repository share its listing and its immutable
    // tag-cache entries.
    let mut read = FeedRead::default();
    let mut published = Vec::new();
    let mut releases = Vec::new();
    let mut failures = Vec::new();
    for feed in MOD_FEEDS {
        match fetch_feed_using(platform, &FeedSource::from(feed), now, &mut read) {
            Ok(release) => {
                published.push(published_from(&release));
                releases.push(release);
            }
            // Only a base mod earns a row here: that one is the whole installation, so a user who
            // cannot get it needs to know why. A stacking mod that is unreachable or has not adopted
            // the format offers the same sentence about a repository they never asked after.
            Err(err) if feed.base => failures.push(FeedFailure {
                repository: feed.repository.to_owned(),
                id: feed.id.to_owned(),
                name: feed.name.to_owned(),
                why: err.to_string(),
            }),
            Err(_) => {}
        }
    }
    (
        ModFeedListing {
            published,
            failures,
        },
        releases,
    )
}

/// Where one install stands against releases already read. Everything here reads the game folder or the
/// install's own record, which is why it is asked again for each install and the feeds above are not.
///
/// # Errors
///
/// Fails where the game folder cannot be read.
pub fn read_mod_install_state(
    platform: &dyn Platform,
    releases: &[ModRelease],
    install: &Install,
    record: &InstallRecord,
    sfall: Option<&str>,
) -> Result<ModInstallState> {
    let mut standing = BTreeMap::new();
    for release in releases {
        let manifest = &release.manifest;
        // A parts mod declares nothing at the top level, so presence is judged against every part's
        // entries: any one of them in the folder is the mod being there. A mod that creates an install
        // is not in the mods folder at all: what answers for it is the directory it makes - or this
        // installation, where that is already what this one is.
        let created = manifest.creates.as_ref().map(|creates| {
            created_install_path(
                Path::new(&install.path),
                install.game_type,
                manifest.becomes,
                &creates.directory,
            )
        });
        let declared: Vec<String> = manifest.entries.clone().unwrap_or_else(|| {
            part_options(manifest)
                .into_iter()
                .flat_map(|part| part.entries.clone().unwrap_or_default())
                .collect()
        });
        let present = match &created {
            None => present_in_mods(platform, &install.path, &manifest.id, &declared)?,
            Some(at) => platform.fs().stat(at)?.map(|stat| stat.kind) == Some(FileKind::Dir),
        };
        // Read only for a base mod, and only where it could answer: a stacking mod's version is the
        // record's. A created install stamps its own copy, one directory in, which is where this reads
        // it.
        let base_version = if manifest.mod_type == ModType::Base {
            let root = created
                .clone()
                .unwrap_or_else(|| PathBuf::from(&install.path));
            Some(installed_base_version(platform, &root)?)
        } else {
            None
        };
        let recorded = record.mods.iter().find(|one| one.id == manifest.id);
        let carried = carry_over(release, recorded.map(|one| one.parts.as_slice()));
        standing.insert(
            manifest.id.clone(),
            Standing {
                availability: availability(
                    release,
                    &ModContext {
                        install,
                        record,
                        sfall,
                        present,
                        base_version,
                    },
                ),
                carried,
            },
        );
    }

    // Recorded but followed by no feed: an id retired from the list, or renamed upstream. The row is
    // what keeps Remove reachable - the tab is otherwise feed-driven, and such a mod would be installed
    // yet invisible.
    //
    // Taken from the releases that actually resolved rather than from `MOD_FEEDS`, because a feed can be
    // listed and still answer with nothing - every release refused, or none carrying a manifest for the
    // id, which is where a mod that stops publishing one ends up. Keyed on the static list, such a
    // record matched no feed's release and was skipped here too, so it had no row at all.
    let followed: BTreeSet<&str> = releases
        .iter()
        .map(|release| release.manifest.id.as_str())
        .collect();
    let mut unfollowed = Vec::new();
    for held in &record.mods {
        if followed.contains(held.id.as_str()) {
            continue;
        }
        // An unreadable snapshot still names the mod through the record's own fields, and defaulting
        // the type to removable is safe: uninstall re-reads the type itself, so a wrong guess costs a
        // refused click.
        let manifest = parse_manifest(
            held.manifest.as_bytes(),
            &ManifestDefaults {
                version: Some(held.version.clone()),
                archive: None,
            },
        )
        .ok();
        unfollowed.push(ModOffer {
            id: held.id.clone(),
            name: manifest
                .as_ref()
                .map_or_else(|| held.id.clone(), |one| one.name.clone()),
            version: held.version.clone(),
            mod_type: manifest
                .as_ref()
                .map_or(ModType::Pluggable, |one| one.mod_type),
            no_feed: true,
            // What the snapshot says about the mod, but no page flag whatever it names: the address is
            // resolved from a held release, and the whole of what makes this row unfollowed is that no
            // feed holds one.
            author: manifest.as_ref().and_then(|one| one.author.clone()),
            description: manifest.as_ref().and_then(|one| one.description.clone()),
            reason: manifest.as_ref().and_then(|one| one.reason.clone()),
            forum: false,
            homepage: false,
            becomes: None,
            creates: None,
            asks: Vec::new(),
            choices: None,
            availability: if held.complete {
                Availability::Unfollowed
            } else {
                Availability::Retry {
                    version: held.version.clone(),
                }
            },
        });
    }
    Ok(ModInstallState {
        standing,
        unfollowed,
    })
}

/// The two halves as one listing. Pure, so the interface can hold the feeds across a change of game and
/// redraw from a fresh install state alone. A published mod the install state says nothing about is
/// dropped rather than drawn without one: it means the two were read either side of a refresh that
/// changed what is published, and a row with no standing has no status line, no button and nothing to
/// do.
#[must_use]
pub fn listing_from(feeds: &ModFeedListing, state: &ModInstallState) -> ModListing {
    let mut offers = Vec::new();
    for mod_ in &feeds.published {
        let Some(standing) = state.standing.get(&mod_.id) else {
            continue;
        };
        offers.push(ModOffer {
            id: mod_.id.clone(),
            name: mod_.name.clone(),
            version: mod_.version.clone(),
            mod_type: mod_.mod_type,
            author: mod_.author.clone(),
            description: mod_.description.clone(),
            forum: mod_.forum,
            homepage: mod_.homepage,
            reason: mod_.reason.clone(),
            becomes: mod_.becomes,
            creates: mod_.creates.clone(),
            asks: mod_.asks.clone(),
            choices: (!mod_.choice.is_empty()).then(|| ChoiceOffer {
                groups: mod_.choice.clone(),
                carried: standing.carried.clone(),
            }),
            no_feed: false,
            availability: standing.availability.clone(),
        });
    }
    offers.extend(state.unfollowed.iter().cloned());
    ModListing {
        offers,
        failures: feeds.failures.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::records::InstalledMod;
    use std::collections::BTreeMap;
    use zax_platform::memory::{Content, MemoryOptions, MemoryPlatform, Response};

    /// The memory host's clock starts here and steps once per write, so a file it wrote reads as
    /// newer than this and a listing cached during a test is fresh unless the test says otherwise.
    const EARLY: i64 = 1_700_000_000_000;
    const LATE: i64 = EARLY + 24 * 60 * 60 * 1000;

    const REPO: &str = "BGforgeNet/FO2tweaks";
    const LIST: &str = "https://api.github.com/repos/BGforgeNet/FO2tweaks/releases?per_page=100";

    fn manifest_url(tag: &str) -> String {
        format!("https://raw.githubusercontent.com/{REPO}/{tag}/f2mod.yml")
    }

    fn tweaks() -> FeedSource {
        FeedSource {
            repository: REPO,
            id: "fo2tweaks",
            line: None,
        }
    }

    fn listing(tag: &str, assets: &str) -> String {
        format!(r#"[{{"tag_name":"{tag}","assets":[{assets}]}}]"#)
    }

    fn zip(name: &str) -> String {
        format!(
            r#"{{"name":"{name}","browser_download_url":"https://example/{name}","size":7,
                 "digest":"sha256:{}"}}"#,
            "a".repeat(64)
        )
    }

    fn manifest_text(id: &str) -> String {
        format!("spec: 1\nid: {id}\nname: FO2tweaks\ngame: fallout2\ntype: pluggable\n")
    }

    fn platform(responses: &[(&str, Response)]) -> MemoryPlatform {
        MemoryPlatform::new(MemoryOptions {
            responses: responses
                .iter()
                .map(|(url, body)| ((*url).to_owned(), body.clone()))
                .collect(),
            ..MemoryOptions::default()
        })
    }

    fn body(text: &str) -> Response {
        Response::Body(text.to_owned())
    }

    fn install() -> Install {
        Install::new("/games/f2", GameType::Fallout2)
    }

    fn record_with(mods: Vec<InstalledMod>) -> InstallRecord {
        InstallRecord {
            path: "/games/f2".to_owned(),
            mods,
            ..InstallRecord::default()
        }
    }

    fn installed(id: &str, version: &str, complete: bool) -> InstalledMod {
        InstalledMod {
            id: id.to_owned(),
            version: version.to_owned(),
            mod_type: Some(ModType::Pluggable),
            reason: None,
            complete,
            files: Vec::new(),
            entries: Vec::new(),
            parts: Vec::new(),
            manifest: manifest_text(id),
            shipped: BTreeMap::new(),
            before: BTreeMap::new(),
            carried: BTreeMap::new(),
        }
    }

    fn release_of(id: &str, version: &str) -> ModRelease {
        let text = format!("{}version: {version}\n", manifest_text(id));
        ModRelease {
            manifest: parse_manifest(text.as_bytes(), &ManifestDefaults::default())
                .expect("a manifest the test writes"),
            manifest_text: text,
            archive: Some(ReleaseAsset {
                name: "payload.zip".to_owned(),
                url: "https://example/payload.zip".to_owned(),
                digest: None,
                size: None,
            }),
            parts: BTreeMap::new(),
            installer: None,
            installer_route: None,
            line: None,
        }
    }

    fn context<'a>(record: &'a InstallRecord, install: &'a Install) -> ModContext<'a> {
        ModContext {
            install,
            record,
            sfall: None,
            present: false,
            base_version: None,
        }
    }

    #[test]
    fn a_tag_names_a_version_only_where_it_is_shaped_like_one() {
        assert_eq!(version_from_tag("v14.7").as_deref(), Some("14.7"));
        assert_eq!(version_from_tag("2.3.34").as_deref(), Some("2.3.34"));
        assert_eq!(version_from_tag("nightly"), None);
    }

    #[test]
    fn a_line_holds_its_own_numbering_and_the_counter_it_inherited() {
        let two_three = ModLine {
            prefix: "2.3.",
            counter: true,
        };
        let two_four = ModLine {
            prefix: "2.4.",
            counter: false,
        };
        assert!(held_by_line(&two_three, "2.3.34"));
        // RPU's bare `v30` and everything below it is 2.3's past.
        assert!(held_by_line(&two_three, "30"));
        assert!(!held_by_line(&two_four, "30"));
        assert!(held_by_line(&two_four, "2.4.32"));
    }

    #[test]
    fn a_lines_versions_order_on_their_counter_rather_than_component_by_component() {
        // `30` would otherwise read as a major version above `2.4.34`.
        let line = ModLine {
            prefix: "2.4.",
            counter: false,
        };
        assert_eq!(compare_in_line(Some(&line), "30", "2.4.34"), Ordering::Less);
        assert_eq!(
            compare_in_line(Some(&line), "2.4.34", "2.3.32"),
            Ordering::Greater
        );
        // With no line, the ordinary component comparison stands.
        assert_eq!(compare_in_line(None, "30", "2.4.34"), Ordering::Greater);
    }

    #[test]
    fn a_version_with_no_trailing_number_falls_back_to_the_ordinary_comparison() {
        let line = ModLine {
            prefix: "2.4.",
            counter: false,
        };
        assert_eq!(
            compare_in_line(Some(&line), "2.4.0beta", "2.4.1"),
            compare_versions("2.4.0beta", "2.4.1")
        );
    }

    #[test]
    fn the_release_with_the_highest_manifest_version_wins() {
        // Release order alone would let a hotfix backported to an older line shadow the current one.
        let two = format!(
            r#"[{{"tag_name":"v1.0","assets":[{}]}},{{"tag_name":"v2.0","assets":[{}]}}]"#,
            zip("a.zip"),
            zip("b.zip")
        );
        let platform = platform(&[
            (LIST, body(&two)),
            (&manifest_url("v1.0"), body(&manifest_text("fo2tweaks"))),
            (&manifest_url("v2.0"), body(&manifest_text("fo2tweaks"))),
        ]);
        let found = fetch_feed(&platform, &tweaks(), EARLY).expect("a release");
        assert_eq!(found.manifest.version, "2.0");
        // The tag supplied the version, and the release's sole archive supplied the payload.
        assert_eq!(
            found.archive.as_ref().map(|asset| asset.name.as_str()),
            Some("b.zip")
        );
    }

    #[test]
    fn a_release_whose_manifest_carries_another_id_is_not_this_rows() {
        let platform = platform(&[
            (LIST, body(&listing("v1.0", &zip("a.zip")))),
            (&manifest_url("v1.0"), body(&manifest_text("somethingelse"))),
        ]);
        let err = fetch_feed(&platform, &tweaks(), EARLY).expect_err("no release for this id");
        assert!(
            format!("{err}").contains("carries a manifest for \"fo2tweaks\""),
            "{err}"
        );
    }

    #[test]
    fn a_repository_that_ships_no_manifest_says_so_rather_than_naming_the_id() {
        let platform = platform(&[
            (LIST, body(&listing("v1.0", &zip("a.zip")))),
            (&manifest_url("v1.0"), Response::Status(404)),
        ]);
        let err = fetch_feed(&platform, &tweaks(), EARLY).expect_err("no manifest anywhere");
        assert!(
            format!("{err}").contains("ships a ZAX manifest yet"),
            "{err}"
        );
    }

    #[test]
    fn a_manifest_that_will_not_parse_is_the_answer_when_nothing_else_wins() {
        // "this needs a newer ZAX" is truer than "nothing found".
        let platform = platform(&[
            (LIST, body(&listing("v1.0", &zip("a.zip")))),
            (&manifest_url("v1.0"), body("spec: 99\nid: fo2tweaks\n")),
        ]);
        let err = fetch_feed(&platform, &tweaks(), EARLY).expect_err("a refusal");
        assert!(format!("{err}").contains("spec"), "{err}");
    }

    #[test]
    fn a_missing_manifest_is_remembered_so_a_refresh_costs_no_request() {
        let platform = platform(&[
            (LIST, body(&listing("v1.0", &zip("a.zip")))),
            (&manifest_url("v1.0"), Response::Status(404)),
        ]);
        fetch_feed(&platform, &tweaks(), EARLY).expect_err("no manifest");
        let asked = platform.records().fetched.len();
        fetch_feed(&platform, &tweaks(), EARLY).expect_err("no manifest");
        assert_eq!(
            platform.records().fetched.len(),
            asked,
            "the listing was cached and the absence remembered"
        );
    }

    #[test]
    fn a_listing_that_worked_yesterday_answers_when_the_network_refuses() {
        // Better than an empty tab; the install path re-verifies everything against digests anyway.
        // Nothing answers the network here, and the cache is past its life.
        let offline = MemoryPlatform::new(MemoryOptions::default());
        let listing_at = feed_cache_path(&offline, REPO, None);
        let manifest_at = with_suffix(&feed_cache_path(&offline, REPO, Some("v1.0")), ".yml");
        offline
            .fs()
            .write(&listing_at, listing("v1.0", &zip("a.zip")).as_bytes())
            .expect("a cache the test seeds");
        offline
            .fs()
            .write(&manifest_at, manifest_text("fo2tweaks").as_bytes())
            .expect("a cache the test seeds");
        let found = fetch_feed(&offline, &tweaks(), LATE).expect("the stale cache answers");
        assert_eq!(found.manifest.version, "1.0");
    }

    #[test]
    fn every_version_a_rows_tags_name_is_listed_newest_first() {
        let two = r#"[{"tag_name":"v1.0","assets":[]},{"tag_name":"v2.0","assets":[]},
                      {"tag_name":"nightly","assets":[]}]"#;
        let platform = platform(&[(LIST, body(two))]);
        let versions = list_mod_versions(&platform, &tweaks(), EARLY).expect("a listing");
        assert_eq!(versions, ["2.0", "1.0"]);
    }

    #[test]
    fn a_named_version_is_searched_for_across_the_whole_listing() {
        // The shortlist exists to avoid asking about releases that cannot win; a named one has won.
        let two = format!(
            r#"[{{"tag_name":"v2.0","assets":[{}]}},{{"tag_name":"v1.0","assets":[{}]}}]"#,
            zip("b.zip"),
            zip("a.zip")
        );
        let platform = platform(&[
            (LIST, body(&two)),
            (&manifest_url("v1.0"), body(&manifest_text("fo2tweaks"))),
            (&manifest_url("v2.0"), body(&manifest_text("fo2tweaks"))),
        ]);
        let found = fetch_feed_at(&platform, &tweaks(), "1.0", EARLY).expect("a release");
        assert_eq!(found.manifest.version, "1.0");
    }

    #[test]
    fn a_version_no_release_publishes_is_refused_by_name() {
        let platform = platform(&[(LIST, body(&listing("v1.0", "")))]);
        let err = fetch_feed_at(&platform, &tweaks(), "9.9", EARLY).expect_err("not published");
        assert!(format!("{err}").contains("\"fo2tweaks\" 9.9"), "{err}");
    }

    #[test]
    fn an_archive_shaped_asset_is_told_from_anything_else_on_a_release() {
        assert!(is_archive_name("payload.ZIP"));
        assert!(is_archive_name("payload.tar.gz"));
        assert!(!is_archive_name("payload.zip.sha256"));
        assert!(!is_archive_name("notes.txt"));
    }

    #[test]
    fn a_mod_that_does_not_install_here_is_told_apart_from_a_release_missing_its_asset() {
        // One message for both sends half its readers to look in the wrong place.
        let text = "spec: 1\nid: upu\nname: UPU\nversion: 1.0\ngame: fallout2\ntype: base\n\
                    becomes: fallout2upu\ninstaller.windows.built-with: inno\n";
        let manifest = parse_manifest(text.as_bytes(), &ManifestDefaults::default())
            .expect("a manifest the test writes");
        assert_eq!(
            installer_miss(&manifest, Some(InstallerRoute::Other)),
            "UPU does not install on this system."
        );
        let said = installer_miss(&manifest, Some(InstallerRoute::Windows));
        assert!(said.contains("no single executable"), "{said}");
    }

    #[test]
    fn a_named_installer_asset_the_release_lacks_is_the_authors_mistake() {
        let text = "spec: 1\nid: upu\nname: UPU\nversion: 1.0\ngame: fallout2\ntype: base\n\
                    becomes: fallout2upu\ninstaller.windows.built-with: inno\n\
                    installer.windows.asset: setup.exe\n";
        let manifest = parse_manifest(text.as_bytes(), &ManifestDefaults::default())
            .expect("a manifest the test writes");
        let said = installer_miss(&manifest, Some(InstallerRoute::Windows));
        assert!(said.contains("\"setup.exe\""), "{said}");
        assert!(said.contains("does not publish"), "{said}");
    }

    #[test]
    fn a_mod_nothing_records_and_nothing_holds_is_offered() {
        let record = record_with(Vec::new());
        let install = install();
        assert_eq!(
            availability(&release_of("fo2tweaks", "1.0"), &context(&record, &install)),
            Availability::Install
        );
    }

    #[test]
    fn a_hand_installed_mod_is_offered_laid_over_what_is_there() {
        let record = record_with(Vec::new());
        let install = install();
        let mut held = context(&record, &install);
        held.present = true;
        assert_eq!(
            availability(&release_of("fo2tweaks", "1.0"), &held),
            Availability::InstallOver
        );
    }

    #[test]
    fn a_record_at_the_same_version_reads_as_installed() {
        let record = record_with(vec![installed("fo2tweaks", "1.0", true)]);
        let install = install();
        assert_eq!(
            availability(&release_of("fo2tweaks", "1.0"), &context(&record, &install)),
            Availability::Installed
        );
    }

    #[test]
    fn a_newer_release_is_an_upgrade_and_an_older_one_a_downgrade() {
        let record = record_with(vec![installed("fo2tweaks", "1.0", true)]);
        let install = install();
        assert_eq!(
            availability(&release_of("fo2tweaks", "2.0"), &context(&record, &install)),
            Availability::Upgrade {
                from: "1.0".to_owned()
            }
        );
        let ahead = record_with(vec![installed("fo2tweaks", "3.0", true)]);
        assert_eq!(
            availability(&release_of("fo2tweaks", "2.0"), &context(&ahead, &install)),
            Availability::Downgrade {
                from: "3.0".to_owned()
            }
        );
    }

    #[test]
    fn an_install_that_never_finished_is_offered_as_a_retry() {
        let record = record_with(vec![installed("fo2tweaks", "1.0", false)]);
        let install = install();
        assert_eq!(
            availability(&release_of("fo2tweaks", "2.0"), &context(&record, &install)),
            Availability::Retry {
                version: "1.0".to_owned()
            }
        );
    }

    #[test]
    fn a_type_the_record_disagrees_with_is_a_conversion_rather_than_an_update() {
        // A mod taking its own removability away is not an update.
        let record = record_with(vec![InstalledMod {
            mod_type: Some(ModType::Permanent),
            ..installed("fo2tweaks", "1.0", true)
        }]);
        let install = install();
        assert_eq!(
            availability(&release_of("fo2tweaks", "2.0"), &context(&record, &install)),
            Availability::Convert {
                from: "1.0".to_owned(),
                was: ModType::Permanent
            }
        );
    }

    #[test]
    fn the_sfall_gate_answers_before_the_version_comparison() {
        let text = "spec: 1\nid: fo2tweaks\nname: FO2tweaks\nversion: 2.0\ngame: fallout2\n\
                    type: pluggable\nneeds.sfall: '4.4'\n";
        let manifest = parse_manifest(text.as_bytes(), &ManifestDefaults::default())
            .expect("a manifest the test writes");
        let release = ModRelease {
            manifest,
            ..release_of("fo2tweaks", "2.0")
        };
        let record = record_with(vec![installed("fo2tweaks", "1.0", true)]);
        let install = install();
        let mut held = context(&record, &install);
        held.sfall = Some("4.3");
        let Availability::Blocked { why, from } = availability(&release, &held) else {
            panic!("the gate must refuse");
        };
        assert!(why.contains("sfall 4.4"), "{why}");
        // A refused row is often an installed mod, and the version it holds is worth carrying.
        assert_eq!(from.as_deref(), Some("1.0"));
        held.sfall = Some("4.4");
        assert_eq!(
            availability(&release, &held),
            Availability::Upgrade {
                from: "1.0".to_owned()
            }
        );
    }

    #[test]
    fn a_release_that_names_no_payload_cannot_offer_a_download() {
        let release = ModRelease {
            archive: None,
            ..release_of("fo2tweaks", "1.0")
        };
        let record = record_with(Vec::new());
        let install = install();
        let Availability::Blocked { why, .. } = availability(&release, &context(&record, &install))
        else {
            panic!("nothing to download");
        };
        assert!(why.contains("which of its files is the mod"), "{why}");
    }

    #[test]
    fn the_game_type_gate_protects_a_first_install_alone() {
        let text = "spec: 1\nid: fo2tweaks\nname: FO2tweaks\nversion: 1.0\ngame: fallout2\n\
                    type: pluggable\nneeds.game: [fallout2rpu]\n";
        let manifest = parse_manifest(text.as_bytes(), &ManifestDefaults::default())
            .expect("a manifest the test writes");
        let release = ModRelease {
            manifest,
            ..release_of("fo2tweaks", "1.0")
        };
        let record = record_with(Vec::new());
        let install = install();
        let Availability::Blocked { why, from } =
            availability(&release, &context(&record, &install))
        else {
            panic!("the wrong game");
        };
        assert!(why.contains("Restoration Project Updated"), "{why}");
        assert_eq!(from, None, "nothing is installed to name a version of");
        // An upgrade is the same mod already, so the gate does not apply.
        let held = record_with(vec![installed("fo2tweaks", "0.9", true)]);
        assert_eq!(
            availability(&release, &context(&held, &install)),
            Availability::Upgrade {
                from: "0.9".to_owned()
            }
        );
    }

    #[test]
    fn a_base_mod_meeting_the_installation_it_makes_is_read_from_its_own_stamp() {
        let text = "spec: 1\nid: upu\nname: UPU\nversion: 2.0\ngame: fallout2\ntype: base\n\
                    becomes: fallout2upu\ninstaller.other.run: upu-install.sh\n";
        let manifest = parse_manifest(text.as_bytes(), &ManifestDefaults::default())
            .expect("a manifest the test writes");
        let release = ModRelease {
            manifest,
            installer: Some(ReleaseInstaller {
                route: InstallerRoute::Other,
                asset: ReleaseAsset {
                    name: "upu.zip".to_owned(),
                    url: "https://example/upu.zip".to_owned(),
                    digest: None,
                    size: None,
                },
            }),
            installer_route: Some(InstallerRoute::Other),
            ..release_of("upu", "2.0")
        };
        let record = record_with(Vec::new());
        let install = Install::new("/games/f2", GameType::Fallout2Upu);
        let mut held = context(&record, &install);
        held.base_version = Some(Some(BaseVersion::Release {
            version: "1.0".to_owned(),
        }));
        assert_eq!(
            availability(&release, &held),
            Availability::Upgrade {
                from: "1.0".to_owned()
            }
        );
        // A nightly stamps the commit it was built from, which nothing here can order.
        held.base_version = Some(Some(BaseVersion::Nightly {
            commit: "abc123".to_owned(),
        }));
        assert_eq!(
            availability(&release, &held),
            Availability::Nightly {
                commit: "abc123".to_owned()
            }
        );
    }

    #[test]
    fn a_created_install_read_with_no_version_stamped_is_not_one_that_is_there() {
        // The reading ran and found nothing, which is the ordinary state of a game Fallout et tu was never
        // unpacked into - only a stamped version, a record or the folder itself says it is there.
        let text = "spec: 1\nid: fo1in2\nname: Fallout et tu\nversion: 1.0\ngame: fallout2\ntype: base\n\
                    becomes: fo1in2\ncreates.directory: Fallout1in2\n";
        let manifest = parse_manifest(text.as_bytes(), &ManifestDefaults::default())
            .expect("a manifest the test writes");
        let release = ModRelease {
            manifest,
            ..release_of("fo1in2", "1.0")
        };
        let record = record_with(Vec::new());
        let install = Install::new("/games/f2", GameType::Fallout2Upu);
        let mut held = context(&record, &install);
        held.base_version = Some(None);
        assert_eq!(availability(&release, &held), Availability::Install);
    }

    #[test]
    fn a_mods_folder_entry_answering_to_the_id_is_the_mod_being_there() {
        let platform = MemoryPlatform::new(MemoryOptions {
            files: BTreeMap::from([(
                "/games/f2/mods/fo2tweaks.dat".to_owned(),
                Content::from("dat"),
            )]),
            ..MemoryOptions::default()
        });
        assert!(present_in_mods(&platform, "/games/f2", "fo2tweaks", &[]).expect("a read"));
        assert!(!present_in_mods(&platform, "/games/f2", "ecco", &[]).expect("a read"));
    }

    #[test]
    fn a_declared_entry_answers_where_an_id_never_could() {
        // An id carries no underscore and most of these filenames do.
        let platform = MemoryPlatform::new(MemoryOptions {
            files: BTreeMap::from([(
                "/games/f2/mods/cassidy_head.dat".to_owned(),
                Content::from("dat"),
            )]),
            ..MemoryOptions::default()
        });
        let declared = ["cassidy_head.dat".to_owned()];
        assert!(present_in_mods(&platform, "/games/f2", "ecco", &declared).expect("a read"));
        // Only the first piece of a nested entry is a name the mods folder itself lists.
        let nested = ["cassidy_head.dat/extra.dat".to_owned()];
        assert!(present_in_mods(&platform, "/games/f2", "ecco", &nested).expect("a read"));
    }

    #[test]
    fn an_install_with_no_mods_folder_holds_nothing() {
        let platform = MemoryPlatform::new(MemoryOptions::default());
        assert!(!present_in_mods(&platform, "/games/f2", "fo2tweaks", &[]).expect("a read"));
    }

    #[test]
    fn a_recorded_mod_no_feed_follows_still_gets_a_row() {
        // The tab is otherwise feed-driven, and such a mod would be installed yet invisible.
        let platform = MemoryPlatform::new(MemoryOptions::default());
        let record = record_with(vec![installed("retired", "1.0", true)]);
        let state =
            read_mod_install_state(&platform, &[], &install(), &record, None).expect("a reading");
        assert_eq!(state.unfollowed.len(), 1);
        assert_eq!(state.unfollowed[0].id, "retired");
        assert!(state.unfollowed[0].no_feed);
        assert_eq!(state.unfollowed[0].availability, Availability::Unfollowed);
    }

    #[test]
    fn a_published_mod_the_install_state_says_nothing_about_is_dropped() {
        // A row with no standing has no status line, no button and nothing to do.
        let feeds = ModFeedListing {
            published: vec![published_from(&release_of("fo2tweaks", "1.0"))],
            failures: Vec::new(),
        };
        let empty = ModInstallState {
            standing: BTreeMap::new(),
            unfollowed: Vec::new(),
        };
        assert!(listing_from(&feeds, &empty).offers.is_empty());
    }

    #[test]
    fn a_listing_joins_what_is_published_to_where_this_install_stands() {
        let feeds = ModFeedListing {
            published: vec![published_from(&release_of("fo2tweaks", "1.0"))],
            failures: vec![FeedFailure {
                repository: REPO.to_owned(),
                id: "fo2tweaks".to_owned(),
                name: "FO2tweaks".to_owned(),
                why: "offline".to_owned(),
            }],
        };
        let state = ModInstallState {
            standing: BTreeMap::from([(
                "fo2tweaks".to_owned(),
                Standing {
                    availability: Availability::Install,
                    carried: CarriedSelection::default(),
                },
            )]),
            unfollowed: vec![ModOffer {
                id: "retired".to_owned(),
                name: "Retired".to_owned(),
                version: "1.0".to_owned(),
                mod_type: ModType::Pluggable,
                author: None,
                description: None,
                forum: false,
                homepage: false,
                reason: None,
                becomes: None,
                creates: None,
                asks: Vec::new(),
                choices: None,
                no_feed: true,
                availability: Availability::Unfollowed,
            }],
        };
        let listed = listing_from(&feeds, &state);
        assert_eq!(listed.offers.len(), 2);
        assert_eq!(listed.offers[0].id, "fo2tweaks");
        assert_eq!(listed.offers[1].id, "retired");
        assert_eq!(listed.failures.len(), 1);
    }

    #[test]
    fn a_feed_row_names_a_repository_and_the_id_it_follows() {
        // Two entries over one repository is what parallel release lines are.
        let shared: Vec<&ModFeed> = MOD_FEEDS
            .iter()
            .filter(|feed| feed.repository == "BGforgeNet/Fallout2_Restoration_Project")
            .collect();
        assert_eq!(shared.len(), 2);
        assert_ne!(shared[0].id, shared[1].id);
        assert!(shared.iter().all(|feed| feed.line.is_some()));
    }

    #[test]
    fn a_tag_becomes_one_file_name_rather_than_a_path() {
        // Everything outside the slug's set collapses to a dash, separators included, so a tag can
        // name no directory but the feeds one.
        let platform = MemoryPlatform::new(MemoryOptions::default());
        let at = feed_cache_path(&platform, "owner/name", Some("v1.0/../.."));
        assert_eq!(
            at.parent(),
            feed_cache_path(&platform, "owner/name", None).parent()
        );
        assert_eq!(
            at.file_name().and_then(|one| one.to_str()),
            Some("owner-name-v1.0-..-..")
        );
    }
}

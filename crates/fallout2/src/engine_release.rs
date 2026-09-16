//! What an engine project has published, and the archive that release ships, kept once per machine
//! rather than once per install.

use std::cmp::Ordering;
use std::path::{Path, PathBuf};

use serde_json::Value;
use zax_core::directories::package_directory;
use zax_core::version::compare_versions;
use zax_platform::fs::FileKind;
use zax_platform::net::{DownloadOptions, NetworkError, NetworkFailure};
use zax_platform::{Error, Platform, Result};

use crate::engines::{EngineBuild, EngineDefinition, ReleaseModel, build_for, engine_by_id};
use crate::records::InstalledEngine;

/// One published file: what it is called, where it is, and how big the release says it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineAsset {
    pub name: String,
    pub url: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineRelease {
    /// The release's tag, as published.
    pub release: String,
    /// When it was published, ISO 8601.
    pub published: String,
    /// The asset for the machine asking, or nothing when the project publishes no build it can run.
    pub asset: Option<EngineAsset>,
    /// The commit the tag points at, or nothing where it could not be read. What actually identifies a
    /// rolling build: its tag and its release name never change, so the date and this are all that
    /// separate one from the next.
    pub commit: Option<String>,
}

/// What a long engine operation reports as it runs. A third value of the same shape as `SfallProgress`
/// and `ModProgress` rather than a shared one: folding the three together is a refactor of two working
/// flows, and this work has no reason to touch them.
#[derive(Default)]
pub struct EngineProgress<'a> {
    pub download: DownloadOptions<'a>,
    pub on_step: Option<&'a (dyn Fn(&str) + Send + Sync)>,
}

impl std::fmt::Debug for EngineProgress<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EngineProgress")
            .field("download", &self.download)
            .field("on_step", &self.on_step.map(|_| "<callback>"))
            .finish()
    }
}

impl EngineProgress<'_> {
    pub(crate) fn step(&self, said: &str) {
        if let Some(on_step) = self.on_step {
            on_step(said);
        }
    }
}

/// The releases list rather than the `latest` endpoint. A project whose only release is a prerelease -
/// which is what a rolling build is - answers 404 there, and the list's first entry is the newest
/// either way.
///
/// Thirty is what a version list can usefully offer; a rolling project answers with its one release
/// regardless.
fn releases_url(repo: &str) -> String {
    format!("https://api.github.com/repos/{repo}/releases?per_page=30")
}

/// The singular form, which matches one ref exactly - the plural returns every ref the path is a prefix
/// of.
fn tag_url(repo: &str, tag: &str) -> String {
    format!(
        "https://api.github.com/repos/{repo}/git/ref/tags/{}",
        urlencoding_path(tag)
    )
}

/// A tag inside a URL path. Every byte outside the unreserved set is escaped, which is stricter than a
/// path segment needs and correct for every tag a project could publish.
fn urlencoding_path(tag: &str) -> String {
    let mut out = String::with_capacity(tag.len());
    for byte in tag.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// The commit a tag points at, or nothing for anything that did not resolve to one. Losing it costs a
/// line of description, so a project whose tags this cannot read still installs and updates normally;
/// an annotated tag answers with its own object rather than a commit, and reporting that sha would name
/// a different thing.
fn tag_commit(platform: &dyn Platform, repo: &str, tag: &str) -> Option<String> {
    let body = platform.net().fetch_text(&tag_url(repo, tag)).ok()?;
    let parsed: Value = serde_json::from_str(&body).ok()?;
    let object = parsed.get("object")?;
    if object.get("type").and_then(Value::as_str) != Some("commit") {
        return None;
    }
    object.get("sha").and_then(Value::as_str).map(str::to_owned)
}

/// The asset for this machine, or nothing where the project publishes no build it can run or shipped
/// none.
fn asset_in(entry: &Value, build: Option<&EngineBuild>) -> Option<EngineAsset> {
    let build = build?;
    let wanted = entry
        .get("assets")?
        .as_array()?
        .iter()
        .find(|asset| asset.get("name").and_then(Value::as_str) == Some(build.asset))?;
    let url = wanted
        .get("browser_download_url")
        .and_then(Value::as_str)?
        .to_owned();
    Some(EngineAsset {
        name: build.asset.to_owned(),
        url,
        size: wanted.get("size").and_then(Value::as_u64).unwrap_or(0),
    })
}

/// The engine ZAX names under this id.
///
/// # Errors
///
/// Fails for an id no release of ZAX has ever named, which is what a record written by a newer version
/// could carry.
pub fn engine_named(id: &str) -> Result<&'static EngineDefinition> {
    engine_by_id(id).ok_or_else(|| Error::Unsupported(format!("No engine called \"{id}\".")))
}

/// Every release this machine could install, newest first.
///
/// The commit is resolved only for a rolling project, and costs one request per release. A tagged
/// release is identified by its tag, so asking would spend a request each to display nothing the tag
/// does not already say.
///
/// # Errors
///
/// Fails where the listing cannot be fetched, is not JSON, or where the project has published nothing
/// this version can read.
pub fn engine_releases(platform: &dyn Platform, engine_id: &str) -> Result<Vec<EngineRelease>> {
    let engine = engine_named(engine_id)?;
    let body = platform.net().fetch_text(&releases_url(engine.repo))?;
    let parsed: Value = serde_json::from_str(&body).map_err(|err| {
        Error::Unsupported(format!(
            "What GitHub sent for {} is not readable: {err}",
            engine.name
        ))
    })?;
    let build = build_for(engine, platform.os(), platform.arch());

    let mut releases = Vec::new();
    for entry in parsed.as_array().map(Vec::as_slice).unwrap_or_default() {
        let release = entry.get("tag_name").and_then(Value::as_str).unwrap_or("");
        let at = entry
            .get("published_at")
            .and_then(Value::as_str)
            .unwrap_or("");
        if release.is_empty() || at.is_empty() {
            continue;
        }
        let commit = match engine.releases {
            ReleaseModel::Rolling => tag_commit(platform, engine.repo, release),
            ReleaseModel::Tagged => None,
        };
        releases.push(EngineRelease {
            release: release.to_owned(),
            published: at.to_owned(),
            commit,
            asset: asset_in(entry, build),
        });
    }
    if releases.is_empty() {
        return Err(Error::Unsupported(format!(
            "{} has published no release ZAX can read.",
            engine.name
        )));
    }
    Ok(releases)
}

/// The newest release. What the Check button reads, and what an update is measured against.
///
/// # Errors
///
/// As `engine_releases`.
pub fn latest_engine(platform: &dyn Platform, engine_id: &str) -> Result<EngineRelease> {
    // The list above fails rather than come back empty, so the index cannot be missing; bounded rather
    // than asserted all the same.
    engine_releases(platform, engine_id)?
        .into_iter()
        .next()
        .ok_or_else(|| {
            Error::Unsupported(format!(
                "{} has published no release ZAX can read.",
                engine_named(engine_id).map_or(engine_id, |engine| engine.name)
            ))
        })
}

/// Whether the installed build is behind the published one. A rolling project publishes no version to
/// compare, so the publication instant is the version; a tagged one compares tags.
///
/// An instant that will not parse answers false rather than failing or guessing: this decides whether a
/// button offers an update, and the interface shows both dates beside it either way.
#[must_use]
pub fn engine_outdated(
    engine: &EngineDefinition,
    installed: &InstalledEngine,
    latest: &EngineRelease,
) -> bool {
    if engine.releases == ReleaseModel::Tagged {
        // Every leading non-digit, not just `v`: a tag can carry a word ("beta-0.9.6.4"), and a tag
        // that keeps one falls back to comparing whole strings, which puts 0.9.10 before 0.9.9.
        let strip = |tag: &str| {
            tag.trim_start_matches(|c: char| !c.is_ascii_digit())
                .to_owned()
        };
        return compare_versions(&strip(&installed.release), &strip(&latest.release))
            == Ordering::Less;
    }
    match (instant(&installed.published), instant(&latest.published)) {
        // Both are the one shape GitHub publishes, so lexical order is chronological - the same
        // reliance the cache's sort and the note write already make.
        (Some(had), Some(now)) => now > had,
        _ => false,
    }
}

/// The instant back, where it is the UTC shape GitHub publishes (`2024-01-02T03:04:05Z`), and nothing
/// otherwise. Narrow on purpose: two instants only compare lexically while both carry the same offset,
/// and answering for a shape this cannot order would be a guess rather than a comparison.
fn instant(text: &str) -> Option<&str> {
    let shape = "0000-00-00T00:00:00Z";
    if text.len() != shape.len() {
        return None;
    }
    let matches = text
        .bytes()
        .zip(shape.bytes())
        .all(|(byte, want)| match want {
            b'0' => byte.is_ascii_digit(),
            other => byte == other,
        });
    matches.then_some(text)
}

/// Path-safe and stable: the instant with its punctuation dropped, which sorts and collides with
/// nothing.
fn release_key(published: &str) -> String {
    published.chars().filter(char::is_ascii_digit).collect()
}

/// One release's directory under the shared package cache.
fn release_directory(
    platform: &dyn Platform,
    engine: &EngineDefinition,
    published: &str,
) -> PathBuf {
    package_directory(platform)
        .join("engines")
        .join(engine.id)
        .join(release_key(published))
}

/// What the cache records beside an archive, so a copy already there can be identified without asking
/// the network. The directory name carries the publication instant and nothing else, and a tagged
/// project's tag is what decides whether an install is behind - so the tag and the commit have to be
/// written down.
const NOTE_NAME: &str = "release.json";

/// The cached archive for a release, downloaded if this is the first time it is asked for. Under the
/// shared package directory rather than inside the install, so one download serves every install on the
/// machine.
///
/// A cached file is trusted only when the release declares a size and the file matches it - an unknown
/// size is not license to trust whatever is already there, which is what a zero-byte file from a broken
/// earlier response would otherwise pass for ever. A mismatch came from an answer that was not the
/// file - an error page served with a 200, a body that stopped early - and is discarded rather than
/// handed out again.
///
/// No digest check, unlike a mod's payload or sfall's: neither fallout2-ce nor Fission publishes one, on
/// GitHub or in a release's own notes - checked directly against their release APIs, not assumed. The
/// size match and the archive-open check below are what integrity this download gets.
///
/// # Errors
///
/// Fails where the download fails, where what arrived will not open as an archive, or where the note
/// cannot be written.
pub fn engine_package(
    platform: &dyn Platform,
    engine: &EngineDefinition,
    release: &EngineRelease,
    asset: &EngineAsset,
    options: &EngineProgress<'_>,
) -> Result<PathBuf> {
    let directory = release_directory(platform, engine, &release.published);
    let path = directory.join(&asset.name);
    let found = platform.fs().stat(&path)?;
    let usable = found.is_some_and(|stat| {
        stat.kind == FileKind::File && asset.size != 0 && stat.size == asset.size
    });
    if !usable {
        platform.fs().remove(&path)?;

        options.step(&format!("Downloading {}", engine.name));
        platform
            .net()
            .download(&asset.url, &path, &options.download)?;

        // Confirmed by opening it rather than by magic bytes: engines arrive as .zip, .tar.gz or .dmg,
        // and a disk image has no leading signature to check the way sfall's .7z does.
        if let Err(cause) = platform.archive().list(&path) {
            platform.fs().remove(&path)?;
            return Err(Error::Network(NetworkError {
                kind: NetworkFailure::Incomplete,
                url: asset.url.clone(),
                message: format!(
                    "What {} sent for {} was not an archive - the mirror may have answered with an \
                     error page. Trying again may reach a different one. ({cause})",
                    host_of(&asset.url),
                    engine.name
                ),
                status: None,
            }));
        }
    }

    // Written on both routes, and only once the archive is known good: an archive cached by a version
    // that wrote no note is otherwise unidentifiable for ever, since the release it came from is asked
    // for by name and answered from the cache before anything could record what it is.
    let note = serde_json::json!({
        "release": release.release,
        "published": release.published,
        "commit": release.commit,
    });
    platform
        .fs()
        .write(&directory.join(NOTE_NAME), note.to_string().as_bytes())?;
    Ok(path)
}

/// The host a refusal names, taken from the address rather than written twice. An address the download
/// already used, so it parses; the whole string is a poor name but a truthful one.
fn host_of(url: &str) -> String {
    url::Url::parse(url).map_or_else(
        |_| url.to_owned(),
        |parsed| parsed.host_str().unwrap_or(url).to_owned(),
    )
}

/// A release the cache already holds, with the archive this machine would install it from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedEngine {
    pub release: EngineRelease,
    pub archive: PathBuf,
}

/// Every release of this engine already in the cache that this machine could install, newest first.
/// What makes a second game folder a copy rather than a download, and what the Run button's version
/// list offers.
///
/// A directory with no note is one an older ZAX cached, and is passed over rather than guessed at: it
/// would take a tag and a commit this version cannot recover from the name. Its archive is downloaded
/// again the next time that release is asked for, which writes the note.
///
/// # Errors
///
/// Fails where the cache directory is there but cannot be listed.
pub fn cached_engines(
    platform: &dyn Platform,
    engine: &EngineDefinition,
    asset_name: &str,
) -> Result<Vec<CachedEngine>> {
    let root = package_directory(platform).join("engines").join(engine.id);
    if platform.fs().stat(&root)?.map(|stat| stat.kind) != Some(FileKind::Dir) {
        return Ok(Vec::new());
    }

    let mut held = Vec::new();
    for entry in platform.fs().list(&root)? {
        if entry.kind != FileKind::Dir {
            continue;
        }
        let directory = root.join(&entry.name);
        let archive = directory.join(asset_name);
        // An empty file is what a download interrupted at the first byte leaves; it is not something
        // to run.
        let found = platform.fs().stat(&archive)?;
        if !found.is_some_and(|stat| stat.kind == FileKind::File && stat.size != 0) {
            continue;
        }

        let Some(note) = read_note(platform, &directory.join(NOTE_NAME))? else {
            continue;
        };
        held.push(CachedEngine {
            // No asset: the cache holds the file rather than a way to fetch it, and an invented url is
            // one something downstream would eventually try to download.
            release: EngineRelease {
                asset: None,
                ..note
            },
            archive,
        });
    }
    // The instants are ISO 8601, so lexical order is chronological - the comparison the note write
    // already relies on.
    held.sort_by(|a, b| b.release.published.cmp(&a.release.published));
    Ok(held)
}

/// The newest of those, or nothing where nothing the cache holds can be installed here.
///
/// # Errors
///
/// As `cached_engines`.
pub fn cached_engine(
    platform: &dyn Platform,
    engine: &EngineDefinition,
    asset_name: &str,
) -> Result<Option<CachedEngine>> {
    Ok(cached_engines(platform, engine, asset_name)?
        .into_iter()
        .next())
}

/// Removes one cached release. Addressed by publication instant, which is what the directory name is
/// derived from, so this cannot name a directory outside the engine's own cache.
///
/// # Errors
///
/// Fails where the directory is there but cannot be removed.
pub fn forget_engine(
    platform: &dyn Platform,
    engine: &EngineDefinition,
    published: &str,
) -> Result<()> {
    platform
        .fs()
        .remove(&release_directory(platform, engine, published))
}

/// Puts one published build into the machine's cache, downloading it if this is the first time.
/// `published` names a release, or nothing for the newest.
///
/// Nothing is deployed: a build reaches a game folder when that folder runs it, which is what lets one
/// machine hold several and each folder choose.
///
/// # Errors
///
/// Fails where the project publishes no build for this machine, where it has not published the release
/// asked for, or where the download fails.
pub fn fetch_engine_build(
    platform: &dyn Platform,
    engine_id: &str,
    published: Option<&str>,
    options: &EngineProgress<'_>,
) -> Result<EngineRelease> {
    let engine = engine_named(engine_id)?;
    let Some(build) = build_for(engine, platform.os(), platform.arch()) else {
        return Err(Error::Unsupported(format!(
            "{} publishes no build ZAX can install for this machine. See {}.",
            engine.name, engine.page
        )));
    };
    let releases = engine_releases(platform, engine_id)?;
    let wanted = match published {
        None => releases.into_iter().next(),
        Some(at) => releases.into_iter().find(|one| one.published == at),
    };
    let Some(wanted) = wanted else {
        return Err(Error::Unsupported(format!(
            "{} has not published that build.",
            engine.name
        )));
    };
    let Some(asset) = wanted.asset.clone() else {
        return Err(Error::Unsupported(format!(
            "The {} release {} carries no {}.",
            engine.name, wanted.release, build.asset
        )));
    };
    engine_package(platform, engine, &wanted, &asset, options)?;
    Ok(wanted)
}

/// The note's fields, or nothing for anything this version cannot read - a truncated file, or an older
/// format.
fn read_note(platform: &dyn Platform, path: &Path) -> Result<Option<EngineRelease>> {
    if platform.fs().stat(path)?.map(|stat| stat.kind) != Some(FileKind::File) {
        return Ok(None);
    }
    let body = platform.fs().read(path)?;
    // A note ZAX cannot parse is one it did not finish writing. The archive beside it is fetched again.
    let Ok(parsed) = serde_json::from_slice::<Value>(&body) else {
        return Ok(None);
    };
    let (Some(release), Some(published)) = (
        parsed.get("release").and_then(Value::as_str),
        parsed.get("published").and_then(Value::as_str),
    ) else {
        return Ok(None);
    };
    Ok(Some(EngineRelease {
        release: release.to_owned(),
        published: published.to_owned(),
        commit: parsed
            .get("commit")
            .and_then(Value::as_str)
            .map(str::to_owned),
        asset: None,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use zax_platform::memory::{Content, MemoryOptions, MemoryPlatform, Response};

    const CE: &str = "fallout2-ce";
    const CE_RELEASES: &str =
        "https://api.github.com/repos/fallout2-ce/fallout2-ce/releases?per_page=30";
    const CE_ASSET: &str = "https://github.com/fallout2-ce/fallout2-ce/releases/download/x/fallout2-ce-linux-x64.tar.gz";

    fn ok(body: &str) -> Response {
        Response::Body(body.to_owned())
    }

    fn listing(assets: &str, published: &str) -> String {
        format!(r#"[{{"tag_name":"continious","published_at":"{published}","assets":[{assets}]}}]"#)
    }

    fn linux_asset(size: u64) -> String {
        format!(
            r#"{{"name":"fallout2-ce-linux-x64.tar.gz","browser_download_url":"{CE_ASSET}","size":{size}}}"#
        )
    }

    fn platform(responses: &[(&str, &str)]) -> MemoryPlatform {
        MemoryPlatform::new(MemoryOptions {
            os: Some(zax_platform::OperatingSystem::Linux),
            arch: Some(zax_platform::Architecture::X64),
            responses: responses
                .iter()
                .map(|(url, body)| ((*url).to_owned(), ok(body)))
                .collect(),
            ..MemoryOptions::default()
        })
    }

    fn installed(release: &str, published: &str) -> InstalledEngine {
        InstalledEngine {
            id: CE.to_owned(),
            release: release.to_owned(),
            published: published.to_owned(),
            complete: true,
            files: Vec::new(),
            backup: None,
            commit: None,
            pinned: false,
        }
    }

    #[test]
    fn a_release_carries_the_asset_this_machine_can_run() {
        let platform = platform(&[(
            CE_RELEASES,
            &listing(&linux_asset(1024), "2024-01-02T03:04:05Z"),
        )]);
        let found = engine_releases(&platform, CE).expect("a listing");
        assert_eq!(found.len(), 1);
        let asset = found[0].asset.as_ref().expect("a build for this machine");
        assert_eq!(asset.name, "fallout2-ce-linux-x64.tar.gz");
        assert_eq!(asset.size, 1024);
    }

    #[test]
    fn a_release_shipping_nothing_for_this_machine_carries_no_asset() {
        let windows = r#"{"name":"fallout2-ce-windows-x64.zip","browser_download_url":"https://e/x","size":1}"#;
        let platform = platform(&[(CE_RELEASES, &listing(windows, "2024-01-02T03:04:05Z"))]);
        let found = engine_releases(&platform, CE).expect("a listing");
        assert_eq!(found[0].asset, None);
    }

    #[test]
    fn a_project_that_has_published_nothing_readable_is_refused() {
        // What a single unreadable release already did.
        let platform = platform(&[(CE_RELEASES, "[]")]);
        let err = engine_releases(&platform, CE).expect_err("nothing to read");
        assert!(
            format!("{err}").contains("no release ZAX can read"),
            "{err}"
        );
    }

    #[test]
    fn an_entry_missing_its_tag_or_its_date_is_passed_over() {
        let body = r#"[{"published_at":"2024-01-01T00:00:00Z","assets":[]},
                       {"tag_name":"x","assets":[]},
                       {"tag_name":"good","published_at":"2024-01-02T00:00:00Z","assets":[]}]"#;
        let platform = platform(&[(CE_RELEASES, body)]);
        let found = engine_releases(&platform, CE).expect("a listing");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].release, "good");
    }

    #[test]
    fn an_id_no_release_of_zax_names_is_refused() {
        let platform = platform(&[]);
        assert!(engine_releases(&platform, "olympus").is_err());
    }

    #[test]
    fn a_rolling_project_is_told_apart_by_its_commit() {
        // Its tag and its release name never change, so the date and the commit are all there is.
        let tag = "https://api.github.com/repos/fallout2-ce/fallout2-ce/git/ref/tags/continious";
        let platform = platform(&[
            (
                CE_RELEASES,
                &listing(&linux_asset(1), "2024-01-02T03:04:05Z"),
            ),
            (tag, r#"{"object":{"type":"commit","sha":"abc123"}}"#),
        ]);
        let found = engine_releases(&platform, CE).expect("a listing");
        assert_eq!(found[0].commit.as_deref(), Some("abc123"));
    }

    #[test]
    fn an_annotated_tag_names_a_different_thing_and_is_not_reported() {
        let tag = "https://api.github.com/repos/fallout2-ce/fallout2-ce/git/ref/tags/continious";
        let platform = platform(&[
            (
                CE_RELEASES,
                &listing(&linux_asset(1), "2024-01-02T03:04:05Z"),
            ),
            (tag, r#"{"object":{"type":"tag","sha":"abc123"}}"#),
        ]);
        assert_eq!(
            engine_releases(&platform, CE).expect("a listing")[0].commit,
            None
        );
    }

    #[test]
    fn a_tag_that_cannot_be_read_costs_a_line_of_description_and_nothing_else() {
        let platform = platform(&[(
            CE_RELEASES,
            &listing(&linux_asset(1), "2024-01-02T03:04:05Z"),
        )]);
        let found = engine_releases(&platform, CE).expect("a listing");
        assert_eq!(found[0].commit, None);
        assert!(found[0].asset.is_some(), "the release still installs");
    }

    #[test]
    fn a_rolling_project_is_outdated_by_its_publication_instant() {
        let ce = engine_by_id(CE).expect("a named engine");
        let newer = EngineRelease {
            release: "continious".to_owned(),
            published: "2024-06-01T00:00:00Z".to_owned(),
            asset: None,
            commit: None,
        };
        assert!(engine_outdated(
            ce,
            &installed("continious", "2024-01-01T00:00:00Z"),
            &newer
        ));
        assert!(!engine_outdated(
            ce,
            &installed("continious", "2024-06-01T00:00:00Z"),
            &newer
        ));
    }

    #[test]
    fn an_instant_that_will_not_parse_offers_no_update() {
        // The interface shows both dates beside the button either way.
        let ce = engine_by_id(CE).expect("a named engine");
        let newer = EngineRelease {
            release: "continious".to_owned(),
            published: "2024-06-01T00:00:00Z".to_owned(),
            asset: None,
            commit: None,
        };
        assert!(!engine_outdated(
            ce,
            &installed("continious", "who knows"),
            &newer
        ));
    }

    #[test]
    fn a_tagged_project_compares_tags_past_whatever_word_they_carry() {
        let fission = engine_by_id("fission").expect("a named engine");
        let newer = EngineRelease {
            release: "beta-0.9.10".to_owned(),
            published: "2020-01-01T00:00:00Z".to_owned(),
            asset: None,
            commit: None,
        };
        // A whole-string comparison would put 0.9.10 before 0.9.9.
        assert!(engine_outdated(
            fission,
            &installed("v0.9.9", "2024-01-01T00:00:00Z"),
            &newer
        ));
        assert!(!engine_outdated(
            fission,
            &installed("0.9.10", "2024-01-01T00:00:00Z"),
            &newer
        ));
    }

    #[test]
    fn the_cache_holds_a_download_once_per_machine() {
        let ce = engine_by_id(CE).expect("a named engine");
        let platform = MemoryPlatform::new(MemoryOptions {
            os: Some(zax_platform::OperatingSystem::Linux),
            arch: Some(zax_platform::Architecture::X64),
            downloads: BTreeMap::from([(CE_ASSET.to_owned(), Content::from("payload"))]),
            archives: BTreeMap::from([(
                "payload".to_owned(),
                BTreeMap::from([("fallout2-ce".to_owned(), Content::from("elf"))]),
            )]),
            ..MemoryOptions::default()
        });
        let release = EngineRelease {
            release: "continious".to_owned(),
            published: "2024-01-02T03:04:05Z".to_owned(),
            asset: None,
            commit: Some("abc".to_owned()),
        };
        let asset = EngineAsset {
            name: "fallout2-ce-linux-x64.tar.gz".to_owned(),
            url: CE_ASSET.to_owned(),
            size: "payload".len() as u64,
        };
        let path = engine_package(&platform, ce, &release, &asset, &EngineProgress::default())
            .expect("a download");
        assert!(path.ends_with("fallout2-ce-linux-x64.tar.gz"));

        let held = cached_engines(&platform, ce, &asset.name).expect("a listing");
        assert_eq!(held.len(), 1);
        assert_eq!(held[0].release.release, "continious");
        assert_eq!(held[0].release.commit.as_deref(), Some("abc"));
        // The cache holds the file rather than a way to fetch it.
        assert_eq!(held[0].release.asset, None);
    }

    #[test]
    fn a_directory_with_no_note_is_passed_over() {
        // Its tag and commit cannot be recovered from the name.
        let ce = engine_by_id(CE).expect("a named engine");
        let platform = MemoryPlatform::new(MemoryOptions {
            files: BTreeMap::from([(
                "/home/tester/.cache/zax/packages/engines/fallout2-ce/20240102030405/a.tar.gz"
                    .to_owned(),
                Content::from("payload"),
            )]),
            ..MemoryOptions::default()
        });
        assert!(
            cached_engines(&platform, ce, "a.tar.gz")
                .expect("a listing")
                .is_empty()
        );
    }

    #[test]
    fn an_empty_archive_is_not_something_to_run() {
        let ce = engine_by_id(CE).expect("a named engine");
        let root = "/home/tester/.cache/zax/packages/engines/fallout2-ce/20240102030405";
        let platform = MemoryPlatform::new(MemoryOptions {
            files: BTreeMap::from([
                (format!("{root}/a.tar.gz"), Content::from("")),
                (
                    format!("{root}/release.json"),
                    Content::from(r#"{"release":"x","published":"2024-01-02T03:04:05Z"}"#),
                ),
            ]),
            ..MemoryOptions::default()
        });
        assert!(
            cached_engines(&platform, ce, "a.tar.gz")
                .expect("a listing")
                .is_empty()
        );
    }

    #[test]
    fn the_cache_lists_newest_first() {
        let ce = engine_by_id(CE).expect("a named engine");
        let root = "/home/tester/.cache/zax/packages/engines/fallout2-ce";
        let held = |at: &str, key: &str| {
            [
                (format!("{root}/{key}/a.tar.gz"), Content::from("payload")),
                (
                    format!("{root}/{key}/release.json"),
                    Content::from(format!(r#"{{"release":"{at}","published":"{at}"}}"#)),
                ),
            ]
        };
        let platform = MemoryPlatform::new(MemoryOptions {
            files: held("2024-01-01T00:00:00Z", "20240101000000")
                .into_iter()
                .chain(held("2025-01-01T00:00:00Z", "20250101000000"))
                .collect(),
            ..MemoryOptions::default()
        });
        let listed = cached_engines(&platform, ce, "a.tar.gz").expect("a listing");
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].release.published, "2025-01-01T00:00:00Z");
        assert_eq!(
            cached_engine(&platform, ce, "a.tar.gz")
                .expect("a listing")
                .map(|one| one.release.published),
            Some("2025-01-01T00:00:00Z".to_owned())
        );
    }

    #[test]
    fn forgetting_a_release_names_a_directory_inside_the_engines_own_cache() {
        let ce = engine_by_id(CE).expect("a named engine");
        let root = "/home/tester/.cache/zax/packages/engines/fallout2-ce";
        let platform = MemoryPlatform::new(MemoryOptions {
            files: BTreeMap::from([(
                format!("{root}/20240102030405/a.tar.gz"),
                Content::from("payload"),
            )]),
            ..MemoryOptions::default()
        });
        // A path traversal in the instant cannot escape: only its digits reach the name.
        forget_engine(&platform, ce, "../../2024-01-02T03:04:05Z").expect("a removal");
        assert_eq!(
            platform
                .fs()
                .stat(Path::new(&format!("{root}/20240102030405/a.tar.gz")))
                .expect("a read"),
            None
        );
    }

    #[test]
    fn a_machine_the_project_publishes_no_build_for_is_told_where_to_look() {
        let platform = MemoryPlatform::new(MemoryOptions {
            os: Some(zax_platform::OperatingSystem::MacOs),
            arch: Some(zax_platform::Architecture::Arm64),
            ..MemoryOptions::default()
        });
        let err = fetch_engine_build(&platform, "fission", None, &EngineProgress::default())
            .expect_err("no build for this machine");
        assert!(
            format!("{err}").contains("github.com/cambragol/fission-ce"),
            "{err}"
        );
    }

    #[test]
    fn a_release_the_project_has_not_published_is_refused() {
        let platform = platform(&[(
            CE_RELEASES,
            &listing(&linux_asset(1), "2024-01-02T03:04:05Z"),
        )]);
        let err = fetch_engine_build(
            &platform,
            CE,
            Some("1999-01-01T00:00:00Z"),
            &EngineProgress::default(),
        )
        .expect_err("not published");
        assert!(
            format!("{err}").contains("has not published that build"),
            "{err}"
        );
    }

    #[test]
    fn a_release_shipping_no_asset_for_this_machine_names_what_it_wanted() {
        let platform = platform(&[(CE_RELEASES, &listing("", "2024-01-02T03:04:05Z"))]);
        let err = fetch_engine_build(&platform, CE, None, &EngineProgress::default())
            .expect_err("no asset");
        assert!(
            format!("{err}").contains("fallout2-ce-linux-x64.tar.gz"),
            "{err}"
        );
    }
}

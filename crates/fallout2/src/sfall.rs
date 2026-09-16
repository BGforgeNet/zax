//! sfall: reading which version an install has, asking what the latest one is, and replacing one
//! with the other.
//!
//! The update is the riskiest thing this application does - it overwrites files in the game folder -
//! so it copies every file it is about to replace into the backup directory first, and it merges the
//! user's existing `ddraw.ini` into the new one rather than shipping the release's defaults over
//! their settings.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;
use zax_core::directories::{backup_directory, package_directory, temporary_directory};
use zax_core::fs::{copy_tree, list_files_recursively};
use zax_core::ini::IniDocument;
use zax_core::ini_merge::{MergeConflict, RemovedKey, merge_ini};
use zax_core::install::Install;
use zax_core::stamp::{LocalTime, stamp};
use zax_core::version::compare_versions;
use zax_platform::archive::ExtractOptions;
use zax_platform::fs::FileKind;
use zax_platform::net::DownloadOptions;
use zax_platform::{Error, Platform, Result};

use crate::archive_preflight::preflight_archive;
use crate::pe_version::installed_library_version;

/// sfall is a DirectDraw wrapper: it ships as this DLL, and its version is the DLL's own.
const SFALL_LIBRARY: &str = "ddraw.dll";

const RELEASE_INFO: &str = "https://sourceforge.net/projects/sfall/best_release.json";

/// Every published archive, newest first. The feed caps at 100 entries and ignores a page parameter.
const RELEASE_LIST: &str = "https://sourceforge.net/projects/sfall/rss?path=/sfall";

/// sfall's own settings file, which is both what the merge works on and the only file a base is read
/// from.
const DDRAW_INI: &str = "ddraw.ini";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SfallRelease {
    pub version: String,
    pub url: String,
}

/// Where a given version is published.
///
/// The release feed names only the newest, but every version is a file in the same directory under a
/// predictable name, which is what makes changing to an arbitrary version possible.
#[must_use]
pub fn release_url(version: &str) -> String {
    format!("https://sourceforge.net/projects/sfall/files/sfall/sfall_{version}.7z/download")
}

/// The host a refusal names, taken from the address rather than written twice.
fn release_host() -> &'static str {
    "sourceforge.net"
}

struct Shapes {
    /// The shape every release name has.
    version: Regex,
    /// A version inside the file listing.
    listed: Regex,
    /// The digest SourceForge publishes per file.
    md5: Regex,
}

fn shapes() -> &'static Shapes {
    static SHAPES: OnceLock<Shapes> = OnceLock::new();
    SHAPES.get_or_init(|| {
        let compile = |pattern: &str| {
            Regex::new(pattern).unwrap_or_else(|err| panic!("{pattern} does not compile: {err}"))
        };
        Shapes {
            version: compile(r"(?i)^\d[\d.a-z]*$"),
            listed: compile(r#"sfall_(\d[^< "]*?)\.7z"#),
            md5: compile(r#"(?i)<media:hash algo="md5">([0-9a-f]{32})</media:hash>"#),
        }
    })
}

/// Checked wherever a version is about to become a path segment or a URL, not only when one is read
/// out of the feed: the interface hands versions across the process boundary, and that caller is not
/// the curated list.
fn assert_version_shape(version: &str) -> Result<()> {
    if shapes().version.is_match(version) {
        Ok(())
    } else {
        Err(Error::Unsupported(format!(
            "Not an sfall version: \"{version}\""
        )))
    }
}

/// The versions available to change to, newest first.
///
/// Read from the file listing rather than the release feed, which names one: the listing is capped at
/// its most recent 100 files, so this is not the whole history.
///
/// # Errors
///
/// Fails when the listing cannot be fetched.
pub fn list_sfall_versions(platform: &dyn Platform) -> Result<Vec<String>> {
    let feed = platform.net().fetch_text(RELEASE_LIST)?;
    let mut seen: Vec<String> = Vec::new();
    for found in shapes().listed.captures_iter(&feed) {
        let version = &found[1];
        if shapes().version.is_match(version) && !seen.iter().any(|held| held == version) {
            seen.push(version.to_owned());
        }
    }
    seen.sort_by(|a, b| compare_versions(b, a));
    Ok(seen)
}

/// The installed version, or `None` when the install has no sfall.
///
/// # Errors
///
/// Fails when the library is there but cannot be read.
pub fn installed_sfall_version(
    platform: &dyn Platform,
    install: &Install,
) -> Result<Option<String>> {
    installed_library_version(platform, install, SFALL_LIBRARY)
}

/// The current release, from the project's own release feed.
///
/// The version is not published as a field: it is the archive's name, `sfall_4.5.7z`, which is also
/// what the Python implementation read.
///
/// # Errors
///
/// Fails when the feed cannot be fetched, is not JSON, or names no release.
pub fn latest_sfall(platform: &dyn Platform) -> Result<SfallRelease> {
    let body = platform.net().fetch_text(RELEASE_INFO)?;
    let parsed: Value = serde_json::from_str(&body).map_err(|err| {
        Error::Unsupported(format!("The sfall release feed is not readable: {err}"))
    })?;
    let release = parsed.get("release");
    let filename = release
        .and_then(|r| r.get("filename"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let url = release
        .and_then(|r| r.get("url"))
        .and_then(Value::as_str)
        .unwrap_or("");

    let version = filename
        .rsplit('_')
        .next()
        .map(|tail| tail.rsplit_once('.').map_or(tail, |(stem, _)| stem))
        .unwrap_or("");
    if version.is_empty() || url.is_empty() {
        return Err(Error::Unsupported(
            "The sfall release feed did not name a release.".to_owned(),
        ));
    }
    Ok(SfallRelease {
        version: version.to_owned(),
        url: url.to_owned(),
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SfallUpdate {
    pub version: String,
    /// Files replaced in the game folder, relative to it.
    pub replaced: Vec<String>,
    /// Where the replaced copies were put, or `None` when the update added files without replacing
    /// any.
    pub backup: Option<PathBuf>,
    /// Settings both the user and the release changed. The user's won; these are worth a second look.
    pub conflicts: Vec<MergeConflict>,
    /// Settings the release retired that the user had left at the old default.
    pub removed: Vec<RemovedKey>,
}

/// What a long sfall operation reports as it runs.
///
/// The download carries byte counts because its length is knowable; the steps after it only say what
/// they are doing, which is enough to keep a proportion stuck at 100% from reading as a hang.
#[derive(Default)]
pub struct SfallProgress<'a> {
    pub download: DownloadOptions<'a>,
    pub on_step: Option<&'a (dyn Fn(&str) + Send + Sync)>,
}

impl std::fmt::Debug for SfallProgress<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SfallProgress")
            .field("download", &self.download)
            .field("on_step", &self.on_step.map(|_| "<callback>"))
            .finish()
    }
}

impl SfallProgress<'_> {
    fn step(&self, said: &str) {
        if let Some(on_step) = self.on_step {
            on_step(said);
        }
    }
}

/// Every 7z archive begins with these bytes.
///
/// Worth checking because two of the ways a mirror misbehaves are invisible to the transport: an
/// error page served with a 200, and a chunked body that stops early without having declared a
/// length. Both write a file that exists, which is all the cache used to ask for.
const SEVEN_ZIP_MAGIC: &[u8] = &[0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];

fn is_archive(platform: &dyn Platform, path: &Path) -> bool {
    match platform.fs().stat(path) {
        Ok(Some(stat))
            if stat.kind == FileKind::File && stat.size >= SEVEN_ZIP_MAGIC.len() as u64 =>
        {
            platform
                .fs()
                .read(path)
                .is_ok_and(|head| head.starts_with(SEVEN_ZIP_MAGIC))
        }
        _ => false,
    }
}

/// The MD5 SourceForge's own file listing publishes for a version, or `None` when the feed does not
/// name one - an older release that has scrolled off the capped 100-entry list, or a feed the network
/// could not reach.
///
/// Best-effort: a caller getting `None` still installs on the archive-validity check alone, since a
/// metadata lookup failing is not evidence the download itself is bad.
fn sfall_md5(platform: &dyn Platform, version: &str) -> Option<String> {
    let feed = platform.net().fetch_text(RELEASE_LIST).ok()?;
    let name = format!("sfall_{version}.7z");
    for item in feed.split("<item>").skip(1) {
        if !item.contains(&name) {
            continue;
        }
        return shapes()
            .md5
            .captures(item)
            .map(|found| found[1].to_lowercase());
    }
    None
}

/// The cached archive for a version, downloaded if this is the first time it is asked for.
///
/// What is on disk is checked rather than assumed, in both directions: a cached file that is not an
/// archive is discarded instead of being handed out for ever, and a fresh download that is not one
/// fails here rather than at extraction, where the message would be about the extractor's exit
/// status instead of about the mirror.
///
/// # Errors
///
/// Fails on a malformed version, a download that fails, or a body that is not an archive or does not
/// match the published digest.
pub fn sfall_package(
    platform: &dyn Platform,
    version: &str,
    options: &SfallProgress<'_>,
) -> Result<PathBuf> {
    assert_version_shape(version)?;
    let path = package_directory(platform).join(format!("sfall-{version}.7z"));
    if is_archive(platform, &path) {
        return Ok(path);
    }
    // Something is there but it is not an archive, so it came from an answer that was not the file.
    platform.fs().remove(&path)?;

    // Named here rather than by the caller: an update fetches two archives - this release and the one
    // its merge compares against - and labelling both with the release's version reads as the
    // download restarting.
    options.step(&format!("Downloading sfall {version}"));
    platform
        .net()
        .download(&release_url(version), &path, &options.download)?;

    if !is_archive(platform, &path) {
        platform.fs().remove(&path)?;
        return Err(Error::Network(zax_platform::net::NetworkError {
            kind: zax_platform::net::NetworkFailure::Incomplete,
            url: release_url(version),
            message: format!(
                "What {} sent for sfall {version} was not an archive - the mirror may have \
                 answered with an error page. Trying again may reach a different one.",
                release_host()
            ),
            status: None,
        }));
    }

    // Beyond magic bytes: SourceForge's own listing publishes an MD5 per file, catching a corrupted
    // or substituted download that still happens to open as a valid archive.
    if let Some(digest) = sfall_md5(platform, version)
        && platform.hash().md5(&path)? != digest
    {
        platform.fs().remove(&path)?;
        return Err(Error::Network(zax_platform::net::NetworkError {
            kind: zax_platform::net::NetworkFailure::Incomplete,
            url: release_url(version),
            message: format!(
                "What {} sent for sfall {version} does not match the digest SourceForge publishes \
                 for it - the download may have been corrupted or tampered with. Trying again may \
                 reach a different mirror.",
                release_host()
            ),
            status: None,
        }));
    }
    Ok(path)
}

/// Extracts a release, and throws away the cached archive if it will not open.
///
/// An archive can begin with the right bytes and still be truncated - a chunked body that ended early
/// is not detectable until something tries to read it - and a cache keyed on existence would hand the
/// same broken file to every attempt after this one.
///
/// Judged before it is opened, by the same bounds a mod payload gets: this is a third-party archive
/// unpacked over the user's install, and asking for one file out of it rather than all of them
/// narrows what is written, not what the archive may declare.
fn extract_package(
    platform: &dyn Platform,
    version: &str,
    destination: &Path,
    options: &SfallProgress<'_>,
    only: &[String],
) -> Result<()> {
    let archive = sfall_package(platform, version, options)?;
    let attempt =
        preflight_archive(platform, &archive, &format!("sfall {version}")).and_then(|_| {
            platform.archive().extract(
                &archive,
                destination,
                &ExtractOptions {
                    only: only.to_vec(),
                },
            )
        });
    if attempt.is_err() {
        platform.fs().remove(&archive)?;
    }
    attempt
}

/// Where a version's own `ddraw.ini` is kept once it has been seen, so no later update has to fetch
/// it again.
fn defaults_path(platform: &dyn Platform, version: &str) -> PathBuf {
    package_directory(platform)
        .join("defaults")
        .join(format!("ddraw-{version}.ini"))
}

/// Keeps what a release ships as its `ddraw.ini`.
///
/// Called while the release is unpacked and before the merge rewrites that file in place, because
/// this is the pristine copy - the next update from this version reads it as the merge base and needs
/// no second archive at all.
fn remember_defaults(platform: &dyn Platform, version: &str, from: &Path) -> Result<()> {
    if platform.fs().stat(from)?.map(|s| s.kind) != Some(FileKind::File) {
        return Ok(());
    }
    platform.fs().copy(from, &defaults_path(platform, version))
}

/// What a version shipped as its own `ddraw.ini`, or `None` when that version's archive cannot be
/// had.
///
/// This is the base a merge compares against: without it there is no telling a chosen setting from an
/// untouched one. Read from the copy kept when that version was installed where there is one.
/// Otherwise the archive is fetched and only this one file is taken out of it.
///
/// # Errors
///
/// Fails only on a malformed version. An archive that will not download or will not open is a missing
/// base rather than a failed update, so it answers `None`.
pub fn sfall_defaults(
    platform: &dyn Platform,
    version: &str,
    options: &SfallProgress<'_>,
) -> Result<Option<IniDocument>> {
    // Before the fallible work below: a malformed version is a caller error to surface, not a missing
    // base to absorb.
    assert_version_shape(version)?;
    let kept = defaults_path(platform, version);
    if platform.fs().stat(&kept)?.map(|s| s.kind) == Some(FileKind::File) {
        return Ok(Some(IniDocument::parse(&platform.fs().read(&kept)?)));
    }

    let work = temporary_directory(platform).join(format!("sfall-defaults-{version}"));
    let found = read_shipped_defaults(platform, version, &work, &kept, options);
    // The scratch directory goes whichever way the read went.
    platform.fs().remove(&work)?;
    Ok(found)
}

fn read_shipped_defaults(
    platform: &dyn Platform,
    version: &str,
    work: &Path,
    kept: &Path,
    options: &SfallProgress<'_>,
) -> Option<IniDocument> {
    // An archive that will not download or will not open is a missing base, not a failed update: the
    // merge falls back to carrying every value across, which is what it did before any of this
    // existed.
    extract_package(platform, version, work, options, &[DDRAW_INI.to_owned()]).ok()?;
    let ini = work.join(DDRAW_INI);
    if platform.fs().stat(&ini).ok()?.map(|s| s.kind) != Some(FileKind::File) {
        return None;
    }
    let content = platform.fs().read(&ini).ok()?;
    platform.fs().write(kept, &content).ok()?;
    Some(IniDocument::parse(&content))
}

/// What a merge found, beyond the file it wrote.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct MergeReport {
    conflicts: Vec<MergeConflict>,
    removed: Vec<RemovedKey>,
}

/// Downloads a release, merges the install's `ddraw.ini` into the one it ships, and copies the result
/// over the install - after copying every file it is about to overwrite into the backup directory.
///
/// # Errors
///
/// Fails on a malformed version, a download or extraction that fails, or a write that fails.
pub fn update_sfall(
    platform: &dyn Platform,
    install: &Install,
    version: &str,
    now: LocalTime,
    options: &SfallProgress<'_>,
) -> Result<SfallUpdate> {
    // This is what the process boundary calls, so the shape is checked here too, not only in the path
    // builders.
    assert_version_shape(version)?;
    let at = stamp(now);
    let work = temporary_directory(platform).join(format!("sfall-{at}"));
    let unpacked = work.join("unpacked");

    let outcome = perform_update(platform, install, version, &at, &unpacked, options);
    platform.fs().remove(&work)?;
    outcome
}

fn perform_update(
    platform: &dyn Platform,
    install: &Install,
    version: &str,
    at: &str,
    unpacked: &Path,
    options: &SfallProgress<'_>,
) -> Result<SfallUpdate> {
    extract_package(platform, version, unpacked, options, &[])?;
    // Before the merge, which rewrites this file in place: what is on disk now is what the release
    // ships, and that is what the next update from this version needs as its base.
    remember_defaults(platform, version, &unpacked.join(DDRAW_INI))?;

    // The version being replaced, read before anything is written over it.
    let previous = installed_sfall_version(platform, install)?;
    options.step("Merging your settings");
    let merge = merge_settings(platform, install, unpacked, previous.as_deref(), options)?;

    options.step("Backing up the files being replaced");
    let incoming = list_files_recursively(platform, unpacked)?;
    let install_root = Path::new(&install.path);
    let backup = backup_directory(platform).join(at);
    let mut replaced = Vec::new();
    for file in &incoming {
        let existing = join_relative(install_root, file);
        if platform.fs().stat(&existing)?.map(|s| s.kind) != Some(FileKind::File) {
            continue;
        }
        platform
            .fs()
            .copy(&existing, &join_relative(&backup, file))?;
        replaced.push(file.clone());
    }

    options.step(&format!("Installing sfall {version}"));
    copy_tree(platform, unpacked, install_root)?;
    Ok(SfallUpdate {
        version: version.to_owned(),
        backup: (!replaced.is_empty()).then_some(backup),
        replaced,
        conflicts: merge.conflicts,
        removed: merge.removed,
    })
}

fn join_relative(base: &Path, relative: &str) -> PathBuf {
    let mut at = base.to_path_buf();
    for part in relative.split('/').filter(|part| !part.is_empty()) {
        at.push(part);
    }
    at
}

/// Carries the install's settings into the release's `ddraw.ini`.
///
/// That direction rather than the reverse: the new file's comments are sfall's documentation and its
/// keys are what this release understands, while only the values are the user's.
///
/// What the version being replaced shipped decides the rest. Reading it costs a download the first
/// time and nothing after, since the archive is kept.
fn merge_settings(
    platform: &dyn Platform,
    install: &Install,
    unpacked: &Path,
    previous: Option<&str>,
    options: &SfallProgress<'_>,
) -> Result<MergeReport> {
    let mine = Path::new(&install.path).join(DDRAW_INI);
    let theirs = unpacked.join(DDRAW_INI);
    if platform.fs().stat(&mine)?.map(|s| s.kind) != Some(FileKind::File)
        || platform.fs().stat(&theirs)?.map(|s| s.kind) != Some(FileKind::File)
    {
        return Ok(MergeReport::default());
    }

    let base = match previous {
        None => None,
        Some(version) => sfall_defaults(platform, version, options)?,
    };
    let outcome = merge_ini(
        IniDocument::parse(&platform.fs().read(&theirs)?),
        &IniDocument::parse(&platform.fs().read(&mine)?),
        base.as_ref(),
    );
    platform.fs().write(&theirs, &outcome.document.to_bytes())?;
    Ok(MergeReport {
        conflicts: outcome.conflicts,
        removed: outcome.removed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use zax_core::install::GameType;
    use zax_platform::memory::{Content, MemoryOptions, MemoryPlatform, Response};

    fn archive_bytes() -> Vec<u8> {
        let mut out = SEVEN_ZIP_MAGIC.to_vec();
        out.extend_from_slice(b"the rest of the archive");
        out
    }

    fn install() -> Install {
        Install::new("/games/f2", GameType::Fallout2)
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
    fn a_release_url_is_built_from_the_version() {
        assert_eq!(
            release_url("4.5"),
            "https://sourceforge.net/projects/sfall/files/sfall/sfall_4.5.7z/download"
        );
    }

    #[test]
    fn a_version_that_is_not_one_is_refused_before_it_becomes_a_path() {
        // The interface hands versions across the process boundary, and that caller is not the list.
        let platform = MemoryPlatform::default();
        for bad in ["../etc", "4.5; rm -rf /", "", "/absolute"] {
            assert!(
                sfall_package(&platform, bad, &SfallProgress::default()).is_err(),
                "{bad} was accepted"
            );
        }
    }

    #[test]
    fn the_listing_yields_versions_newest_first() {
        let feed = "<item>sfall_4.4.7z</item><item>sfall_4.5.7z</item><item>sfall_4.1.2.7z</item>";
        let platform = MemoryPlatform::new(MemoryOptions {
            responses: BTreeMap::from([(RELEASE_LIST.to_owned(), Response::Body(feed.to_owned()))]),
            ..MemoryOptions::default()
        });
        assert_eq!(
            list_sfall_versions(&platform).expect("list"),
            vec!["4.5".to_owned(), "4.4".to_owned(), "4.1.2".to_owned()]
        );
    }

    #[test]
    fn the_release_feed_names_the_version_by_its_archive_name() {
        // The version is not a field: it is the archive's name.
        let body = r#"{"release":{"filename":"/sfall/sfall_4.5.7z","url":"https://example/dl"}}"#;
        let platform = MemoryPlatform::new(MemoryOptions {
            responses: BTreeMap::from([(RELEASE_INFO.to_owned(), Response::Body(body.to_owned()))]),
            ..MemoryOptions::default()
        });
        let release = latest_sfall(&platform).expect("feed");
        assert_eq!(release.version, "4.5");
        assert_eq!(release.url, "https://example/dl");
    }

    #[test]
    fn a_feed_naming_no_release_is_refused() {
        let platform = MemoryPlatform::new(MemoryOptions {
            responses: BTreeMap::from([(RELEASE_INFO.to_owned(), Response::Body("{}".to_owned()))]),
            ..MemoryOptions::default()
        });
        assert!(latest_sfall(&platform).is_err());
    }

    #[test]
    fn a_cached_archive_is_handed_back_without_a_download() {
        let cached = "/home/tester/.cache/zax/packages/sfall-4.5.7z";
        let platform = MemoryPlatform::new(MemoryOptions {
            files: BTreeMap::from([(cached.to_owned(), Content::Binary(archive_bytes()))]),
            ..MemoryOptions::default()
        });
        let at = sfall_package(&platform, "4.5", &SfallProgress::default()).expect("package");
        assert_eq!(at, PathBuf::from(cached));
        assert!(
            platform.records().downloaded.is_empty(),
            "nothing should have been fetched"
        );
    }

    #[test]
    fn a_cached_file_that_is_not_an_archive_is_discarded_rather_than_handed_out() {
        let cached = "/home/tester/.cache/zax/packages/sfall-4.5.7z";
        let platform = MemoryPlatform::new(MemoryOptions {
            files: BTreeMap::from([(cached.to_owned(), Content::from("<html>error</html>"))]),
            downloads: BTreeMap::from([(release_url("4.5"), Content::Binary(archive_bytes()))]),
            ..MemoryOptions::default()
        });
        sfall_package(&platform, "4.5", &SfallProgress::default()).expect("package");
        assert_eq!(
            platform.records().downloaded.len(),
            1,
            "the bad cache entry must be replaced"
        );
    }

    #[test]
    fn a_body_that_is_not_an_archive_fails_here_rather_than_at_extraction() {
        // An error page served with a 200 writes a file that exists, which is all the cache asked for.
        let platform = MemoryPlatform::new(MemoryOptions {
            downloads: BTreeMap::from([(
                release_url("4.5"),
                Content::from("<html>not found</html>"),
            )]),
            ..MemoryOptions::default()
        });
        let err = sfall_package(&platform, "4.5", &SfallProgress::default())
            .expect_err("a non-archive must fail");
        assert!(err.to_string().contains("was not an archive"), "{err}");
        assert_eq!(
            platform.file_at("/home/tester/.cache/zax/packages/sfall-4.5.7z"),
            None,
            "the bad file must not be left cached"
        );
    }

    #[test]
    fn a_download_that_does_not_match_the_published_digest_is_refused() {
        let feed = format!(
            "<item>sfall_4.5.7z<media:hash algo=\"md5\">{}</media:hash></item>",
            "0".repeat(32)
        );
        let platform = MemoryPlatform::new(MemoryOptions {
            downloads: BTreeMap::from([(release_url("4.5"), Content::Binary(archive_bytes()))]),
            responses: BTreeMap::from([(RELEASE_LIST.to_owned(), Response::Body(feed))]),
            ..MemoryOptions::default()
        });
        let err = sfall_package(&platform, "4.5", &SfallProgress::default())
            .expect_err("a mismatched digest must fail");
        assert!(
            err.to_string().contains("does not match the digest"),
            "{err}"
        );
    }

    #[test]
    fn a_feed_that_names_no_digest_still_installs() {
        // A metadata lookup failing is not evidence the download itself is bad.
        let platform = MemoryPlatform::new(MemoryOptions {
            downloads: BTreeMap::from([(release_url("4.5"), Content::Binary(archive_bytes()))]),
            ..MemoryOptions::default()
        });
        assert!(sfall_package(&platform, "4.5", &SfallProgress::default()).is_ok());
    }

    #[test]
    fn an_install_with_no_sfall_reports_no_version() {
        let platform = MemoryPlatform::default();
        assert_eq!(
            installed_sfall_version(&platform, &install()).expect("read"),
            None
        );
    }

    #[test]
    fn defaults_kept_from_a_previous_install_are_read_rather_than_fetched() {
        let kept = "/home/tester/.cache/zax/packages/defaults/ddraw-4.4.ini";
        let platform = MemoryPlatform::new(MemoryOptions {
            files: BTreeMap::from([(kept.to_owned(), Content::from("[Misc]\nA=1\n"))]),
            ..MemoryOptions::default()
        });
        let found = sfall_defaults(&platform, "4.4", &SfallProgress::default())
            .expect("defaults")
            .expect("a kept copy");
        assert_eq!(found.get_str("Misc", "A").as_deref(), Some("1"));
        assert!(platform.records().downloaded.is_empty());
    }

    #[test]
    fn an_archive_that_cannot_be_had_is_a_missing_base_rather_than_a_failure() {
        // The merge falls back to carrying every value across.
        let platform = MemoryPlatform::default();
        assert_eq!(
            sfall_defaults(&platform, "4.4", &SfallProgress::default()).expect("defaults"),
            None
        );
    }

    #[test]
    fn a_malformed_version_is_surfaced_rather_than_absorbed_as_a_missing_base() {
        let platform = MemoryPlatform::default();
        assert!(sfall_defaults(&platform, "../etc", &SfallProgress::default()).is_err());
    }

    #[test]
    fn an_update_backs_up_what_it_replaces_and_merges_the_users_settings() {
        let archive = release_url("4.5");
        let platform = MemoryPlatform::new(MemoryOptions {
            files: BTreeMap::from([
                ("/games/f2/fallout2.exe".to_owned(), Content::from("MZ")),
                (
                    "/games/f2/ddraw.ini".to_owned(),
                    Content::from("[Misc]\nA=9\n"),
                ),
            ]),
            downloads: BTreeMap::from([(archive.clone(), Content::Binary(archive_bytes()))]),
            archives: BTreeMap::from([(
                "/home/tester/.cache/zax/packages/sfall-4.5.7z".to_owned(),
                BTreeMap::from([
                    ("ddraw.ini".to_owned(), Content::from("[Misc]\nA=2\nB=5\n")),
                    ("ddraw.dll".to_owned(), Content::from("MZ new")),
                ]),
            )]),
            ..MemoryOptions::default()
        });

        let update = update_sfall(
            &platform,
            &install(),
            "4.5",
            now(),
            &SfallProgress::default(),
        )
        .expect("update");

        assert_eq!(update.version, "4.5");
        assert!(
            update.replaced.contains(&"ddraw.ini".to_owned()),
            "{:?}",
            update.replaced
        );
        assert!(update.backup.is_some(), "a replaced file means a backup");
        assert_eq!(
            platform.text_at("/games/f2/ddraw.ini").as_deref(),
            Some("[Misc]\nA=9\nB=5\n"),
            "the user's value must win and the release's new key must arrive"
        );
        assert_eq!(
            platform.text_at("/games/f2/ddraw.dll").as_deref(),
            Some("MZ new"),
            "the release's own files must land"
        );
    }

    #[test]
    fn an_update_that_replaces_nothing_records_no_backup() {
        let platform = MemoryPlatform::new(MemoryOptions {
            files: BTreeMap::from([("/games/f2/fallout2.exe".to_owned(), Content::from("MZ"))]),
            downloads: BTreeMap::from([(release_url("4.5"), Content::Binary(archive_bytes()))]),
            archives: BTreeMap::from([(
                "/home/tester/.cache/zax/packages/sfall-4.5.7z".to_owned(),
                BTreeMap::from([("ddraw.dll".to_owned(), Content::from("MZ new"))]),
            )]),
            ..MemoryOptions::default()
        });
        let update = update_sfall(
            &platform,
            &install(),
            "4.5",
            now(),
            &SfallProgress::default(),
        )
        .expect("update");
        assert!(update.replaced.is_empty());
        assert_eq!(update.backup, None);
    }

    #[test]
    fn the_steps_are_reported_as_the_update_runs() {
        // Enough to keep a proportion stuck at 100% from reading as a hang.
        let platform = MemoryPlatform::new(MemoryOptions {
            files: BTreeMap::from([("/games/f2/fallout2.exe".to_owned(), Content::from("MZ"))]),
            downloads: BTreeMap::from([(release_url("4.5"), Content::Binary(archive_bytes()))]),
            archives: BTreeMap::from([(
                "/home/tester/.cache/zax/packages/sfall-4.5.7z".to_owned(),
                BTreeMap::from([("ddraw.dll".to_owned(), Content::from("MZ new"))]),
            )]),
            ..MemoryOptions::default()
        });
        let said = std::sync::Mutex::new(Vec::new());
        let note = |step: &str| {
            said.lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(step.to_owned());
        };
        let options = SfallProgress {
            on_step: Some(&note),
            ..SfallProgress::default()
        };
        update_sfall(&platform, &install(), "4.5", now(), &options).expect("update");

        let steps = said
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        assert!(
            steps.iter().any(|s| s.contains("Downloading sfall 4.5")),
            "{steps:?}"
        );
        assert!(
            steps.iter().any(|s| s.contains("Installing sfall 4.5")),
            "{steps:?}"
        );
    }
}

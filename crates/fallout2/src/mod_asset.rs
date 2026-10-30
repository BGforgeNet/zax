//! Fetching one file a release names, verified against the digest that release states.
//!
//! Its own module because three different things arrive this way - a mod's payload, a base mod's
//! installer, and the tool ZAX unpacks a Fallout archive with - and a second copy of these four steps
//! would be a second place for the digest check to go missing from.

use std::path::{Path, PathBuf};

use zax_platform::fs::FileKind;
use zax_platform::net::DownloadOptions;
use zax_platform::{Error, Platform, Result};

use crate::mod_feed::ReleaseAsset;

/// What a long mod operation reports as it runs.
#[derive(Default)]
pub struct ModProgress<'a> {
    pub download: DownloadOptions<'a>,
    pub on_step: Option<&'a (dyn Fn(&str) + Send + Sync)>,
}

impl std::fmt::Debug for ModProgress<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ModProgress")
            .field("download", &self.download)
            .field("on_step", &self.on_step.map(|_| "<callback>"))
            .finish()
    }
}

impl ModProgress<'_> {
    pub(crate) fn step(&self, said: &str) {
        if let Some(on_step) = self.on_step {
            on_step(said);
        }
    }
}

/// What the asset is called in a refusal: the mod whose release states the digest, and the label the
/// download reports itself under.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AssetNaming<'a> {
    pub mod_name: &'a str,
    pub label: &'a str,
}

/// The hex of a `sha256:<hex>` digest, lowercased, or nothing for anything else.
fn sha256_digest(stated: Option<&str>) -> Option<String> {
    let stated = stated?;
    let hex = stated
        .strip_prefix("sha256:")
        .or_else(|| stated.strip_prefix("SHA256:"))?;
    (hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit())).then(|| hex.to_lowercase())
}

/// One asset in a working directory, verified. A verified copy already there is kept, which is what
/// makes a retry resume instead of paying the download again.
///
/// # Errors
///
/// Fails where the release states no digest, where the download fails, or where what arrived does not
/// match the digest.
pub fn fetch_asset(
    platform: &dyn Platform,
    work: &Path,
    asset: &ReleaseAsset,
    what: AssetNaming<'_>,
    options: &ModProgress<'_>,
) -> Result<PathBuf> {
    // Required rather than best-effort: the digest is what closes in-transit tampering, truncation and
    // a corrupted resume in one check, and the feeds this list trusts all publish one.
    let Some(digest) = sha256_digest(asset.digest.as_deref()) else {
        return Err(Error::Unsupported(format!(
            "The {} release states no digest for {}.",
            what.mod_name, asset.name
        )));
    };

    let archive_path = work.join(&asset.name);
    let present = platform.fs().stat(&archive_path)?.map(|stat| stat.kind) == Some(FileKind::File);
    if present && platform.hash().sha256(&archive_path)? == digest {
        return Ok(archive_path);
    }

    options.step(&format!("Downloading {}", what.label));
    platform
        .net()
        .download(&asset.url, &archive_path, &options.download)?;
    if platform.hash().sha256(&archive_path)? != digest {
        platform.fs().remove(&archive_path)?;
        return Err(Error::Unsupported(format!(
            "What arrived for {} does not match the digest its release states - the download may \
             have been tampered with or corrupted. Nothing was installed.",
            asset.name
        )));
    }
    Ok(archive_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use zax_platform::memory::{Content, MemoryOptions, MemoryPlatform};

    const URL: &str = "https://example/payload.zip";
    /// The SHA-256 of "payload", which the memory host hashes for real.
    fn digest_of(platform: &MemoryPlatform, path: &Path) -> String {
        platform.hash().sha256(path).expect("a digest")
    }

    fn naming() -> AssetNaming<'static> {
        AssetNaming {
            mod_name: "EcCo",
            label: "EcCo 1.0",
        }
    }

    fn asset(digest: Option<&str>) -> ReleaseAsset {
        ReleaseAsset {
            name: "payload.zip".to_owned(),
            url: URL.to_owned(),
            digest: digest.map(ToOwned::to_owned),
            size: None,
        }
    }

    fn platform(files: &[(&str, &str)]) -> MemoryPlatform {
        MemoryPlatform::new(MemoryOptions {
            files: files
                .iter()
                .map(|(path, text)| ((*path).to_owned(), Content::from(*text)))
                .collect(),
            downloads: BTreeMap::from([(URL.to_owned(), Content::from("payload"))]),
            ..MemoryOptions::default()
        })
    }

    /// What the release would state for the payload the host serves.
    fn stated(platform: &MemoryPlatform) -> String {
        let at = Path::new("/tmp/probe");
        platform
            .fs()
            .write(at, b"payload")
            .expect("a file the test writes");
        format!("sha256:{}", digest_of(platform, at))
    }

    #[test]
    fn a_release_stating_no_digest_is_refused() {
        // The digest closes tampering, truncation and a corrupted resume in one check.
        let platform = platform(&[]);
        let err = fetch_asset(
            &platform,
            Path::new("/work"),
            &asset(None),
            naming(),
            &ModProgress::default(),
        )
        .expect_err("no digest");
        assert!(format!("{err}").contains("states no digest"), "{err}");
    }

    #[test]
    fn a_digest_in_another_shape_is_not_taken_as_one() {
        let platform = platform(&[]);
        for stated in ["md5:abc", "sha256:notlongenough", ""] {
            assert!(
                fetch_asset(
                    &platform,
                    Path::new("/work"),
                    &asset(Some(stated)),
                    naming(),
                    &ModProgress::default(),
                )
                .is_err(),
                "{stated} was taken as a digest"
            );
        }
    }

    #[test]
    fn what_arrives_is_kept_when_it_matches() {
        let platform = platform(&[]);
        let digest = stated(&platform);
        let at = fetch_asset(
            &platform,
            Path::new("/work"),
            &asset(Some(&digest)),
            naming(),
            &ModProgress::default(),
        )
        .expect("a download");
        assert_eq!(at, PathBuf::from("/work/payload.zip"));
        assert_eq!(platform.fs().read(&at).expect("a read"), b"payload");
    }

    #[test]
    fn a_verified_copy_already_there_is_not_downloaded_again() {
        // What makes a retry resume instead of paying the download twice.
        let platform = platform(&[("/work/payload.zip", "payload")]);
        let digest = stated(&platform);
        fetch_asset(
            &platform,
            Path::new("/work"),
            &asset(Some(&digest)),
            naming(),
            &ModProgress::default(),
        )
        .expect("the copy already there");
        let fetched = platform.records().downloaded;
        assert!(fetched.is_empty(), "{fetched:?}");
    }

    #[test]
    fn a_copy_that_does_not_verify_is_downloaded_over() {
        let platform = platform(&[("/work/payload.zip", "something else")]);
        let digest = stated(&platform);
        let at = fetch_asset(
            &platform,
            Path::new("/work"),
            &asset(Some(&digest)),
            naming(),
            &ModProgress::default(),
        )
        .expect("a download");
        assert_eq!(platform.fs().read(&at).expect("a read"), b"payload");
    }

    #[test]
    fn what_arrived_not_matching_the_digest_is_thrown_away() {
        let platform = platform(&[]);
        let wrong = format!("sha256:{}", "0".repeat(64));
        let err = fetch_asset(
            &platform,
            Path::new("/work"),
            &asset(Some(&wrong)),
            naming(),
            &ModProgress::default(),
        )
        .expect_err("a mismatch");
        assert!(format!("{err}").contains("Nothing was installed"), "{err}");
        assert_eq!(
            platform
                .fs()
                .stat(Path::new("/work/payload.zip"))
                .expect("a read"),
            None
        );
    }

    #[test]
    fn the_download_is_reported_under_the_label_it_was_given() {
        let said = std::sync::Mutex::new(Vec::new());
        let note = |step: &str| {
            said.lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(step.to_owned());
        };
        let platform = platform(&[]);
        let digest = stated(&platform);
        fetch_asset(
            &platform,
            Path::new("/work"),
            &asset(Some(&digest)),
            naming(),
            &ModProgress {
                on_step: Some(&note),
                ..ModProgress::default()
            },
        )
        .expect("a download");
        assert_eq!(
            said.lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .as_slice(),
            ["Downloading EcCo 1.0"]
        );
    }
}

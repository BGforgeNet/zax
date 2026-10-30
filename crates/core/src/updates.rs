//! Checking whether a newer ZAX has been released.
//!
//! The application does not update itself: it points the user at the release, because replacing a
//! running binary is the platform's business and getting it wrong leaves them with neither version.

use serde_json::Value;
use zax_platform::{Architecture, Error, OperatingSystem, Platform, Result};

const LATEST_RELEASE: &str = "https://api.github.com/repos/BGforgeNet/zax/releases/latest";

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
pub struct ZaxRelease {
    pub version: String,
    /// The build for the machine asking, or the release page when it publishes nothing that machine
    /// can run.
    pub url: String,
}

/// What a release asset is named for one host.
///
/// The endings `.github/scripts/package.sh` names each platform's preferred single-file build with.
/// Extension alone cannot distinguish the Windows and macOS zips, and the release also carries an SBOM
/// that no machine can run.
fn asset_suffix(os: OperatingSystem, arch: Architecture) -> Option<String> {
    if arch == Architecture::Other {
        return None;
    }
    let (name, extension) = match os {
        OperatingSystem::Windows => ("win", "exe"),
        OperatingSystem::Linux => ("linux", "appimage"),
        OperatingSystem::MacOs => ("mac", "zip"),
    };
    Some(format!("-{name}-{arch}.{extension}"))
}

/// The address if it is one this may be opened with, and `None` otherwise.
///
/// Checked here rather than where it is opened: this is where the feed's bytes become a value, and
/// the thing that receives it is the system's own opener, which will do whatever the scheme says -
/// `file:` reaches the disk, and the shells that handle the rest are not ours.
fn https_only(address: Option<&str>) -> Option<String> {
    let address = address?;
    let parsed = url::Url::parse(address).ok()?;
    (parsed.scheme() == "https").then(|| address.to_owned())
}

/// Reads the release feed and answers what the newest release is, and where this machine gets it.
///
/// # Errors
///
/// Fails when the feed cannot be fetched, when it is not JSON, or when it names no version.
pub fn latest_zax(platform: &dyn Platform) -> Result<ZaxRelease> {
    let body = platform.net().fetch_text(LATEST_RELEASE)?;
    let parsed: Value = serde_json::from_str(&body)
        .map_err(|err| Error::Unsupported(format!("The release feed is not readable: {err}")))?;

    let tag = parsed.get("tag_name").and_then(Value::as_str).unwrap_or("");
    let version = tag
        .strip_prefix('v')
        .or_else(|| tag.strip_prefix('V'))
        .unwrap_or(tag);
    if version.is_empty() {
        return Err(Error::Unsupported(
            "The release feed did not name a version.".to_owned(),
        ));
    }

    let suffix = asset_suffix(platform.os(), platform.arch());
    let build = suffix.and_then(|suffix| {
        parsed
            .get("assets")
            .and_then(Value::as_array)
            .unwrap_or(&Vec::new())
            .iter()
            .find(|asset| {
                asset
                    .get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|name| name.to_lowercase().ends_with(&suffix))
            })
            .and_then(|asset| asset.get("browser_download_url"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
    });

    let page = parsed
        .get("html_url")
        .and_then(Value::as_str)
        .unwrap_or(LATEST_RELEASE);

    Ok(ZaxRelease {
        version: version.to_owned(),
        url: https_only(build.as_deref())
            .or_else(|| https_only(Some(page)))
            .unwrap_or_else(|| LATEST_RELEASE.to_owned()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use zax_platform::memory::{MemoryOptions, MemoryPlatform, Response};

    fn feed(body: &str) -> MemoryOptions {
        MemoryOptions {
            responses: BTreeMap::from([(
                LATEST_RELEASE.to_owned(),
                Response::Body(body.to_owned()),
            )]),
            ..MemoryOptions::default()
        }
    }

    fn release_json(assets: &str) -> String {
        format!(
            r#"{{"tag_name":"v1.2.3","html_url":"https://github.com/BGforgeNet/zax/releases/tag/v1.2.3","assets":[{assets}]}}"#
        )
    }

    fn asset(name: &str, url: &str) -> String {
        format!(r#"{{"name":"{name}","browser_download_url":"{url}"}}"#)
    }

    #[test]
    fn the_version_drops_its_leading_v() {
        let platform = MemoryPlatform::new(feed(&release_json("")));
        assert_eq!(latest_zax(&platform).expect("fetch").version, "1.2.3");
    }

    #[test]
    fn a_feed_naming_no_version_is_refused() {
        let platform = MemoryPlatform::new(feed(r#"{"assets":[]}"#));
        assert!(latest_zax(&platform).is_err());
    }

    #[test]
    fn a_feed_that_is_not_json_is_refused() {
        let platform = MemoryPlatform::new(feed("<html>not json</html>"));
        assert!(latest_zax(&platform).is_err());
    }

    #[test]
    fn an_unreachable_feed_is_reported() {
        let platform = MemoryPlatform::default();
        assert!(latest_zax(&platform).is_err());
    }

    #[test]
    fn the_build_for_this_machine_is_picked_out() {
        let assets = [
            asset(
                "zax-linux-x64.AppImage",
                "https://example/zax-linux-x64.AppImage",
            ),
            asset("zax-win-x64.exe", "https://example/zax-win-x64.exe"),
            asset("zax.sbom.json", "https://example/sbom"),
        ]
        .join(",");
        let mut options = feed(&release_json(&assets));
        options.os = Some(OperatingSystem::Linux);
        options.arch = Some(Architecture::X64);
        let platform = MemoryPlatform::new(options);
        assert_eq!(
            latest_zax(&platform).expect("fetch").url,
            "https://example/zax-linux-x64.AppImage"
        );
    }

    #[test]
    fn the_windows_and_macos_builds_are_told_apart() {
        let assets = [
            asset("zax-mac-arm64.zip", "https://example/mac"),
            asset("zax-win-arm64.exe", "https://example/win"),
        ]
        .join(",");
        for (os, wanted) in [
            (OperatingSystem::MacOs, "https://example/mac"),
            (OperatingSystem::Windows, "https://example/win"),
        ] {
            let mut options = feed(&release_json(&assets));
            options.os = Some(os);
            options.arch = Some(Architecture::Arm64);
            let platform = MemoryPlatform::new(options);
            assert_eq!(
                latest_zax(&platform).expect("fetch").url,
                wanted,
                "for {os}"
            );
        }
    }

    #[test]
    fn a_machine_with_no_build_is_sent_to_the_release_page() {
        let assets = asset("zax-linux-x64.AppImage", "https://example/linux");
        let mut options = feed(&release_json(&assets));
        options.os = Some(OperatingSystem::Linux);
        options.arch = Some(Architecture::Other);
        let platform = MemoryPlatform::new(options);
        assert_eq!(
            latest_zax(&platform).expect("fetch").url,
            "https://github.com/BGforgeNet/zax/releases/tag/v1.2.3"
        );
    }

    #[test]
    fn an_asset_address_that_is_not_https_is_refused() {
        // What receives this is the system's own opener, which does whatever the scheme says.
        let assets = asset("zax-linux-x64.appimage", "file:///etc/passwd");
        let mut options = feed(&release_json(&assets));
        options.os = Some(OperatingSystem::Linux);
        options.arch = Some(Architecture::X64);
        let platform = MemoryPlatform::new(options);
        assert_eq!(
            latest_zax(&platform).expect("fetch").url,
            "https://github.com/BGforgeNet/zax/releases/tag/v1.2.3"
        );
    }

    #[test]
    fn a_page_address_that_is_not_https_falls_back_to_the_feed() {
        let body = r#"{"tag_name":"v1.2.3","html_url":"javascript:alert(1)","assets":[]}"#;
        let platform = MemoryPlatform::new(feed(body));
        assert_eq!(latest_zax(&platform).expect("fetch").url, LATEST_RELEASE);
    }

    #[test]
    fn an_asset_name_is_matched_whatever_its_case() {
        let assets = asset("ZAX-Linux-X64.AppImage", "https://example/linux");
        let mut options = feed(&release_json(&assets));
        options.os = Some(OperatingSystem::Linux);
        options.arch = Some(Architecture::X64);
        let platform = MemoryPlatform::new(options);
        assert_eq!(
            latest_zax(&platform).expect("fetch").url,
            "https://example/linux"
        );
    }
}

//! What the indexer reads from GitHub: a repository's current name, its releases, and a file at a tag.
//!
//! Authenticated where a token is given, because the indexer runs on a shared runner whose address the
//! anonymous limit of 60 requests an hour is counted against.

use serde_json::Value;
use zax_platform::net::HttpResponse;
use zax_platform::{Error, Platform, Result};

const API: &str = "https://api.github.com";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubAsset {
    pub name: String,
    pub url: String,
    pub size: u64,
    /// As GitHub states it, `sha256:<hex>`; absent for assets uploaded before it started stating one.
    pub digest: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubRelease {
    pub tag: String,
    pub prerelease: bool,
    pub draft: bool,
    pub published: String,
    pub assets: Vec<GithubAsset>,
}

pub struct Github<'a> {
    platform: &'a dyn Platform,
    token: Option<String>,
}

impl std::fmt::Debug for Github<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The token is a credential, and Debug output reaches logs.
        f.debug_struct("Github")
            .field("token", &self.token.as_ref().map(|_| "<set>"))
            .finish_non_exhaustive()
    }
}

/// The URL a `Link` header names as the next page, if any.
fn next_page(response: &HttpResponse) -> Option<String> {
    let link = response.header("link")?;
    link.split(',').find_map(|part| {
        let (target, params) = part.split_once(';')?;
        params
            .split(';')
            .any(|param| param.trim() == "rel=\"next\"")
            .then(|| {
                target
                    .trim()
                    .trim_start_matches('<')
                    .trim_end_matches('>')
                    .to_owned()
            })
    })
}

fn failed(url: &str, response: &HttpResponse) -> Error {
    Error::Unsupported(format!("{url} answered {}", response.status))
}

impl<'a> Github<'a> {
    #[must_use]
    pub fn new(platform: &'a dyn Platform, token: Option<String>) -> Self {
        Self { platform, token }
    }

    fn get(&self, url: &str) -> Result<HttpResponse> {
        let bearer = self.token.as_ref().map(|token| format!("Bearer {token}"));
        let mut headers = vec![
            ("Accept", "application/vnd.github+json"),
            ("X-GitHub-Api-Version", "2022-11-28"),
        ];
        if let Some(bearer) = &bearer {
            headers.push(("Authorization", bearer.as_str()));
        }
        self.platform.net().request(url, &headers)
    }

    fn json(&self, url: &str) -> Result<(Value, HttpResponse)> {
        let response = self.get(url)?;
        if response.status != 200 {
            return Err(failed(url, &response));
        }
        let value = serde_json::from_str(&response.body).map_err(|err| {
            Error::Unsupported(format!("{url} answered something not JSON: {err}"))
        })?;
        Ok((value, response))
    }

    /// The repository's current `owner/name`, by the id that outlives a rename.
    ///
    /// # Errors
    ///
    /// Fails where GitHub does not answer with the repository.
    pub fn repository_name(&self, id: u64) -> Result<String> {
        let url = format!("{API}/repositories/{id}");
        let (value, _) = self.json(&url)?;
        value
            .get("full_name")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .ok_or_else(|| Error::Unsupported(format!("{url} names no repository")))
    }

    /// Every release, newest first, following the pages GitHub links.
    ///
    /// # Errors
    ///
    /// Fails where a page does not arrive or does not read as releases.
    pub fn releases(&self, repository: &str) -> Result<Vec<GithubRelease>> {
        let mut out = Vec::new();
        let mut next = Some(format!("{API}/repos/{repository}/releases?per_page=100"));
        while let Some(url) = next {
            let (value, response) = self.json(&url)?;
            let Some(entries) = value.as_array() else {
                return Err(Error::Unsupported(format!(
                    "{url} is not a list of releases"
                )));
            };
            for entry in entries {
                out.push(read_release(entry, &url)?);
            }
            next = next_page(&response);
        }
        Ok(out)
    }

    /// A file at a tag, or nothing where the tag has none.
    ///
    /// # Errors
    ///
    /// Fails on any answer but the file or its absence: a release must not read as carrying no
    /// manifest because the host was briefly down.
    pub fn file_at(&self, repository: &str, tag: &str, path: &str) -> Result<Option<String>> {
        let url = format!("https://raw.githubusercontent.com/{repository}/{tag}/{path}");
        let response = self.platform.net().request(&url, &[])?;
        match response.status {
            200 => Ok(Some(response.body)),
            404 => Ok(None),
            _ => Err(failed(&url, &response)),
        }
    }
}

fn read_release(entry: &Value, url: &str) -> Result<GithubRelease> {
    let text = |key: &str| entry.get(key).and_then(Value::as_str);
    let Some(tag) = text("tag_name") else {
        return Err(Error::Unsupported(format!(
            "{url} lists a release with no tag"
        )));
    };
    let mut assets = Vec::new();
    for asset in entry
        .get("assets")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        let (Some(name), Some(download), Some(size)) = (
            asset.get("name").and_then(Value::as_str),
            asset.get("browser_download_url").and_then(Value::as_str),
            asset.get("size").and_then(Value::as_u64),
        ) else {
            return Err(Error::Unsupported(format!(
                "{url} lists an asset of {tag} without a name, address or size"
            )));
        };
        assets.push(GithubAsset {
            name: name.to_owned(),
            url: download.to_owned(),
            size,
            digest: asset
                .get("digest")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
        });
    }
    Ok(GithubRelease {
        tag: tag.to_owned(),
        prerelease: entry
            .get("prerelease")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        draft: entry.get("draft").and_then(Value::as_bool).unwrap_or(false),
        published: text("published_at").unwrap_or_default().to_owned(),
        assets,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use zax_platform::memory::{MemoryOptions, MemoryPlatform, Response};

    fn page(body: &str, next: Option<&str>) -> Response {
        Response::Full(HttpResponse {
            status: 200,
            headers: next
                .map(|url| vec![("link".to_owned(), format!("<{url}>; rel=\"next\""))])
                .unwrap_or_default(),
            body: body.to_owned(),
        })
    }

    #[test]
    fn every_page_is_followed_and_the_token_sent() {
        let first = "https://api.github.com/repos/o/a/releases?per_page=100";
        let second = "https://api.github.com/repos/o/a/releases?per_page=100&page=2";
        let platform = MemoryPlatform::new(MemoryOptions {
            responses: BTreeMap::from([
                (
                    first.to_owned(),
                    page(
                        r#"[{"tag_name":"v2","prerelease":true,"assets":[]}]"#,
                        Some(second),
                    ),
                ),
                (
                    second.to_owned(),
                    page(r#"[{"tag_name":"v1","assets":[]}]"#, None),
                ),
            ]),
            ..MemoryOptions::default()
        });
        let releases = Github::new(&platform, Some("t".to_owned()))
            .releases("o/a")
            .expect("both pages");
        let tags: Vec<&str> = releases.iter().map(|one| one.tag.as_str()).collect();
        assert_eq!(tags, ["v2", "v1"]);
        assert!(releases[0].prerelease);
        let sent = &platform.records().requested[0].1;
        assert!(
            sent.iter()
                .any(|(name, value)| name == "Authorization" && value == "Bearer t"),
            "{sent:?}"
        );
    }

    #[test]
    fn a_file_the_tag_lacks_is_nothing_and_any_other_failure_is_a_failure() {
        let platform = MemoryPlatform::new(MemoryOptions {
            responses: BTreeMap::from([
                (
                    "https://raw.githubusercontent.com/o/a/v1/f2mod.yml".to_owned(),
                    Response::Status(404),
                ),
                (
                    "https://raw.githubusercontent.com/o/a/v2/f2mod.yml".to_owned(),
                    Response::Status(503),
                ),
            ]),
            ..MemoryOptions::default()
        });
        let github = Github::new(&platform, None);
        assert_eq!(
            github.file_at("o/a", "v1", "f2mod.yml").expect("absent"),
            None
        );
        assert!(github.file_at("o/a", "v2", "f2mod.yml").is_err());
    }
}

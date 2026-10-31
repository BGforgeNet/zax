use std::collections::BTreeMap;
use std::path::Path;

use serde_json::{Value, json};
use zax_fallout2::index::{Channel, read_index, read_release};
use zax_platform::memory::{Content, MemoryOptions, MemoryPlatform, Response};
use zax_platform::net::HttpResponse;

use super::*;
use crate::source::{EditionOrder, Source};

const REPO: &str = "o/ecco";
const ID: u64 = 7;

fn source() -> Source {
    Source {
        id: "ecco".to_owned(),
        repository: REPO.to_owned(),
        repository_id: ID,
        name: "EcCo".to_owned(),
        base: false,
        line: None,
        document: None,
        companions: Vec::new(),
        grants: Vec::new(),
        order: None,
    }
}

fn asset(name: &str, digest: Option<&str>) -> Value {
    json!({
        "name": name,
        "browser_download_url": format!("https://github.com/{REPO}/releases/download/{name}"),
        "size": 7,
        "digest": digest,
    })
}

fn release(tag: &str, prerelease: bool, assets: Vec<Value>) -> Value {
    json!({
        "tag_name": tag, "prerelease": prerelease, "draft": false,
        "published_at": "2026-10-01T00:00:00Z", "assets": assets,
    })
}

const MANIFEST: &str = "spec: 1\ngame: fallout2\nid: ecco\nname: EcCo\n";

struct World {
    repository: String,
    responses: BTreeMap<String, Response>,
    downloads: BTreeMap<String, Content>,
}

impl World {
    fn new(repository: &str, releases: &[Value]) -> Self {
        let mut responses = BTreeMap::new();
        responses.insert(
            format!("https://api.github.com/repositories/{ID}"),
            Response::Body(json!({ "full_name": repository }).to_string()),
        );
        responses.insert(
            format!("https://api.github.com/repos/{repository}/releases?per_page=100"),
            Response::Full(HttpResponse {
                status: 200,
                headers: Vec::new(),
                body: Value::Array(releases.to_vec()).to_string(),
            }),
        );
        Self {
            repository: repository.to_owned(),
            responses,
            downloads: BTreeMap::new(),
        }
    }

    fn manifest(mut self, tag: &str, text: Option<&str>) -> Self {
        self.responses.insert(
            format!(
                "https://raw.githubusercontent.com/{}/{tag}/f2mod.yml",
                self.repository
            ),
            text.map_or(Response::Status(404), |text| {
                Response::Body(text.to_owned())
            }),
        );
        self
    }

    fn bytes(mut self, name: &str, payload: &str) -> Self {
        self.downloads.insert(
            format!("https://github.com/{REPO}/releases/download/{name}"),
            Content::Text(payload.to_owned()),
        );
        self
    }

    fn platform(self) -> MemoryPlatform {
        MemoryPlatform::new(MemoryOptions {
            responses: self.responses,
            downloads: self.downloads,
            ..MemoryOptions::default()
        })
    }
}

fn run(platform: &MemoryPlatform, sources: &[Source], state: &mut State) -> Built {
    platform
        .fs()
        .mkdir(Path::new("/work"))
        .expect("a work directory");
    build(
        platform,
        &Github::new(platform, None),
        sources,
        state,
        "2026-10-31T00:00:00Z",
        Path::new("/work"),
    )
    .expect("a build")
}

const DIGEST: &str = "sha256:ABCDEF";

#[test]
fn a_release_is_written_with_every_value_explicit_and_reads_back_in_zax() {
    let platform = World::new(
        REPO,
        &[release(
            "v1.0",
            false,
            vec![asset("ecco.zip", Some(DIGEST))],
        )],
    )
    .manifest("v1.0", Some(MANIFEST))
    .platform();
    let built = run(&platform, &[source()], &mut State::default());

    // Through the reader ZAX uses, from the published text.
    let index = read_index(&serde_json::to_string(&built.index).expect("json")).expect("an index");
    let listed = &index.mods[0];
    let indexed = &listed.releases[0];
    assert_eq!((indexed.version.as_str(), indexed.rank), ("1.0", 1));
    assert_eq!(indexed.channel, Channel::Stable);
    assert!(
        indexed.manifest.contains("archive: ecco.zip"),
        "{}",
        indexed.manifest
    );
    let read = read_release(listed, indexed).expect("ZAX reads it");
    assert_eq!(read.manifest.archive.as_deref(), Some("ecco.zip"));
    assert_eq!(read.assets[0].digest.as_deref(), Some("sha256:abcdef"));
}

#[test]
fn a_prerelease_is_listed_for_testers_and_ranks_below_its_final_release() {
    let platform = World::new(
        REPO,
        &[
            release("v2.0-rc1", true, vec![asset("ecco.zip", Some(DIGEST))]),
            release("v2.0", false, vec![asset("ecco.zip", Some(DIGEST))]),
            release("v1.10", false, vec![asset("ecco.zip", Some(DIGEST))]),
            release("v1.9", false, vec![asset("ecco.zip", Some(DIGEST))]),
        ],
    )
    .manifest("v2.0-rc1", Some(MANIFEST))
    .manifest("v2.0", Some(MANIFEST))
    .manifest("v1.10", Some(MANIFEST))
    .manifest("v1.9", Some(MANIFEST))
    .platform();
    let built = run(&platform, &[source()], &mut State::default());
    let order: Vec<(&str, u64, Channel)> = built.index.mods[0]
        .releases
        .iter()
        .map(|one| (one.version.as_str(), one.rank, one.channel))
        .collect();
    assert_eq!(
        order,
        [
            ("2.0", 4, Channel::Stable),
            ("2.0-rc1", 3, Channel::Testing),
            ("1.10", 2, Channel::Stable),
            ("1.9", 1, Channel::Stable),
        ]
    );
}

#[test]
fn an_asset_with_no_stated_digest_is_hashed_once_and_remembered() {
    let world = || {
        World::new(
            REPO,
            &[release("v1.0", false, vec![asset("ecco.zip", None)])],
        )
        .manifest("v1.0", Some(MANIFEST))
        .bytes("ecco.zip", "payload")
    };
    let mut state = State::default();
    let first = world().platform();
    let built = run(&first, &[source()], &mut state);
    let sha256 = built.index.mods[0].releases[0].assets[0].sha256.clone();
    assert_eq!(sha256.len(), 64);
    assert_eq!(first.records().downloaded.len(), 1);
    assert!(
        first
            .fs()
            .stat(Path::new("/work/ecco.zip"))
            .expect("stat")
            .is_none()
    );

    let second = world().platform();
    let again = run(&second, &[source()], &mut state);
    assert_eq!(again.index.mods[0].releases[0].assets[0].sha256, sha256);
    assert!(
        second.records().downloaded.is_empty(),
        "the stored hash answers"
    );
}

#[test]
fn an_asset_replaced_after_publication_skips_its_release() {
    let mut state = State::default();
    state.hashes.insert(
        format!("{ID}/v1.0/ecco.zip"),
        StoredHash {
            sha256: "abcdef".to_owned(),
            size: 7,
        },
    );
    let platform = World::new(
        REPO,
        &[release(
            "v1.0",
            false,
            vec![asset("ecco.zip", Some("sha256:fedcba"))],
        )],
    )
    .manifest("v1.0", Some(MANIFEST))
    .platform();
    let built = run(&platform, &[source()], &mut state);
    assert!(built.index.mods[0].releases.is_empty());
    assert!(
        built.index.mods[0].skipped[0]
            .reason
            .contains("changed after"),
        "{:?}",
        built.index.mods[0].skipped
    );
    assert_eq!(
        state.hashes[&format!("{ID}/v1.0/ecco.zip")].sha256,
        "abcdef"
    );
}

#[test]
fn a_refused_manifest_or_a_missing_one_is_skipped_with_its_reason() {
    let platform = World::new(
        REPO,
        &[
            release("v2.0", false, vec![asset("ecco.zip", Some(DIGEST))]),
            release("v1.0", false, vec![asset("ecco.zip", Some(DIGEST))]),
        ],
    )
    .manifest(
        "v2.0",
        Some("spec: 1\ngame: fallout2\nid: ecco\nname: EcCo\nlater: 1\n"),
    )
    .manifest("v1.0", None)
    .platform();
    let skipped = run(&platform, &[source()], &mut State::default())
        .index
        .mods
        .remove(0)
        .skipped;
    assert_eq!(skipped.len(), 2);
    assert!(
        skipped[0].reason.contains("unknown field \"later\""),
        "{skipped:?}"
    );
    assert!(
        skipped[1].reason.contains("publishes no f2mod.yml"),
        "{skipped:?}"
    );
}

#[test]
fn a_maintainers_document_stands_in_with_companions_set_aside_and_installers_named() {
    let document = "spec: 1\ngame: fallout2\nid: ecco\nname: EcCo\ntype: base\nbecomes: fallout2rpu\n\
                    installer.windows.built-with: inno\ninstaller.other.run: install.sh\n";
    let platform = World::new(
        REPO,
        &[release(
            "v2.4.34",
            false,
            vec![
                asset("ecco_v2.4.34.exe", Some(DIGEST)),
                asset("ecco_v2.4.34.zip", Some(DIGEST)),
                asset("ecco_v2.4.34_translations.zip", Some(DIGEST)),
            ],
        )],
    )
    .manifest("v2.4.34", None)
    .platform();
    let carried = Source {
        base: true,
        document: Some(document.to_owned()),
        companions: vec!["_translations.zip".to_owned()],
        ..source()
    };
    let built = run(&platform, &[carried], &mut State::default());
    let listed = &built.index.mods[0];
    let indexed = &listed.releases[0];
    assert_eq!(indexed.requires, ["base.inno", "base.script"]);
    let names: Vec<&str> = indexed.assets.iter().map(|one| one.name.as_str()).collect();
    // The sole archive is also the default payload, as it is for any manifest, so it is met first.
    assert_eq!(names, ["ecco_v2.4.34.zip", "ecco_v2.4.34.exe"]);
    let read = read_release(listed, indexed).expect("ZAX reads it");
    let installer = read.manifest.installer.expect("an installer");
    assert_eq!(
        installer.windows.and_then(|one| one.asset).as_deref(),
        Some("ecco_v2.4.34.exe")
    );
    assert_eq!(
        installer.other.and_then(|one| one.asset).as_deref(),
        Some("ecco_v2.4.34.zip")
    );
}

#[test]
fn a_line_takes_only_its_own_releases_and_a_renamed_repository_is_followed_by_id() {
    // Only the renamed repository answers: the source's old name is never asked.
    let platform = World::new(
        "o/renamed",
        &[
            release("v2.4.34", false, vec![asset("ecco.zip", Some(DIGEST))]),
            release("v2.3.34", false, vec![asset("ecco.zip", Some(DIGEST))]),
        ],
    )
    .manifest("v2.4.34", Some(MANIFEST))
    .manifest("v2.3.34", Some(MANIFEST))
    .platform();
    let lined = Source {
        line: Some(IndexedLine {
            prefix: "2.4.".to_owned(),
            counter: false,
        }),
        ..source()
    };
    let built = run(&platform, &[lined], &mut State::default());
    let versions: Vec<&str> = built.index.mods[0]
        .releases
        .iter()
        .map(|one| one.version.as_str())
        .collect();
    assert_eq!(versions, ["2.4.34"]);
    assert_eq!(built.index.mods[0].requires, ["line"]);
    assert!(built.notes[0].contains("o/renamed"), "{:?}", built.notes);
}

#[test]
fn the_editions_orders_are_carried_with_what_they_agree_on() {
    let platform = World::new(REPO, &[]).platform();
    let rpu = Source {
        order: Some(EditionOrder {
            game: "fallout2rpu".to_owned(),
            entries: vec!["a.dat".to_owned(), "b.dat".to_owned(), "c.dat".to_owned()],
        }),
        ..source()
    };
    let upu = Source {
        id: "upu".to_owned(),
        order: Some(EditionOrder {
            game: "fallout2upu".to_owned(),
            entries: vec!["C.dat".to_owned(), "a.dat".to_owned()],
        }),
        ..source()
    };
    let built = run(&platform, &[rpu, upu], &mut State::default());
    assert_eq!(built.index.orders["shared"], ["a.dat", "c.dat"]);
    assert_eq!(built.index.orders["fallout2upu"], ["C.dat", "a.dat"]);
}

#[test]
fn versions_with_a_suffix_order_below_the_bare_version() {
    assert_eq!(
        compare_release_versions(None, "2.0-rc1", "2.0"),
        Ordering::Less
    );
    assert_eq!(
        compare_release_versions(None, "1.10-fix", "1.9"),
        Ordering::Greater
    );
    assert_eq!(
        compare_release_versions(None, "4.5", "4.5.0"),
        Ordering::Equal
    );
    let line = IndexedLine {
        prefix: "2.3.".to_owned(),
        counter: true,
    };
    assert_eq!(
        compare_release_versions(Some(&line), "30", "2.3.34"),
        Ordering::Less
    );
}

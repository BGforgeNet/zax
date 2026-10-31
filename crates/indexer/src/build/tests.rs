use std::collections::BTreeMap;

use serde_json::{Value, json};
use zax_fallout2::index::{read_index, read_release};
use zax_platform::memory::{MemoryOptions, MemoryPlatform, Response};
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

    fn platform(self) -> MemoryPlatform {
        MemoryPlatform::new(MemoryOptions {
            responses: self.responses,
            ..MemoryOptions::default()
        })
    }
}

fn run(platform: &MemoryPlatform, sources: &[Source]) -> Built {
    build(
        &Github::new(platform, None),
        sources,
        "2026-10-31T00:00:00Z",
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
    let built = run(&platform, &[source()]);

    // Through the reader ZAX uses, from the published text.
    let index = read_index(&serde_json::to_string(&built.index).expect("json")).expect("an index");
    let listed = &index.mods[0];
    let indexed = &listed.releases[0];
    assert_eq!((indexed.version.as_str(), indexed.rank), ("1.0", 1));
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
fn a_prerelease_is_left_out_and_the_final_releases_are_ranked() {
    // No manifest is registered for the prerelease: asking for it would fail the build.
    let platform = World::new(
        REPO,
        &[
            release("v2.0-rc1", true, vec![asset("ecco.zip", Some(DIGEST))]),
            release("v2.0", false, vec![asset("ecco.zip", Some(DIGEST))]),
            release("v1.10", false, vec![asset("ecco.zip", Some(DIGEST))]),
            release("v1.9", false, vec![asset("ecco.zip", Some(DIGEST))]),
        ],
    )
    .manifest("v2.0", Some(MANIFEST))
    .manifest("v1.10", Some(MANIFEST))
    .manifest("v1.9", Some(MANIFEST))
    .platform();
    let built = run(&platform, &[source()]);
    let order: Vec<(&str, u64)> = built.index.mods[0]
        .releases
        .iter()
        .map(|one| (one.version.as_str(), one.rank))
        .collect();
    assert_eq!(order, [("2.0", 3), ("1.10", 2), ("1.9", 1)]);
}

#[test]
fn a_release_without_digests_is_left_out_unread_and_counted() {
    // No manifest is registered for v1.0: a release with no digest at all is not asked about further.
    let platform = World::new(
        REPO,
        &[
            release(
                "v2.0",
                false,
                vec![
                    asset("ecco.zip", Some(DIGEST)),
                    asset("ecco_extra.zip", None),
                ],
            ),
            release("v1.0", false, vec![asset("ecco.zip", None)]),
        ],
    )
    .manifest(
        "v2.0",
        Some("spec: 1\ngame: fallout2\nid: ecco\nname: EcCo\narchive: ecco_extra.zip\n"),
    )
    .platform();
    let built = run(&platform, &[source()]);
    assert!(built.index.mods[0].releases.is_empty());
    assert!(
        built.notes[0].contains("ecco v2.0") && built.notes[0].contains("ecco_extra.zip"),
        "{:?}",
        built.notes
    );
    assert!(
        built.notes[1].contains("older than GitHub's digests: 1"),
        "{:?}",
        built.notes
    );
    assert!(platform.records().downloaded.is_empty());
}

#[test]
fn a_refused_manifest_or_a_missing_one_is_left_out_with_its_reason() {
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
    let built = run(&platform, &[source()]);
    assert!(built.index.mods[0].releases.is_empty());
    let notes = &built.notes;
    assert_eq!(notes.len(), 2);
    assert!(
        notes[0].contains("ecco v2.0") && notes[0].contains("unknown field \"later\""),
        "{notes:?}"
    );
    assert!(
        notes[1].contains("ecco v1.0") && notes[1].contains("publishes no f2mod.yml"),
        "{notes:?}"
    );
}

#[test]
fn a_version_the_file_states_against_its_tag_is_left_out() {
    let platform = World::new(
        REPO,
        &[
            release("v2.0", false, vec![asset("ecco.zip", Some(DIGEST))]),
            release("v1.0", false, vec![asset("ecco.zip", Some(DIGEST))]),
        ],
    )
    .manifest("v2.0", Some(&format!("{MANIFEST}version: '1.9'\n")))
    .manifest("v1.0", Some(&format!("{MANIFEST}version: '1.0'\n")))
    .platform();
    let built = run(&platform, &[source()]);
    let versions: Vec<&str> = built.index.mods[0]
        .releases
        .iter()
        .map(|one| one.version.as_str())
        .collect();
    // Agreeing with the tag is fine; disagreeing puts two numbers on one release.
    assert_eq!(versions, ["1.0"]);
    assert!(
        built.notes[0].contains("states version 1.9, and its tag says 2.0"),
        "{:?}",
        built.notes
    );
}

#[test]
fn a_repositorys_own_file_may_not_describe_a_base_mod_but_the_maintainers_document_may() {
    let base = "spec: 1\ngame: fallout2\nid: ecco\nname: EcCo\ntype: base\nbecomes: fallout2rpu\n\
                installer.other.run: install.sh\n";
    let world = || {
        World::new(
            REPO,
            &[release(
                "v1.0",
                false,
                vec![asset("ecco.zip", Some(DIGEST))],
            )],
        )
    };
    let published = world().manifest("v1.0", Some(base)).platform();
    let built = run(&published, &[source()]);
    assert!(built.index.mods[0].releases.is_empty());
    assert!(
        built.notes[0].contains("describes a base mod"),
        "{:?}",
        built.notes
    );

    let carried = world().manifest("v1.0", None).platform();
    let maintained = Source {
        base: true,
        document: Some(base.to_owned()),
        ..source()
    };
    let built = run(&carried, &[maintained]);
    assert_eq!(built.index.mods[0].releases.len(), 1, "{:?}", built.notes);
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
    let built = run(&platform, &[carried]);
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
    let built = run(&platform, &[lined]);
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
    let built = run(&platform, &[rpu, upu]);
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

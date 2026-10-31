//! The real source files, built against GitHub's answers captured in `fixtures/index/github/`, and
//! the result held to the pinned `fixtures/index/v1/index.json` - and to `fixtures/preview/index.json`,
//! the same build with FO2tweaks described by `fixtures/fo2tweaks/f2mod.yml`, which the browser preview
//! serves so a mod with a settings surface is there to show.
//!
//! To re-pin after a deliberate change to the sources, the captures or the indexer, run the tests
//! with `ZAX_PIN_INDEX=1` set: the pins are then written instead of compared.

#![expect(
    clippy::expect_used,
    reason = "a panicking expect in an integration test is the test failing, with its message as the report"
)]

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use zax_fallout2::index::{Index, IndexedMod, read_index, read_release};
use zax_fallout2::manifest::{ManifestDefaults, ModType, parse_manifest_with_grants};
use zax_fallout2::mod_ini::{IniMatch, check_mod_ini};
use zax_fallout2::recommended_order::SHARED_ORDER;
use zax_indexer::build::{Built, build};
use zax_indexer::github::Github;
use zax_indexer::source::{Source, parse_source};
use zax_platform::memory::{MemoryOptions, MemoryPlatform, Response};

const GENERATED: &str = "2026-10-31T00:00:00Z";

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/index")
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_else(|err| panic!("{}: {err}", path.display()))
}

fn sources() -> Vec<Source> {
    let mut paths: Vec<PathBuf> = fs::read_dir(fixtures().join("sources"))
        .expect("the sources directory")
        .map(|entry| entry.expect("an entry").path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "yml"))
        .collect();
    paths.sort();
    paths
        .iter()
        .map(|path| {
            let name = path.file_name().expect("a name").to_string_lossy();
            parse_source(&read(path), &name).unwrap_or_else(|err| panic!("{err}"))
        })
        .collect()
}

/// GitHub as captured: `repositories/<id>` is `repository-<id>.json` and a repository's release
/// listing is `releases-<owner>-<name>.json`. None of the followed repositories publishes an
/// `f2mod.yml`, so that file answers 404 at every tag.
fn github_platform(sources: &[Source]) -> MemoryPlatform {
    let github = fixtures().join("github");
    let mut responses = BTreeMap::new();
    for source in sources {
        responses.insert(
            format!(
                "https://api.github.com/repositories/{}",
                source.repository_id
            ),
            Response::Body(read(
                &github.join(format!("repository-{}.json", source.repository_id)),
            )),
        );
        let listing = read(&github.join(format!(
            "releases-{}.json",
            source.repository.replace('/', "-")
        )));
        let releases: Value = serde_json::from_str(&listing).expect("a listing");
        for release in releases.as_array().expect("a list") {
            let tag = release["tag_name"].as_str().expect("a tag");
            responses.insert(
                format!(
                    "https://raw.githubusercontent.com/{}/{tag}/f2mod.yml",
                    source.repository
                ),
                Response::Status(404),
            );
        }
        responses.insert(
            format!(
                "https://api.github.com/repos/{}/releases?per_page=100",
                source.repository
            ),
            Response::Body(listing),
        );
    }
    MemoryPlatform::new(MemoryOptions {
        responses,
        ..MemoryOptions::default()
    })
}

fn built_from(sources: &[Source]) -> Built {
    let platform = github_platform(sources);
    build(&Github::new(&platform, None), sources, GENERATED).expect("a build")
}

fn built() -> Built {
    built_from(&sources())
}

fn published(built: &Built) -> String {
    let index = serde_json::to_string_pretty(&built.index).expect("json");
    format!("{index}\n")
}

fn held_to_pin(text: &str, pin: &Path) {
    if std::env::var_os("ZAX_PIN_INDEX").is_some() {
        fs::create_dir_all(pin.parent().expect("a directory")).expect("a directory");
        fs::write(pin, text).expect("the pin");
        return;
    }
    assert!(
        text == read(pin),
        "the index differs from {}; re-pin with ZAX_PIN_INDEX=1 if that is intended",
        pin.display()
    );
}

#[test]
fn the_real_sources_build_the_pinned_index() {
    held_to_pin(&published(&built()), &fixtures().join("v1/index.json"));
}

/// The real sources with FO2tweaks described by the manifest the fixtures hold for it.
fn preview_sources() -> Vec<Source> {
    let described = read(&fixtures().join("../fo2tweaks/f2mod.yml"));
    sources()
        .into_iter()
        .map(|source| {
            if source.id == "fo2tweaks" {
                Source {
                    document: Some(described.clone()),
                    ..source
                }
            } else {
                source
            }
        })
        .collect()
}

#[test]
fn the_preview_serves_the_real_index_with_fo2tweaks_described() {
    let built = built_from(&preview_sources());
    let listed = indexed(&built.index, "fo2tweaks");
    assert!(!listed.releases.is_empty(), "{:?}", built.notes);
    held_to_pin(
        &published(&built),
        &fixtures().join("../preview/index.json"),
    );
}

/// What each base mod's release ships under `mods/`, verbatim.
fn shipped(file: &str) -> Option<Vec<u8>> {
    let at = match file {
        "mods/upu.ini" => "upu/mods/upu.ini",
        "mods/rpu.ini" => "rpu/mods/rpu.ini",
        _ => return None,
    };
    fs::read(fixtures().join("..").join(at)).ok()
}

#[test]
fn every_carried_document_reads_as_its_own_base_mod_and_names_no_installer_asset() {
    let carried: Vec<Source> = sources()
        .into_iter()
        .filter(|source| source.document.is_some())
        .collect();
    let mut described = Vec::new();
    for source in carried {
        let text = source.document.as_deref().expect("a document");
        let manifest = parse_manifest_with_grants(
            text.as_bytes(),
            &ManifestDefaults {
                version: Some("1.0".to_owned()),
                archive: None,
            },
            &source.grants,
        )
        .unwrap_or_else(|err| panic!("{}: {err}", source.id));
        assert_eq!(manifest.id, source.id, "the document declares its own id");
        assert_eq!(
            manifest.mod_type == ModType::Base,
            source.base,
            "{}",
            source.id
        );
        // The release is what knows the version in an asset's name, so the indexer infers it.
        let installer = manifest.installer.as_ref();
        assert_eq!(
            installer.and_then(|one| one.windows.as_ref()?.asset.as_ref()),
            None,
            "{}",
            source.id
        );
        assert_eq!(
            installer.and_then(|one| one.other.as_ref()?.asset.as_ref()),
            None,
            "{}",
            source.id
        );
        // Nothing at install compares a described setting with the ini the release ships, so a key
        // described here and missing there would be a control writing a line the mod never reads.
        if !manifest.settings.is_empty() {
            let report = check_mod_ini(&manifest, &shipped, IniMatch::Hard);
            assert!(
                report.mismatches.is_empty() && report.undescribed == 0,
                "{}: {report:?}",
                source.id
            );
            described.push(source.id.clone());
        }
    }
    // RPU's two lines and UPU describe the inis they ship; a check that ran over none proves nothing.
    assert_eq!(described, ["rpu23", "rpu24", "upu"]);
}

#[test]
fn the_editions_agree_about_where_the_shared_mods_go() {
    let index = read_index(&read(&fixtures().join("v1/index.json"))).expect("the pinned index");
    let shared = &index.orders[SHARED_ORDER];
    let upu = &index.orders["fallout2upu"];
    // A disagreement would otherwise be settled silently in RPU's favour.
    let in_upu: Vec<usize> = shared
        .iter()
        .map(|name| {
            upu.iter()
                .position(|held| held.eq_ignore_ascii_case(name))
                .expect("shared means UPU names it")
        })
        .collect();
    assert!(
        in_upu.windows(2).all(|pair| pair[0] < pair[1]),
        "{in_upu:?}"
    );
    // `rpu.dat` and the `rpu_*` translations are RPU's own, so UPU names none of them.
    assert!(
        !shared
            .iter()
            .any(|name| name == "rpu.dat" || name == "rpu_czech.dat")
    );
    assert!(shared.iter().any(|name| name == "party_orders.dat"));
}

fn indexed<'a>(index: &'a Index, id: &str) -> &'a IndexedMod {
    index
        .mods
        .iter()
        .find(|one| one.id == id)
        .unwrap_or_else(|| panic!("{id} is not in the index"))
}

fn versions(listed: &IndexedMod) -> Vec<&str> {
    listed
        .releases
        .iter()
        .map(|release| release.version.as_str())
        .collect()
}

#[test]
fn every_pinned_release_reads_back_and_the_expected_mods_appear() {
    let index = read_index(&read(&fixtures().join("v1/index.json"))).expect("the pinned index");
    for listed in &index.mods {
        for release in &listed.releases {
            read_release(listed, release)
                .unwrap_or_else(|err| panic!("{} {}: {err}", listed.id, release.version));
        }
    }

    assert_eq!(versions(indexed(&index, "rpu23")), ["2.3.34"]);
    assert_eq!(versions(indexed(&index, "rpu24")), ["2.4.34"]);
    assert_eq!(versions(indexed(&index, "upu")), ["34"]);
    // Only the releases GitHub states digests for: the five newest, none of the older ones.
    assert_eq!(
        versions(indexed(&index, "fo1in2")),
        [
            "2.0.3911",
            "1.16.3771",
            "1.15.3735",
            "1.14.3688",
            "1.13.3643"
        ]
    );
    // No document in its source and no f2mod.yml in the repository: nothing describes a release.
    assert!(indexed(&index, "fo2tweaks").releases.is_empty());
}

#[test]
fn the_build_names_what_it_left_out() {
    let notes = built().notes;
    assert!(
        notes
            .iter()
            .any(|note| note.contains("fo2tweaks") && note.contains("publishes no f2mod.yml")),
        "{notes:?}"
    );
}

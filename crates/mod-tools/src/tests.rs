use std::collections::BTreeMap;

use super::*;

/// A manifest as an author commits it: no version, the tag supplies one.
const COMMITTED: &str = "spec: 1\nid: demo\nname: Demo\ngame: fallout2\nsettings:\n  \
                         main.on: { kind: bool, label: On, help: Turns it on., default: 1 }\n";

fn files(held: &[(&str, &str)]) -> impl Fn(&str) -> Option<Vec<u8>> {
    let held: BTreeMap<String, Vec<u8>> = held
        .iter()
        .map(|(name, text)| ((*name).to_owned(), text.as_bytes().to_vec()))
        .collect();
    move |name| held.get(name).cloned()
}

#[test]
fn a_committed_manifest_is_described_as_its_release_will_read_it() {
    let lines = describe_manifest(COMMITTED.as_bytes()).expect("accepted");
    assert_eq!(
        lines,
        vec![
            "OK: demo (version from the tag) (pluggable); payload: (payload from the release); \
             1 setting(s), 0 conflict rule(s)"
        ]
    );
}

#[test]
fn a_manifest_stating_its_version_and_archive_reports_both() {
    let text = "spec: 1\nid: demo\nname: Demo\ngame: fallout2\nversion: 1.2\narchive: demo.zip\n";
    let lines = describe_manifest(text.as_bytes()).expect("accepted");
    assert_eq!(
        lines,
        vec!["OK: demo 1.2 (pluggable); payload: demo.zip; 0 setting(s), 0 conflict rule(s)"]
    );
}

#[test]
fn a_refused_manifest_answers_with_the_refusal_of_the_file_as_written() {
    // Refused both ways: the report is the parser's own sentence for the file as committed.
    let text = "spec: 1\nid: Demo\nname: Demo\ngame: fallout2\n";
    let said = describe_manifest(text.as_bytes()).expect_err("refused");
    assert!(said.starts_with("The manifest was refused: "), "{said}");
    assert!(said.contains("\"id\""), "{said}");
}

#[test]
fn parts_are_listed_with_the_ids_every_later_release_has_to_keep() {
    let text = "spec: 1\nid: demo\nname: Demo\ngame: fallout2\nversion: 1.0\npart-groups:\n  - id: look\n    \
                label: Look\n    pick: one\nparts:\n  - id: a\n    group: look\n    label: A\n    archive: a.zip\n  \
                - id: b\n    group: look\n    label: B\n    archive: b.zip\n";
    let lines = describe_manifest(text.as_bytes()).expect("accepted");
    assert_eq!(
        lines,
        vec![
            "OK: demo 1.0 (pluggable); payload: 2 part(s), each naming its own asset; 0 setting(s), \
             0 conflict rule(s)",
            "  Look (pick one): a -> a.zip, b -> b.zip",
        ]
    );
}

#[test]
fn a_mod_that_creates_an_install_says_where_and_what_it_asks_for() {
    let text = "spec: 1\nid: fo1in2\nname: Fallout et tu\ngame: fallout2\nversion: 1.0\ntype: base\n\
                becomes: fo1in2\narchive: Fallout1in2.zip\ncreates.directory: Fallout1in2\ninputs:\n  \
                - id: fallout1\n    label: Your Fallout 1 folder\n    holds: master.dat\n\
                extract-dat.from: fallout1\nextract-dat.list: undat_files.txt\nextract-dat.into: data\n";
    let lines = describe_manifest(text.as_bytes()).expect("accepted");
    assert_eq!(
        lines[1..],
        [
            "  creates Fallout1in2/ beside the install, reporting as fo1in2",
            "  asks for fallout1: Your Fallout 1 folder (master.dat)",
            "  unpacks fallout1's archive into Fallout1in2/data, as undat_files.txt names",
        ]
    );
}

#[test]
fn a_base_mods_installers_are_named_per_route() {
    let text = "spec: 1\nid: upu\nname: UPU\ngame: fallout2\nversion: 1.0\ntype: base\nbecomes: fallout2upu\n\
                installer.windows.built-with: inno\ninstaller.windows.asset: upu.exe\n\
                installer.other.run: upu-install.sh\n";
    let lines = describe_manifest(text.as_bytes()).expect("accepted");
    assert!(
        lines[0].contains("payload: windows: upu.exe, other: (asset from the release);"),
        "{}",
        lines[0]
    );
}

#[test]
fn a_soft_check_passes_over_an_undescribed_entry_and_says_so() {
    let read = files(&[("mods/demo.ini", "[main]\r\non=1\r\nextra=5\r\n")]);
    let checked = check_ini(COMMITTED.as_bytes(), "f2mod.yml", IniMatch::Soft, &read);
    assert_eq!(
        checked,
        Checked {
            ok: true,
            said: vec![
                "OK: 1 setting(s) match mods/demo.ini (soft; 1 entry(ies) not described)."
                    .to_owned()
            ],
            complaints: Vec::new(),
        }
    );
}

#[test]
fn a_hard_check_names_each_mismatch_then_counts_them() {
    let read = files(&[("mods/demo.ini", "[main]\r\non=1\r\nextra=5\r\n")]);
    let checked = check_ini(COMMITTED.as_bytes(), "f2mod.yml", IniMatch::Hard, &read);
    assert!(!checked.ok);
    assert!(checked.said.is_empty());
    assert_eq!(
        checked.complaints,
        vec![
            "mods/demo.ini [main] extra: in the file, not described by the manifest",
            "1 mismatch(es) between f2mod.yml and its ini (hard).",
        ]
    );
}

#[test]
fn a_check_of_a_refused_manifest_complains_with_the_refusal() {
    let checked = check_ini(b"spec: 1\n", "f2mod.yml", IniMatch::Soft, &files(&[]));
    assert!(!checked.ok);
    assert_eq!(checked.complaints.len(), 1);
    assert!(
        checked.complaints[0].starts_with("The manifest was refused: "),
        "{:?}",
        checked.complaints
    );
}

#[test]
fn generate_writes_each_file_the_settings_name() {
    let generated = generate_ini(COMMITTED.as_bytes(), &files(&[])).expect("written");
    assert_eq!(generated.settings, 1);
    assert_eq!(
        generated.files,
        BTreeMap::from([(
            "mods/demo.ini".to_owned(),
            b"[main]\r\n; Turns it on.\r\non=1\r\n".to_vec()
        )])
    );
}

#[test]
fn a_match_is_spelled_soft_or_hard() {
    assert_eq!(ini_match("soft"), Some(IniMatch::Soft));
    assert_eq!(ini_match("hard"), Some(IniMatch::Hard));
    assert_eq!(ini_match("Hard"), None);
}

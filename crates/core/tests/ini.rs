//! Ported from the TypeScript suite that guards the lossless reader. The round-trip properties are
//! the point: a config file belongs to the user, so anything ZAX does not understand has to come
//! back out exactly as it went in.

use std::path::Path;

use proptest::prelude::*;
use zax_core::ini::IniDocument;

/// The fixtures are real config files taken off an install and must stay byte-for-byte as they came.
fn fixture(name: &str) -> Vec<u8> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/f2up")
        .join(name);
    std::fs::read(&path).unwrap_or_else(|err| panic!("reading {}: {err}", path.display()))
}

fn parse(text: &str) -> IniDocument {
    IniDocument::parse(text.as_bytes())
}

// Every input in this file is ASCII, so the decode cannot fail; a panic here is the helper telling
// the author they added a case that needs the byte-level assertions instead.
#[expect(clippy::expect_used)]
fn render(doc: &IniDocument) -> String {
    String::from_utf8(doc.to_bytes()).expect("the test inputs are all ASCII")
}

const SAMPLE: &str = "; header\r\n[Main]\r\nAlpha=1\r\nBeta = 2\r\n\r\n[Other]\r\nGamma=3\r\n";

// --- round-trip ---------------------------------------------------------------------------------

/// The shapes real config files contain: comments, odd spacing, duplicate keys, mixed terminators.
fn ini_text() -> impl Strategy<Value = String> {
    let line = prop_oneof![
        Just(""),
        prop::sample::select(vec!["; a comment", "# another", "   ; indented comment"]),
        prop::sample::select(vec!["[Main]", "[Speed]", "[ Spaced ]", "[]"]),
        prop::sample::select(vec![
            "Key=1",
            "Key = 1",
            "  Key   =   value  ",
            "Key=",
            "Dup=a",
            "Dup=b",
            "Key=a;b",
        ]),
        prop::sample::select(vec!["not an ini line at all", "]broken[", "="]),
    ];
    (
        prop::collection::vec(line, 0..40),
        prop::sample::select(vec!["\n", "\r\n"]),
        any::<bool>(),
    )
        .prop_map(|(lines, eol, trailing)| {
            let mut text = lines.join(eol);
            if trailing {
                text.push_str(eol);
            }
            text
        })
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(500))]

    #[test]
    fn returns_any_input_unchanged(text in ini_text()) {
        prop_assert_eq!(render(&parse(&text)), text);
    }
}

#[test]
fn returns_real_config_files_unchanged_byte_for_byte() {
    for name in ["fallout2.cfg", "f2_res.ini", "ddraw.ini"] {
        let bytes = fixture(name);
        assert_eq!(
            IniDocument::parse(&bytes).to_bytes(),
            bytes,
            "{name} did not round-trip"
        );
    }
}

#[test]
fn preserves_bytes_above_0x7f() {
    // No available fixture carries high bytes, but a localized install can: paths and translation
    // settings are written in a legacy codepage. Decoding those as UTF-8 is irreversible, so the
    // guard is synthesized. 0xc8 0xe3 0xf0 0xfb is cp1251 for a Cyrillic directory name.
    let mut bytes = b"[sound]\r\nmusic_path1=C:\\".to_vec();
    bytes.extend_from_slice(&[0xc8, 0xe3, 0xf0, 0xfb]);
    bytes.extend_from_slice(b"\\music\r\n");

    let mut doc = IniDocument::parse(&bytes);
    assert_eq!(doc.to_bytes(), bytes);

    // The high bytes survive an unrelated edit to the same file.
    doc.set_str("sound", "music_path2", "data/sound/music/");
    let after = doc.to_bytes();
    assert_eq!(&after[..bytes.len()], &bytes[..]);
}

// --- set ----------------------------------------------------------------------------------------

#[test]
fn set_changes_exactly_one_line() {
    let mut doc = parse(SAMPLE);
    doc.set_str("Main", "Alpha", "9");
    let before: Vec<&str> = SAMPLE.split("\r\n").collect();
    let rendered = render(&doc);
    let after: Vec<&str> = rendered.split("\r\n").collect();
    let differing: Vec<&str> = before
        .iter()
        .enumerate()
        .filter(|(i, line)| after.get(*i) != Some(line))
        .map(|(_, line)| *line)
        .collect();
    assert_eq!(differing, vec!["Alpha=1"]);
}

#[test]
fn set_preserves_the_surrounding_spacing_style() {
    let mut doc = parse(SAMPLE);
    doc.set_str("Main", "Beta", "7");
    assert!(render(&doc).contains("Beta = 7"));
}

#[test]
fn set_is_a_no_op_when_the_value_is_unchanged() {
    let mut doc = parse(SAMPLE);
    doc.set_str("Main", "Alpha", "1");
    assert_eq!(render(&doc), SAMPLE);
}

#[test]
fn set_matches_case_insensitively_but_writes_the_original_spelling() {
    let mut doc = parse(SAMPLE);
    doc.set_str("main", "alpha", "5");
    assert!(render(&doc).contains("Alpha=5"));
    assert_eq!(doc.get_str("MAIN", "ALPHA").as_deref(), Some("5"));
}

#[test]
fn set_appends_a_missing_key_to_the_end_of_its_section() {
    let mut doc = parse(SAMPLE);
    doc.set_str("Main", "Delta", "4");
    let rendered = render(&doc);
    let lines: Vec<&str> = rendered.split("\r\n").collect();
    let delta = lines.iter().position(|l| *l == "Delta=4");
    let other = lines.iter().position(|l| *l == "[Other]");
    assert!(delta < other, "{delta:?} should precede {other:?}");
    assert!(delta.is_some(), "the appended key is missing entirely");
}

#[test]
fn set_appends_a_missing_section_at_the_end() {
    let mut doc = parse(SAMPLE);
    doc.set_str("Fresh", "Key", "1");
    assert!(render(&doc).ends_with("[Fresh]\r\nKey=1\r\n"));
}

#[test]
fn set_does_not_splice_onto_a_preceding_line_without_a_terminator() {
    // Real config files need not end with a newline: the bundled ddraw.ini ends
    // "DisablePipboyAlarm=0" with nothing after it, so appending to that section joined the two keys
    // into one unparseable line.
    let mut doc = parse("[Main]\r\nAlpha=1\r\n[Misc]\r\nBeta=2");
    doc.set_str("Misc", "Gamma", "3");
    assert_eq!(
        render(&doc),
        "[Main]\r\nAlpha=1\r\n[Misc]\r\nBeta=2\r\nGamma=3\r\n"
    );
}

#[test]
fn set_appends_cleanly_to_a_real_file_that_ends_without_a_newline() {
    let mut doc = IniDocument::parse(&fixture("ddraw.ini"));
    doc.set_str("Misc", "CombatPanelAnimDelay", "4");
    let text = render(&doc);
    assert!(!text.contains("DisablePipboyAlarm=0CombatPanelAnimDelay"));
    assert!(text.contains("DisablePipboyAlarm=0\r\nCombatPanelAnimDelay=4"));
    assert_eq!(
        IniDocument::parse(text.as_bytes())
            .get_str("Misc", "DisablePipboyAlarm")
            .as_deref(),
        Some("0")
    );
}

#[test]
fn set_does_not_splice_onto_a_final_line_without_a_terminator() {
    let mut doc = parse("[Main]\nAlpha=1");
    doc.set_str("Other", "Beta", "2");
    assert_eq!(render(&doc), "[Main]\nAlpha=1\n[Other]\nBeta=2\n");
}

#[test]
fn set_on_an_empty_document_writes_a_section_and_a_key() {
    let mut doc = parse("");
    doc.set_str("Fresh", "Key", "1");
    assert_eq!(render(&doc), "[Fresh]\nKey=1\n");
}

// --- get ----------------------------------------------------------------------------------------

#[test]
fn get_reads_the_first_occurrence_of_a_duplicated_key() {
    let doc = parse("[S]\nK=first\nK=second\n");
    assert_eq!(doc.get_str("S", "K").as_deref(), Some("first"));
}

#[test]
fn get_answers_none_for_an_absent_section_or_key() {
    let doc = parse("[S]\nK=v\n");
    assert_eq!(doc.get_str("S", "Missing"), None);
    assert_eq!(doc.get_str("Missing", "K"), None);
}

// --- inline comments ----------------------------------------------------------------------------

const INLINE: &str = "[MAPS]\r\nSCROLL_DIST_X=HALF_SCRN ; ORIGINAL 480\r\n";

#[test]
fn an_inline_comment_is_excluded_from_the_value() {
    assert_eq!(
        parse(INLINE).get_str("MAPS", "SCROLL_DIST_X").as_deref(),
        Some("HALF_SCRN")
    );
}

#[test]
fn an_inline_comment_survives_the_value_being_rewritten() {
    let mut doc = parse(INLINE);
    doc.set_str("MAPS", "SCROLL_DIST_X", "FULL_SCRN");
    assert_eq!(
        render(&doc),
        "[MAPS]\r\nSCROLL_DIST_X=FULL_SCRN ; ORIGINAL 480\r\n"
    );
}

#[test]
fn a_separator_inside_a_value_is_not_a_comment() {
    let doc = parse("[S]\nPath=data;mods;patches\nHash=a#b\n");
    assert_eq!(
        doc.get_str("S", "Path").as_deref(),
        Some("data;mods;patches")
    );
    assert_eq!(doc.get_str("S", "Hash").as_deref(), Some("a#b"));
}

#[test]
fn a_real_file_carrying_inline_comments_round_trips() {
    let bytes = fixture("f2_res.ini");
    let doc = IniDocument::parse(&bytes);
    assert_eq!(
        doc.get_str("MAPS", "SCROLL_DIST_X").as_deref(),
        Some("HALF_SCRN")
    );
    assert_eq!(doc.to_bytes(), bytes);
}

// --- structure ----------------------------------------------------------------------------------

#[test]
fn sections_are_listed_once_in_order_of_first_appearance() {
    let doc = parse("[B]\nK=1\n[A]\nK=2\n[b]\nK=3\n");
    assert_eq!(doc.sections(), vec!["B".to_owned(), "A".to_owned()]);
}

#[test]
fn entries_carry_the_comment_block_above_them() {
    let doc = parse("[S]\n; first line\n; second line\nKey=1\n");
    let entries = doc.entries();
    assert_eq!(entries.len(), 1);
    assert_eq!(
        entries[0].comment.as_deref(),
        Some("first line second line")
    );
}

#[test]
fn an_sfall_divider_is_not_documentation() {
    let doc = parse("[S]\n;XXXXXXXXXX\n; real text\nKey=1\n");
    assert_eq!(doc.entries()[0].comment.as_deref(), Some("real text"));
}

#[test]
fn an_entry_with_no_comment_above_it_has_none() {
    let doc = parse("[S]\nKey=1\n");
    assert_eq!(doc.entries()[0].comment, None);
}

#[test]
fn a_line_with_no_separator_is_kept_but_parses_as_nothing() {
    // The shape that made the old TypeScript entry expression backtrack quadratically. Rust parses
    // it in one pass, so this guards the result rather than the timing: a wall-clock assertion here
    // would only measure how loaded the machine is.
    let line = format!("{}{}\n", "a".repeat(400_000), " ".repeat(400_000));
    let doc = IniDocument::parse(line.as_bytes());
    assert_eq!(render(&doc), line);
    assert_eq!(doc.sections(), Vec::<String>::new());
}

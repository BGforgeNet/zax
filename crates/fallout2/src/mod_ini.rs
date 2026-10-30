//! A mod's ini files measured against the settings its manifest describes, and written from them -
//! for authors and their release CI. The application never runs either: at install the release's own
//! file is what deploys, so a schema that drifted from it shows controls for keys the mod never reads,
//! and this is where that is caught.

use std::collections::{BTreeMap, BTreeSet};

use zax_core::catalog::{SettingKind, SettingTarget};
use zax_core::ini::IniDocument;
use zax_core::text::latin1_bytes;
use zax_core::validate::validate;

use crate::manifest::{ModManifest, ModSetting};

/// `Soft` lets the file carry entries the manifest leaves out - a partial schema is valid; `Hard` does
/// not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IniMatch {
    Soft,
    Hard,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IniReport {
    /// Each mismatch, naming the file, the address and what disagrees. Empty is a match.
    pub mismatches: Vec<String>,
    /// Entries the files carry that no setting describes, which only `Hard` counts against them.
    pub undescribed: usize,
    /// The files the settings name, in the order the manifest first names each.
    pub files: Vec<String>,
}

fn fold(text: &str) -> String {
    text.to_lowercase()
}

fn address_key(section: &str, key: &str) -> String {
    format!("{}.{}", fold(section), fold(key))
}

fn own(setting: &ModSetting) -> &SettingTarget {
    setting.def.targets.own()
}

/// The settings by the file they address, each file first named where the manifest first names it.
fn by_file(settings: &[ModSetting]) -> Vec<(String, Vec<&ModSetting>)> {
    let mut out: Vec<(String, Vec<&ModSetting>)> = Vec::new();
    for setting in settings {
        let file = &own(setting).file;
        match out.iter_mut().find(|(held, _)| held == file) {
            Some((_, group)) => group.push(setting),
            None => out.push((file.clone(), vec![setting])),
        }
    }
    out
}

/// Whether the value a file ships is one the setting's control could hold. A bool is judged here rather
/// than in `validate`: an interface toggle can only write its own two spellings, so only a file can hold
/// a third.
fn refusal(setting: &ModSetting, value: &str) -> Option<String> {
    if let SettingKind::Bool {
        on_value,
        off_value,
    } = &setting.def.kind
    {
        return (value != on_value && value != off_value)
            .then(|| format!("Not its on value \"{on_value}\" or its off value \"{off_value}\""));
    }
    match validate(&setting.def, Some(value)) {
        zax_core::validate::Validation::Ok => None,
        zax_core::validate::Validation::Rejected(why) => Some(why),
    }
}

/// Compares every file the settings name against what `read` returns for it, nothing meaning absent.
/// Folded as the engine folds names, so `[Main]` in the file answers for `main` in the manifest.
#[must_use]
pub fn check_mod_ini(
    manifest: &ModManifest,
    read: &dyn Fn(&str) -> Option<Vec<u8>>,
    match_: IniMatch,
) -> IniReport {
    let mut mismatches = Vec::new();
    // A setting this version dropped has no kind to judge a value by, and no file to look for it in.
    // Reported rather than skipped, since a check that passes over part of the schema is a check that
    // passed nothing.
    for gone in &manifest.dropped {
        mismatches.push(format!(
            "\"{}\" cannot be checked: {}",
            gone.address, gone.why
        ));
    }
    let dropped: BTreeSet<String> = manifest
        .dropped
        .iter()
        .map(|gone| fold(&gone.address))
        .collect();

    let grouped = by_file(&manifest.settings);
    let mut undescribed = 0;
    for (file, settings) in &grouped {
        let Some(bytes) = read(file) else {
            mismatches.push(format!(
                "{file}: absent, and the manifest describes {} setting(s) in it",
                settings.len()
            ));
            continue;
        };
        let document = IniDocument::parse(&bytes);
        for setting in settings {
            let target = own(setting);
            let at = format!("{file} [{}] {}", target.section, target.key);
            let Some(value) = document.get(&target.section, &target.key) else {
                mismatches.push(format!(
                    "{at}: described by the manifest, absent from the file"
                ));
                continue;
            };
            let value = zax_core::text::latin1(value);
            if let Some(default) = &setting.default
                && *default != value
            {
                mismatches.push(format!(
                    "{at}: the file ships \"{value}\", the manifest's default is \"{default}\""
                ));
            }
            if let Some(wrong) = refusal(setting, &value) {
                mismatches.push(format!("{at}: the file ships \"{value}\" - {wrong}"));
            }
        }

        let described: BTreeSet<String> = settings
            .iter()
            .map(|setting| {
                let target = own(setting);
                address_key(&target.section, &target.key)
            })
            .collect();
        let entries = document.entries();
        let extra: Vec<&zax_core::ini::Entry> = entries
            .iter()
            .filter(|entry| {
                let at = address_key(&entry.section, &entry.key);
                !described.contains(&at) && !dropped.contains(&at)
            })
            .collect();
        undescribed += extra.len();
        if match_ == IniMatch::Soft {
            continue;
        }
        for entry in extra {
            mismatches.push(format!(
                "{file} [{}] {}: in the file, not described by the manifest",
                entry.section, entry.key
            ));
        }
        // A section with nothing in it names no key, so the pass above cannot see it - and hard means
        // the headers match too.
        let populated: BTreeSet<String> =
            entries.iter().map(|entry| fold(&entry.section)).collect();
        for section in document.sections() {
            if !populated.contains(&fold(&section)) {
                mismatches.push(format!(
                    "{file} [{section}]: an empty section the manifest does not describe"
                ));
            }
        }
    }
    IniReport {
        mismatches,
        undescribed,
        files: grouped.into_iter().map(|(file, _)| file).collect(),
    }
}

/// A number as the manifest would have spelled it: whole where it is whole, so a bound of 100 does not
/// read as 100.
fn number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        format!("{value:.0}")
    } else {
        format!("{value}")
    }
}

/// The line saying which values a setting accepts, where its kind has more to say than its label does.
fn accepts(kind: &SettingKind) -> Option<String> {
    match kind {
        SettingKind::Choice { options } => Some(format!(
            "One of: {}",
            options
                .iter()
                .map(|option| format!("{} ({})", option.value, option.label))
                .collect::<Vec<_>>()
                .join(", ")
        )),
        SettingKind::Scale { max } => Some(format!("0 to {}", number(*max))),
        SettingKind::Int(kind) | SettingKind::Float(kind) => {
            let unit = kind
                .unit
                .as_ref()
                .map_or_else(String::new, |unit| format!(" {unit}"));
            let range = match (kind.min, kind.max) {
                (Some(min), Some(max)) => Some(format!("{} to {}{unit}", number(min), number(max))),
                (Some(min), None) => Some(format!("At least {}{unit}", number(min))),
                (None, Some(max)) => Some(format!("At most {}{unit}", number(max))),
                (None, None) => None,
            };
            let sentinels: Vec<String> = kind
                .sentinels
                .iter()
                .map(|(value, label)| format!("{value} ({label})"))
                .collect();
            match (range, sentinels.is_empty()) {
                (None, true) => None,
                (None, false) => Some(format!("Also: {}", sentinels.join(", "))),
                (Some(range), true) => Some(range),
                (Some(range), false) => Some(format!("{range}, or {}", sentinels.join(", "))),
            }
        }
        SettingKind::Bool { .. } | SettingKind::Text { .. } | SettingKind::Key => None,
    }
}

/// Each non-empty text as `;` comment lines, a multi-line one a line apiece.
fn comments(texts: &[Option<&str>]) -> Vec<String> {
    texts
        .iter()
        .flatten()
        .flat_map(|text| text.split('\n'))
        .filter(|line| !line.trim().is_empty())
        .map(|line| format!("; {}", line.trim_end()))
        .collect()
}

/// The lines unchanged, having checked each character has a latin1 byte. The game's files are bytes
/// read as latin1 everywhere else, so these are written that way too - and a character with none would
/// land as another silently.
fn in_latin1(owner: &str, lines: Vec<String>) -> Result<Vec<String>, String> {
    for line in &lines {
        if let Some(character) = line.chars().find(|c| *c as u32 > 0xff) {
            return Err(format!(
                "{owner}: \"{character}\" has no latin1 byte, the encoding the game reads its ini in."
            ));
        }
    }
    Ok(lines)
}

/// Every file the settings name, written from the manifest alone: a section per `section` under its
/// description, and per setting its help (its label where it has none) and accepted values as comments
/// above `key=default`. Whatever a file held before is replaced, so `existing` is read for its line
/// terminator and nothing else - CRLF where there is no file, as the game's own files have it.
///
/// # Errors
///
/// Answers with wording for the author when the manifest carries a dropped setting, describes no
/// settings, leaves one without a default, or spells a character the game's encoding has no byte for.
pub fn generate_mod_ini(
    manifest: &ModManifest,
    existing: &dyn Fn(&str) -> Option<Vec<u8>>,
) -> Result<BTreeMap<String, Vec<u8>>, String> {
    if !manifest.dropped.is_empty() {
        return Err(format!(
            "Cannot write {}.",
            manifest
                .dropped
                .iter()
                .map(|gone| format!("\"{}\" ({})", gone.address, gone.why))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if manifest.settings.is_empty() {
        return Err(format!(
            "{} describes no settings, so there is no ini to write.",
            manifest.id
        ));
    }
    let valueless: Vec<&str> = manifest
        .settings
        .iter()
        .filter(|setting| setting.default.is_none())
        .map(|setting| setting.def.id.as_str())
        .collect();
    if !valueless.is_empty() {
        return Err(format!(
            "{}: no \"default\" stated, so there is no value to write.",
            valueless.join(", ")
        ));
    }

    let mut out = BTreeMap::new();
    for (file, settings) in by_file(&manifest.settings) {
        let eol = match existing(&file) {
            None => b"\r\n".to_vec(),
            Some(previous) => IniDocument::parse(&previous).dominant_eol().to_vec(),
        };
        // Sections in the order the manifest first names each, as the files are.
        let mut sections: Vec<(String, Vec<&ModSetting>)> = Vec::new();
        for setting in settings {
            let section = own(setting).section.clone();
            match sections.iter_mut().find(|(held, _)| *held == section) {
                Some((_, group)) => group.push(setting),
                None => sections.push((section, vec![setting])),
            }
        }

        let mut lines: Vec<String> = Vec::new();
        for (section, members) in sections {
            if !lines.is_empty() {
                lines.push(String::new());
            }
            let help = manifest
                .section_help
                .as_ref()
                .and_then(|held| held.get(&section))
                .map(String::as_str);
            let mut header = comments(&[help]);
            header.push(format!("[{section}]"));
            lines.extend(in_latin1(&format!("settings.sections.{section}"), header)?);
            for (at, setting) in members.into_iter().enumerate() {
                if at > 0 {
                    lines.push(String::new());
                }
                // The label mostly restates the key in words, so it stands in only where there is no
                // help to write.
                let described = match setting.def.help.as_deref() {
                    Some(help) if !help.trim().is_empty() => help,
                    _ => setting.def.label.as_str(),
                };
                let accepted = accepts(&setting.def.kind);
                let mut block = comments(&[Some(described), accepted.as_deref()]);
                block.push(format!(
                    "{}={}",
                    own(setting).key,
                    setting.default.as_deref().unwrap_or("")
                ));
                lines.extend(in_latin1(&setting.def.id, block)?);
            }
        }
        let mut body = Vec::new();
        for line in lines {
            body.extend_from_slice(&latin1_bytes(&line));
            body.extend_from_slice(&eol);
        }
        out.insert(file, body);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::{ManifestDefaults, parse_manifest};

    const SCHEMA: &str = "spec: 1
id: ecco
name: EcCo
version: 1.0
game: fallout2
type: pluggable
settings.sections.main: How EcCo behaves
settings:
  main.Speed:
    kind: int
    label: Walk speed
    help: How fast the party walks.
    min: 1
    max: 10
    unit: steps
    default: '5'
  main.Enabled:
    kind: bool
    label: On
    on: '1'
    off: '0'
    default: '1'
";

    /// One more entry, whose kind this version has no rule for, so the manifest drops it.
    const LATER: &str = "  main.Later:\n    kind: colour\n    label: Later\n    default: '1'\n";

    fn schema() -> ModManifest {
        parse_manifest(SCHEMA.as_bytes(), &ManifestDefaults::default())
            .expect("a manifest the test writes")
    }

    /// The file the manifest's own settings address.
    fn file_of(manifest: &ModManifest) -> String {
        own(&manifest.settings[0]).file.clone()
    }

    fn reader(files: Vec<(String, &str)>) -> impl Fn(&str) -> Option<Vec<u8>> {
        let held: BTreeMap<String, Vec<u8>> = files
            .into_iter()
            .map(|(name, text)| (name, text.as_bytes().to_vec()))
            .collect();
        move |name: &str| held.get(name).cloned()
    }

    fn nothing() -> impl Fn(&str) -> Option<Vec<u8>> {
        |_: &str| None
    }

    #[test]
    fn a_file_that_matches_the_manifest_reports_nothing() {
        let manifest = schema();
        let file = file_of(&manifest);
        let read = reader(vec![(file.clone(), "[main]\nSpeed=5\nEnabled=1\n")]);
        let report = check_mod_ini(&manifest, &read, IniMatch::Hard);
        assert!(report.mismatches.is_empty(), "{:?}", report.mismatches);
        assert_eq!(report.undescribed, 0);
        assert_eq!(report.files, [file]);
    }

    #[test]
    fn a_section_name_is_folded_as_the_engine_folds_it() {
        let manifest = schema();
        let read = reader(vec![(file_of(&manifest), "[MAIN]\nspeed=5\nENABLED=1\n")]);
        let report = check_mod_ini(&manifest, &read, IniMatch::Hard);
        assert!(report.mismatches.is_empty(), "{:?}", report.mismatches);
    }

    #[test]
    fn a_file_the_manifest_describes_and_the_release_lacks_is_named() {
        let manifest = schema();
        let report = check_mod_ini(&manifest, &nothing(), IniMatch::Soft);
        assert_eq!(report.mismatches.len(), 1);
        assert!(
            report.mismatches[0].contains("absent, and the manifest describes 2 setting(s)"),
            "{:?}",
            report.mismatches
        );
    }

    #[test]
    fn a_key_the_manifest_describes_and_the_file_lacks_is_named() {
        let manifest = schema();
        let read = reader(vec![(file_of(&manifest), "[main]\nSpeed=5\n")]);
        let report = check_mod_ini(&manifest, &read, IniMatch::Soft);
        assert_eq!(report.mismatches.len(), 1);
        assert!(
            report.mismatches[0].contains("Enabled"),
            "{:?}",
            report.mismatches
        );
    }

    #[test]
    fn a_shipped_value_differing_from_the_manifests_default_is_named() {
        let manifest = schema();
        let read = reader(vec![(file_of(&manifest), "[main]\nSpeed=7\nEnabled=1\n")]);
        let report = check_mod_ini(&manifest, &read, IniMatch::Soft);
        assert_eq!(report.mismatches.len(), 1);
        assert!(
            report.mismatches[0].contains("the file ships \"7\", the manifest's default is \"5\""),
            "{:?}",
            report.mismatches
        );
    }

    #[test]
    fn a_bools_third_spelling_is_one_only_a_file_can_hold() {
        // An interface toggle can only ever write its own two.
        let manifest = schema();
        let read = reader(vec![(file_of(&manifest), "[main]\nSpeed=5\nEnabled=yes\n")]);
        let report = check_mod_ini(&manifest, &read, IniMatch::Soft);
        assert!(
            report
                .mismatches
                .iter()
                .any(|said| said.contains("Not its on value")),
            "{:?}",
            report.mismatches
        );
    }

    #[test]
    fn a_value_outside_the_settings_bounds_is_refused() {
        let manifest = schema();
        let read = reader(vec![(file_of(&manifest), "[main]\nSpeed=99\nEnabled=1\n")]);
        let report = check_mod_ini(&manifest, &read, IniMatch::Soft);
        assert!(
            report
                .mismatches
                .iter()
                .any(|said| said.contains("the file ships \"99\"")),
            "{:?}",
            report.mismatches
        );
    }

    #[test]
    fn a_partial_schema_is_valid_under_soft_and_not_under_hard() {
        let manifest = schema();
        let text = "[main]\nSpeed=5\nEnabled=1\nExtra=3\n";
        let read = reader(vec![(file_of(&manifest), text)]);
        let soft = check_mod_ini(&manifest, &read, IniMatch::Soft);
        assert!(soft.mismatches.is_empty(), "{:?}", soft.mismatches);
        assert_eq!(soft.undescribed, 1);
        let hard = check_mod_ini(&manifest, &read, IniMatch::Hard);
        assert_eq!(hard.undescribed, 1);
        assert!(
            hard.mismatches
                .iter()
                .any(|said| said.contains("not described by the manifest")),
            "{:?}",
            hard.mismatches
        );
    }

    #[test]
    fn an_empty_section_names_no_key_so_hard_looks_for_it_separately() {
        let manifest = schema();
        let text = "[main]\nSpeed=5\nEnabled=1\n[spare]\n";
        let read = reader(vec![(file_of(&manifest), text)]);
        let hard = check_mod_ini(&manifest, &read, IniMatch::Hard);
        assert!(
            hard.mismatches
                .iter()
                .any(|said| said.contains("an empty section")),
            "{:?}",
            hard.mismatches
        );
    }

    #[test]
    fn a_setting_this_version_dropped_is_reported_rather_than_skipped() {
        // A check that passes over part of the schema is a check that passed nothing.
        let text = format!("{SCHEMA}{LATER}");
        let manifest = parse_manifest(text.as_bytes(), &ManifestDefaults::default())
            .expect("an unknown type is dropped rather than refused");
        assert_eq!(manifest.dropped.len(), 1);
        let read = reader(vec![(file_of(&manifest), "[main]\nSpeed=5\nEnabled=1\n")]);
        let report = check_mod_ini(&manifest, &read, IniMatch::Soft);
        assert!(
            report.mismatches[0].contains("cannot be checked"),
            "{:?}",
            report.mismatches
        );
    }

    #[test]
    fn a_dropped_address_is_not_also_counted_as_undescribed() {
        let text = format!("{SCHEMA}{LATER}");
        let manifest = parse_manifest(text.as_bytes(), &ManifestDefaults::default())
            .expect("an unknown type is dropped rather than refused");
        let read = reader(vec![(
            file_of(&manifest),
            "[main]\nSpeed=5\nEnabled=1\nLater=1\n",
        )]);
        let report = check_mod_ini(&manifest, &read, IniMatch::Hard);
        assert_eq!(report.undescribed, 0);
    }

    #[test]
    fn a_written_file_carries_the_help_the_bounds_and_the_default() {
        let manifest = schema();
        let written = generate_mod_ini(&manifest, &nothing()).expect("an ini");
        let body = String::from_utf8(written.values().next().expect("one file").clone())
            .expect("latin1 is ASCII here");
        assert!(body.contains("; How EcCo behaves\r\n"), "{body}");
        assert!(body.contains("; How fast the party walks.\r\n"), "{body}");
        assert!(body.contains("; 1 to 10 steps\r\n"), "{body}");
        assert!(body.contains("Speed=5\r\n"), "{body}");
        // The label stands in where there is no help to write.
        assert!(body.contains("; On\r\n"), "{body}");
    }

    #[test]
    fn what_is_written_passes_its_own_check() {
        let manifest = schema();
        let written = generate_mod_ini(&manifest, &nothing()).expect("an ini");
        let report = check_mod_ini(
            &manifest,
            &|name: &str| written.get(name).cloned(),
            IniMatch::Hard,
        );
        assert!(report.mismatches.is_empty(), "{:?}", report.mismatches);
    }

    #[test]
    fn an_existing_file_is_read_for_its_line_terminator_and_nothing_else() {
        let manifest = schema();
        let file = file_of(&manifest);
        let read = reader(vec![(file.clone(), "[old]\nGone=1\n")]);
        let written = generate_mod_ini(&manifest, &read).expect("an ini");
        let body = String::from_utf8(written[&file].clone()).expect("latin1 is ASCII here");
        assert!(!body.contains("Gone"), "{body}");
        assert!(!body.contains('\r'), "{body}");
    }

    #[test]
    fn a_manifest_describing_no_settings_has_no_ini_to_write() {
        let plain =
            "spec: 1\nid: ecco\nname: EcCo\nversion: 1.0\ngame: fallout2\ntype: pluggable\n";
        let manifest = parse_manifest(plain.as_bytes(), &ManifestDefaults::default())
            .expect("a manifest the test writes");
        let err = generate_mod_ini(&manifest, &nothing()).expect_err("nothing to write");
        assert!(err.contains("describes no settings"), "{err}");
    }

    #[test]
    fn a_setting_with_no_default_has_no_value_to_write() {
        let text = SCHEMA.replace("    default: '5'\n", "");
        let manifest = parse_manifest(text.as_bytes(), &ManifestDefaults::default())
            .expect("a manifest the test writes");
        let err = generate_mod_ini(&manifest, &nothing()).expect_err("no value");
        assert!(err.contains("no \"default\" stated"), "{err}");
    }

    #[test]
    fn a_dropped_setting_stops_the_write_rather_than_being_left_out_of_it() {
        let text = format!("{SCHEMA}{LATER}");
        let manifest = parse_manifest(text.as_bytes(), &ManifestDefaults::default())
            .expect("an unknown type is dropped rather than refused");
        let err = generate_mod_ini(&manifest, &nothing()).expect_err("cannot write it");
        assert!(err.contains("Cannot write"), "{err}");
    }

    #[test]
    fn a_character_the_game_cannot_read_stops_the_write() {
        // It would otherwise land as another byte silently.
        let text = SCHEMA.replace("How EcCo behaves", "How EcCo behaves \u{4e2d}");
        let manifest = parse_manifest(text.as_bytes(), &ManifestDefaults::default())
            .expect("a manifest the test writes");
        let err = generate_mod_ini(&manifest, &nothing()).expect_err("no latin1 byte");
        assert!(err.contains("has no latin1 byte"), "{err}");
    }

    #[test]
    fn a_bound_is_spelled_the_way_the_manifest_did() {
        let kind = SettingKind::Int(zax_core::catalog::NumericKind {
            min: Some(0.0),
            max: Some(100.0),
            unit: None,
            sentinels: BTreeMap::from([("-1".to_owned(), "auto".to_owned())]),
        });
        assert_eq!(accepts(&kind).as_deref(), Some("0 to 100, or -1 (auto)"));
        let open = SettingKind::Float(zax_core::catalog::NumericKind {
            min: Some(0.5),
            ..zax_core::catalog::NumericKind::default()
        });
        assert_eq!(accepts(&open).as_deref(), Some("At least 0.5"));
        assert_eq!(accepts(&SettingKind::Key), None);
    }
}

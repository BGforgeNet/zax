//! A setting's typed definition. One value drives parsing, validation, rendering, search and
//! diffing.
//!
//! `id` joins the catalog to layout, actions and search. Its first address mints it; later targets
//! keep it.

use std::collections::BTreeMap;

use serde::Deserialize;

use crate::keys::{KEYS, key_name};

/// The types here deserialize from what `scripts/gen/gen-catalog.mjs` emits, which is the same data
/// the TypeScript build reads. Field names stay in that file's spelling rather than Rust's, so the
/// generator has one output shape and not two.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ChoiceOption {
    pub value: String,
    pub label: String,
    #[serde(default)]
    pub help: Option<String>,
}

/// Bounds and presentation for a numeric setting.
///
/// `sentinels` name values that are not quantities - 0 meaning "native", -1 meaning "auto".
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct NumericKind {
    #[serde(default)]
    pub min: Option<f64>,
    #[serde(default)]
    pub max: Option<f64>,
    #[serde(default)]
    pub unit: Option<String>,
    #[serde(default)]
    pub sentinels: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum SettingKind {
    /// Raw engine scale (volumes run 0..32767) shown to the user as a percentage.
    Scale {
        max: f64,
    },
    #[serde(rename_all = "camelCase")]
    Bool {
        on_value: String,
        off_value: String,
    },
    Int(NumericKind),
    Float(NumericKind),
    Text {
        #[serde(default)]
        path: bool,
    },
    Choice {
        options: Vec<ChoiceOption>,
    },
    Key,
}

/// Which values of a setting a rule applies to.
///
/// `IsNot` covers controllers with an open range, where the interesting states cannot be listed: "a
/// key is bound" is every value but none, and "idling is on" is every value but the disabled
/// sentinel.
/// Externally tagged, which is what spells these as `{"is": [..]}` and `{"isNot": [..]}` - the shape
/// the generator writes.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ValueTest {
    Is(Vec<String>),
    IsNot(Vec<String>),
}

/// One address a setting's value lives at.
///
/// Most settings have a single target; a setting that more than one engine carries under its own
/// name has one per engine, so that the several names stay one row.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingTarget {
    pub file: String,
    pub section: String,
    pub key: String,
    /// The engine whose settings this address belongs to, absent where it is the game's own,
    /// sfall's or the high-resolution patch's. Not something the file and section imply:
    /// fallout2-ce writes keys of its own into the game's `[system]` and `[sound]`, beside vanilla
    /// keys that belong to no engine.
    pub engine: Option<String>,
    /// This target only takes effect while another setting passes the test. Editing it otherwise
    /// changes the file but not the game, so the interface says so rather than letting the change
    /// look effective. Per target rather than per setting: a prerequisite can hold on one engine and
    /// not on the next, and a shared gate would either over-restrict the others or write a value
    /// that silently does nothing.
    #[serde(default)]
    pub gated_by: Option<Gate>,
}

/// The test is flattened beside the id, which is how the generator writes it: `{id, is: [..]}`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Gate {
    pub id: String,
    #[serde(flatten)]
    pub test: ValueTest,
}

/// Every address one value is written to, the nominated one first.
///
/// A separate type because the first target is the address the id was minted from, so it stays the
/// id's source even where its file is absent. Holding it apart is what lets [`Targets::own`] answer
/// without a fallible lookup, which is the guarantee the TypeScript got from a non-empty tuple type.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(try_from = "Vec<SettingTarget>")]
pub struct Targets {
    own: SettingTarget,
    others: Vec<SettingTarget>,
}

impl TryFrom<Vec<SettingTarget>> for Targets {
    type Error = &'static str;

    /// The generator writes a plain array. Rejecting an empty one here is what keeps the non-empty
    /// guarantee [`Targets::own`] rests on: a setting with no address has no id to have been minted
    /// from.
    fn try_from(targets: Vec<SettingTarget>) -> std::result::Result<Self, Self::Error> {
        let mut targets = targets.into_iter();
        let own = targets
            .next()
            .ok_or("a setting must name at least one target")?;
        Ok(Self {
            own,
            others: targets.collect(),
        })
    }
}

impl Targets {
    #[must_use]
    pub fn new(own: SettingTarget) -> Self {
        Self {
            own,
            others: Vec::new(),
        }
    }

    #[must_use]
    pub fn and(mut self, other: SettingTarget) -> Self {
        self.others.push(other);
        self
    }

    /// The setting's own address: the target its id was minted from.
    #[must_use]
    pub fn own(&self) -> &SettingTarget {
        &self.own
    }

    pub fn iter(&self) -> impl Iterator<Item = &SettingTarget> {
        std::iter::once(&self.own).chain(&self.others)
    }

    #[must_use]
    pub fn len(&self) -> usize {
        1 + self.others.len()
    }

    /// Never empty: a setting always has the address its id came from.
    #[must_use]
    pub const fn is_empty(&self) -> bool {
        false
    }
}

/// A pairing the engine handles badly, warned about only while both settings are in the states
/// named. Unlike a gate, each setting still works alone, so neither is disabled.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Conflict {
    pub id: String,
    /// `self` in the emitted data, which Rust cannot name a field.
    #[serde(rename = "self")]
    pub self_test: ValueTest,
    #[serde(rename = "other")]
    pub other_test: ValueTest,
    pub note: String,
}

/// ZAX owns this value and always writes it. Shown read-only with the reason, rather than hidden, so
/// the choice is visible instead of looking like the setting simply went missing.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Managed {
    pub value: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingDef {
    pub id: String,
    pub targets: Targets,
    pub kind: SettingKind,
    pub label: String,
    #[serde(default)]
    pub help: Option<String>,
    #[serde(default)]
    pub conflicts_with: Option<Conflict>,
    #[serde(default)]
    pub managed: Option<Managed>,
}

/// Whether a value satisfies a test. Absent and blank never do - nothing is not "some other value".
#[must_use]
pub fn matches_value_test(def: &SettingDef, value: Option<&str>, test: &ValueTest) -> bool {
    let Some(value) = value else {
        return false;
    };
    if value.trim().is_empty() {
        return false;
    }
    // sfall writes some bindings in hex, so an unbound key reads as 0x0 in one file and 0 in the
    // next.
    let raw = if matches!(def.kind, SettingKind::Key) {
        parse_scancode(value)
    } else {
        value.to_owned()
    };
    match test {
        ValueTest::Is(values) => values.contains(&raw),
        ValueTest::IsNot(values) => !values.contains(&raw),
    }
}

/// A value that would make `test` pass, or `None` where it names none to write.
///
/// "Any key but 0" is every key, and picking one would rebind the user's keyboard on their behalf.
/// Where several pass, the first the test lists: a gate naming a range states them in the order its
/// author meant them to be read.
#[must_use]
pub fn value_satisfying(def: &SettingDef, test: &ValueTest) -> Option<String> {
    let refused = match test {
        ValueTest::Is(values) => return values.first().cloned(),
        ValueTest::IsNot(values) => values,
    };
    // Only a kind whose values can be listed has a complement to offer; a number or a key has an
    // open range.
    let listed: Vec<String> = match &def.kind {
        SettingKind::Bool {
            on_value,
            off_value,
        } => vec![on_value.clone(), off_value.clone()],
        SettingKind::Choice { options } => options.iter().map(|o| o.value.clone()).collect(),
        SettingKind::Scale { .. }
        | SettingKind::Int(_)
        | SettingKind::Float(_)
        | SettingKind::Text { .. }
        | SettingKind::Key => Vec::new(),
    };
    listed.into_iter().find(|value| !refused.contains(value))
}

/// What a value is called in the interface: its sentinel name where it has one, since that is what
/// it means.
#[must_use]
pub fn value_label(def: &SettingDef, raw: &str) -> String {
    sentinel_label(def, Some(raw)).unwrap_or_else(|| display_value(def, Some(raw)))
}

/// The values a test accepts, phrased for a note: "DX9 fullscreen or DX9 windowed", "anything but
/// Disabled".
#[must_use]
pub fn describe_value_test(def: &SettingDef, test: &ValueTest) -> String {
    match test {
        ValueTest::Is(values) => values
            .iter()
            .map(|v| value_label(def, v))
            .collect::<Vec<_>>()
            .join(" or "),
        ValueTest::IsNot(_) if matches!(def.kind, SettingKind::Key) => "a key".to_owned(),
        ValueTest::IsNot(values) => {
            let named = values
                .iter()
                .map(|v| value_label(def, v))
                .collect::<Vec<_>>()
                .join(" or ");
            format!("anything but {named}")
        }
    }
}

/// Reads a raw config value as a number, answering 0 for anything that is not one.
///
/// The TypeScript used `Number`, which trims and yields 0 for an empty string; both are reproduced
/// here. Its acceptance of `0x10` as 16 is not: a scale is a decimal quantity, and a value spelled
/// that way in one of these files means the file is not what the caller thinks it is.
fn numeric(raw: &str) -> f64 {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return 0.0;
    }
    trimmed
        .parse::<f64>()
        .map_or(0.0, |n| if n.is_finite() { n } else { 0.0 })
}

/// Raw config value to percentage, for scale kinds.
#[must_use]
pub fn scale_to_percent(raw: &str, max: f64) -> i64 {
    if max == 0.0 {
        return 0;
    }
    (numeric(raw) / max * 100.0).round() as i64
}

/// Percentage to raw config value, rounded to the engine's own integer scale.
#[must_use]
pub fn percent_to_scale(percent: f64, max: f64) -> String {
    let bounded = percent.clamp(0.0, 100.0);
    format!("{}", (bounded / 100.0 * max).round() as i64)
}

/// sfall writes some key bindings in hex; the game's own settings use decimal.
#[must_use]
pub fn parse_scancode(raw: &str) -> String {
    let trimmed = raw.trim();
    let Some(digits) = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
    else {
        return trimmed.to_owned();
    };
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
        return trimmed.to_owned();
    }
    u32::from_str_radix(digits, 16).map_or_else(|_| trimmed.to_owned(), |n| n.to_string())
}

/// Name for a value that is a sentinel rather than a quantity, e.g. 0 meaning "native resolution".
#[must_use]
pub fn sentinel_label(def: &SettingDef, raw: Option<&str>) -> Option<String> {
    let raw = raw?;
    match &def.kind {
        SettingKind::Int(kind) | SettingKind::Float(kind) => kind.sentinels.get(raw).cloned(),
        SettingKind::Scale { .. }
        | SettingKind::Bool { .. }
        | SettingKind::Text { .. }
        | SettingKind::Choice { .. }
        | SettingKind::Key => None,
    }
}

/// Human-readable rendering of a raw config value, for display and for search.
#[must_use]
pub fn display_value(def: &SettingDef, raw: Option<&str>) -> String {
    let Some(raw) = raw else {
        return String::new();
    };
    match &def.kind {
        SettingKind::Bool { on_value, .. } => if raw == on_value { "On" } else { "Off" }.to_owned(),
        SettingKind::Choice { options } => options
            .iter()
            .find(|o| o.value == raw)
            .map_or_else(|| raw.to_owned(), |o| o.label.clone()),
        SettingKind::Key => {
            let code = parse_scancode(raw);
            key_name(&code).map_or_else(|| raw.to_owned(), ToOwned::to_owned)
        }
        SettingKind::Scale { max } => format!("{}%", scale_to_percent(raw, *max)),
        SettingKind::Int(kind) | SettingKind::Float(kind) => kind
            .unit
            .as_ref()
            .map_or_else(|| raw.to_owned(), |unit| format!("{raw} {unit}")),
        SettingKind::Text { .. } => raw.to_owned(),
    }
}

/// The text a search matches against - the fields a user would plausibly type, lowercased once so
/// callers can index it ahead of time instead of rebuilding it per query.
///
/// The group is deliberately excluded. It labels the source component ("High resolution"), so
/// including it made every one of that file's settings match a search for "resolution" - a whole
/// file of noise burying the handful of settings actually about resolution. The file already covers
/// searching by origin.
#[must_use]
pub fn search_text(def: &SettingDef) -> String {
    let mut fields = vec![def.label.clone()];
    for target in def.targets.iter() {
        fields.push(target.key.clone());
        fields.push(target.section.clone());
        fields.push(target.file.clone());
    }
    fields.push(def.help.clone().unwrap_or_default());
    if let SettingKind::Choice { options } = &def.kind {
        fields.extend(options.iter().map(|o| o.label.clone()));
    }
    fields.join(" ").to_lowercase()
}

/// Every scancode this knows, for a caller that needs the whole table.
pub fn scancodes() -> impl Iterator<Item = (u16, &'static str)> {
    KEYS.iter().map(|(code, name, _)| (*code, *name))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(file: &str, section: &str, key: &str) -> SettingTarget {
        SettingTarget {
            file: file.to_owned(),
            section: section.to_owned(),
            key: key.to_owned(),
            engine: None,
            gated_by: None,
        }
    }

    fn def(kind: SettingKind) -> SettingDef {
        SettingDef {
            id: "sfall.Misc.Example".to_owned(),
            targets: Targets::new(target("ddraw.ini", "Misc", "Example")),
            kind,
            label: "Example".to_owned(),
            help: None,
            conflicts_with: None,
            managed: None,
        }
    }

    fn a_bool() -> SettingDef {
        def(SettingKind::Bool {
            on_value: "1".to_owned(),
            off_value: "0".to_owned(),
        })
    }

    fn a_choice() -> SettingDef {
        def(SettingKind::Choice {
            options: vec![
                ChoiceOption {
                    value: "0".to_owned(),
                    label: "DX9 fullscreen".to_owned(),
                    help: None,
                },
                ChoiceOption {
                    value: "1".to_owned(),
                    label: "DX9 windowed".to_owned(),
                    help: None,
                },
            ],
        })
    }

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| (*v).to_owned()).collect()
    }

    #[test]
    fn a_setting_always_has_the_address_its_id_came_from() {
        let targets = Targets::new(target("f2_res.ini", "MAIN", "SCR_WIDTH")).and(target(
            "fallout2.cfg",
            "system",
            "width",
        ));
        assert_eq!(targets.own().file, "f2_res.ini");
        assert_eq!(targets.len(), 2);
        assert!(!targets.is_empty());
        assert_eq!(targets.iter().count(), 2);
    }

    #[test]
    fn absent_and_blank_satisfy_no_test() {
        let def = a_bool();
        let test = ValueTest::IsNot(strings(&["0"]));
        assert!(!matches_value_test(&def, None, &test));
        assert!(!matches_value_test(&def, Some(""), &test));
        assert!(!matches_value_test(&def, Some("   "), &test));
        assert!(matches_value_test(&def, Some("1"), &test));
    }

    #[test]
    fn a_key_test_compares_after_reading_the_scancode() {
        // sfall writes some bindings in hex, so the same key reads as 0x0 in one file and 0 in the
        // next; a test naming "0" has to match both.
        let def = def(SettingKind::Key);
        let unbound = ValueTest::Is(strings(&["0"]));
        assert!(matches_value_test(&def, Some("0x0"), &unbound));
        assert!(matches_value_test(&def, Some("0"), &unbound));
        assert!(!matches_value_test(&def, Some("0x1"), &unbound));
    }

    #[test]
    fn value_satisfying_takes_the_first_named() {
        let def = a_choice();
        assert_eq!(
            value_satisfying(&def, &ValueTest::Is(strings(&["1", "0"]))).as_deref(),
            Some("1")
        );
    }

    #[test]
    fn value_satisfying_completes_a_listable_kind() {
        assert_eq!(
            value_satisfying(&a_bool(), &ValueTest::IsNot(strings(&["0"]))).as_deref(),
            Some("1")
        );
        assert_eq!(
            value_satisfying(&a_choice(), &ValueTest::IsNot(strings(&["0"]))).as_deref(),
            Some("1")
        );
    }

    #[test]
    fn value_satisfying_offers_nothing_for_an_open_range() {
        // "Any key but none" is every key, and picking one would rebind the user's keyboard.
        let key = def(SettingKind::Key);
        assert_eq!(
            value_satisfying(&key, &ValueTest::IsNot(strings(&["0"]))),
            None
        );
        let number = def(SettingKind::Int(NumericKind::default()));
        assert_eq!(
            value_satisfying(&number, &ValueTest::IsNot(strings(&["0"]))),
            None
        );
    }

    #[test]
    fn describe_names_the_accepted_values() {
        let def = a_choice();
        assert_eq!(
            describe_value_test(&def, &ValueTest::Is(strings(&["0", "1"]))),
            "DX9 fullscreen or DX9 windowed"
        );
        assert_eq!(
            describe_value_test(&def, &ValueTest::IsNot(strings(&["0"]))),
            "anything but DX9 fullscreen"
        );
    }

    #[test]
    fn describe_calls_an_open_key_range_a_key() {
        let def = def(SettingKind::Key);
        assert_eq!(
            describe_value_test(&def, &ValueTest::IsNot(strings(&["0"]))),
            "a key"
        );
    }

    #[test]
    fn a_scale_round_trips_through_percent() {
        assert_eq!(scale_to_percent("32767", 32767.0), 100);
        assert_eq!(scale_to_percent("0", 32767.0), 0);
        assert_eq!(percent_to_scale(100.0, 32767.0), "32767");
        assert_eq!(percent_to_scale(0.0, 32767.0), "0");
    }

    #[test]
    fn a_percent_outside_the_range_is_clamped() {
        assert_eq!(percent_to_scale(150.0, 32767.0), "32767");
        assert_eq!(percent_to_scale(-20.0, 32767.0), "0");
    }

    #[test]
    fn a_scale_value_that_is_not_a_number_reads_as_zero() {
        assert_eq!(scale_to_percent("", 32767.0), 0);
        assert_eq!(scale_to_percent("loud", 32767.0), 0);
    }

    #[test]
    fn a_hex_scancode_reads_as_its_decimal() {
        assert_eq!(parse_scancode("0x1C"), "28");
        assert_eq!(parse_scancode("0x0"), "0");
        assert_eq!(parse_scancode("28"), "28");
        assert_eq!(parse_scancode("  28  "), "28");
    }

    #[test]
    fn something_shaped_like_hex_but_not_is_left_alone() {
        assert_eq!(parse_scancode("0xzz"), "0xzz");
        assert_eq!(parse_scancode("0x"), "0x");
    }

    #[test]
    fn display_names_each_kind() {
        assert_eq!(display_value(&a_bool(), Some("1")), "On");
        assert_eq!(display_value(&a_bool(), Some("0")), "Off");
        assert_eq!(display_value(&a_choice(), Some("1")), "DX9 windowed");
        assert_eq!(display_value(&def(SettingKind::Key), Some("0x1C")), "Enter");
        assert_eq!(
            display_value(&def(SettingKind::Scale { max: 32767.0 }), Some("16384")),
            "50%"
        );
        assert_eq!(display_value(&a_bool(), None), "");
    }

    #[test]
    fn display_falls_back_to_the_raw_value_it_cannot_name() {
        assert_eq!(display_value(&a_choice(), Some("7")), "7");
        assert_eq!(display_value(&def(SettingKind::Key), Some("9999")), "9999");
    }

    #[test]
    fn a_unit_is_appended_to_a_number() {
        let def = def(SettingKind::Int(NumericKind {
            unit: Some("ms".to_owned()),
            ..NumericKind::default()
        }));
        assert_eq!(display_value(&def, Some("250")), "250 ms");
    }

    #[test]
    fn a_sentinel_names_a_value_that_is_not_a_quantity() {
        let def = def(SettingKind::Int(NumericKind {
            sentinels: BTreeMap::from([("0".to_owned(), "Native".to_owned())]),
            ..NumericKind::default()
        }));
        assert_eq!(sentinel_label(&def, Some("0")).as_deref(), Some("Native"));
        assert_eq!(sentinel_label(&def, Some("640")), None);
        assert_eq!(value_label(&def, "0"), "Native");
        assert_eq!(value_label(&def, "640"), "640");
    }

    #[test]
    fn search_text_covers_label_addresses_help_and_choice_labels() {
        let mut def = a_choice();
        def.help = Some("How the game presents itself".to_owned());
        let text = search_text(&def);
        for wanted in [
            "example",
            "ddraw.ini",
            "misc",
            "how the game presents itself",
            "dx9 windowed",
        ] {
            assert!(text.contains(wanted), "{wanted:?} missing from {text:?}");
        }
    }

    #[test]
    fn search_text_covers_every_target_not_just_the_first() {
        let mut def = a_bool();
        def.targets = Targets::new(target("ddraw.ini", "Misc", "Example")).and(target(
            "fallout2.cfg",
            "system",
            "other_name",
        ));
        let text = search_text(&def);
        assert!(text.contains("other_name"), "{text}");
        assert!(text.contains("fallout2.cfg"), "{text}");
    }
}

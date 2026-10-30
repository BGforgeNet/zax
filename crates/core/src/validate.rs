//! Value sanitization.
//!
//! The Python implementation's bounds were spinner ranges rather than domains, which let a graphics
//! width of 1 through. A value is valid when it is a named sentinel, or a number inside a real
//! range.

use crate::catalog::{NumericKind, SettingDef, SettingKind};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Validation {
    Ok,
    /// Worded for the user, since it is what reaches them.
    Rejected(String),
}

impl Validation {
    #[must_use]
    pub const fn is_ok(&self) -> bool {
        matches!(self, Self::Ok)
    }

    #[must_use]
    pub fn reason(&self) -> Option<&str> {
        match self {
            Self::Ok => None,
            Self::Rejected(reason) => Some(reason),
        }
    }
}

fn unit_suffix(unit: Option<&String>) -> String {
    unit.map_or_else(String::new, |unit| format!(" {unit}"))
}

/// Renders a bound the way the TypeScript's template literal did, so `10` stays `10` rather than
/// becoming `10.0`.
fn bound(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        format!("{}", value as i64)
    } else {
        format!("{value}")
    }
}

fn validate_numeric(kind: &NumericKind, raw: &str, whole: bool) -> Validation {
    if kind.sentinels.contains_key(raw) {
        return Validation::Ok;
    }
    let Ok(n) = raw.trim().parse::<f64>() else {
        return Validation::Rejected("Not a number".to_owned());
    };
    if !n.is_finite() {
        return Validation::Rejected("Not a number".to_owned());
    }
    if whole && n.fract() != 0.0 {
        return Validation::Rejected("Must be a whole number".to_owned());
    }
    if let Some(min) = kind.min
        && n < min
    {
        return Validation::Rejected(format!(
            "Must be at least {}{}",
            bound(min),
            unit_suffix(kind.unit.as_ref())
        ));
    }
    if let Some(max) = kind.max
        && n > max
    {
        return Validation::Rejected(format!(
            "Must be at most {}{}",
            bound(max),
            unit_suffix(kind.unit.as_ref())
        ));
    }
    Validation::Ok
}

/// Whether a value may be written for this setting. An absent or empty value is not a rejection:
/// nothing has been entered yet.
#[must_use]
pub fn validate(def: &SettingDef, raw: Option<&str>) -> Validation {
    let Some(raw) = raw else {
        return Validation::Ok;
    };
    if raw.is_empty() {
        return Validation::Ok;
    }

    match &def.kind {
        SettingKind::Int(kind) => validate_numeric(kind, raw, true),
        SettingKind::Float(kind) => validate_numeric(kind, raw, false),
        SettingKind::Choice { options } => {
            if options.iter().any(|o| o.value == raw) {
                Validation::Ok
            } else {
                Validation::Rejected(format!("{raw} is not one of the supported values"))
            }
        }
        SettingKind::Scale { max } => match raw.trim().parse::<f64>() {
            Ok(n) if n.is_finite() && n >= 0.0 && n <= *max => Validation::Ok,
            _ => Validation::Rejected("Outside the supported range".to_owned()),
        },
        // Nothing a value can be wrong about: a bool is one of its own two spellings, a key is a
        // scancode the editor produces, and text is free-form. Named rather than left to a wildcard,
        // so a kind added to the catalog has to be answered for here.
        SettingKind::Bool { .. } | SettingKind::Key | SettingKind::Text { .. } => Validation::Ok,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{ChoiceOption, SettingTarget, Targets};
    use std::collections::BTreeMap;

    fn def(kind: SettingKind) -> SettingDef {
        SettingDef {
            id: "sfall.Misc.Example".to_owned(),
            targets: Targets::new(SettingTarget {
                file: "ddraw.ini".to_owned(),
                section: "Misc".to_owned(),
                key: "Example".to_owned(),
                engine: None,
                gated_by: None,
            }),
            kind,
            label: "Example".to_owned(),
            help: None,
            conflicts_with: None,
            managed: None,
        }
    }

    fn bounded_int() -> SettingDef {
        def(SettingKind::Int(NumericKind {
            min: Some(640.0),
            max: Some(7680.0),
            unit: None,
            sentinels: BTreeMap::new(),
        }))
    }

    #[test]
    fn nothing_entered_is_not_a_rejection() {
        assert!(validate(&bounded_int(), None).is_ok());
        assert!(validate(&bounded_int(), Some("")).is_ok());
    }

    #[test]
    fn a_number_inside_the_range_passes() {
        assert!(validate(&bounded_int(), Some("1920")).is_ok());
        assert!(validate(&bounded_int(), Some("640")).is_ok());
        assert!(validate(&bounded_int(), Some("7680")).is_ok());
    }

    #[test]
    fn a_width_of_one_is_refused() {
        // The defect this exists for: a spinner range let a graphics width of 1 through.
        let refused = validate(&bounded_int(), Some("1"));
        assert_eq!(refused.reason(), Some("Must be at least 640"));
    }

    #[test]
    fn a_number_past_the_ceiling_is_refused() {
        assert_eq!(
            validate(&bounded_int(), Some("99999")).reason(),
            Some("Must be at most 7680")
        );
    }

    #[test]
    fn a_bound_carries_the_unit_when_there_is_one() {
        let def = def(SettingKind::Int(NumericKind {
            min: Some(0.0),
            max: Some(1000.0),
            unit: Some("ms".to_owned()),
            sentinels: BTreeMap::new(),
        }));
        assert_eq!(
            validate(&def, Some("5000")).reason(),
            Some("Must be at most 1000 ms")
        );
    }

    #[test]
    fn a_sentinel_passes_whatever_the_bounds_say() {
        // 0 meaning "native resolution" is not a quantity, so the range does not apply to it.
        let def = def(SettingKind::Int(NumericKind {
            min: Some(640.0),
            max: Some(7680.0),
            unit: None,
            sentinels: BTreeMap::from([("0".to_owned(), "Native".to_owned())]),
        }));
        assert!(validate(&def, Some("0")).is_ok());
        assert!(!validate(&def, Some("1")).is_ok());
    }

    #[test]
    fn text_that_is_not_a_number_is_refused() {
        assert_eq!(
            validate(&bounded_int(), Some("wide")).reason(),
            Some("Not a number")
        );
    }

    #[test]
    fn an_int_refuses_a_fraction_and_a_float_accepts_one() {
        assert_eq!(
            validate(&bounded_int(), Some("1920.5")).reason(),
            Some("Must be a whole number")
        );
        let float = def(SettingKind::Float(NumericKind {
            min: Some(0.0),
            max: Some(10.0),
            unit: None,
            sentinels: BTreeMap::new(),
        }));
        assert!(validate(&float, Some("1.5")).is_ok());
    }

    #[test]
    fn a_choice_must_name_one_of_its_options() {
        let def = def(SettingKind::Choice {
            options: vec![ChoiceOption {
                value: "0".to_owned(),
                label: "DX9 fullscreen".to_owned(),
                help: None,
            }],
        });
        assert!(validate(&def, Some("0")).is_ok());
        assert_eq!(
            validate(&def, Some("7")).reason(),
            Some("7 is not one of the supported values")
        );
    }

    #[test]
    fn a_scale_is_bounded_by_its_own_maximum() {
        let def = def(SettingKind::Scale { max: 32767.0 });
        assert!(validate(&def, Some("0")).is_ok());
        assert!(validate(&def, Some("32767")).is_ok());
        assert!(!validate(&def, Some("-1")).is_ok());
        assert!(!validate(&def, Some("32768")).is_ok());
        assert!(!validate(&def, Some("loud")).is_ok());
    }

    #[test]
    fn the_kinds_with_nothing_to_be_wrong_about_always_pass() {
        let bool_def = def(SettingKind::Bool {
            on_value: "1".to_owned(),
            off_value: "0".to_owned(),
        });
        assert!(validate(&bool_def, Some("anything")).is_ok());
        assert!(validate(&def(SettingKind::Key), Some("28")).is_ok());
        assert!(validate(&def(SettingKind::Text { path: false }), Some("C:\\x")).is_ok());
    }
}

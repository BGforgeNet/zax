//! Every scancode sfall's own `dik.h` defines: what to call it, and the DOM `code` that produces it
//! where a browser can.
//!
//! One table rather than two maps, so a key the capture control can set is always one the display
//! can name - a scancode with no name here renders as a bare number.

/// DirectX scancodes, for settings that bind a key. 0 means unbound.
pub const KEYS: &[(u16, &str, Option<&str>)] = &[
    (0, "None", None),
    (1, "Esc", Some("Escape")),
    (2, "1", Some("Digit1")),
    (3, "2", Some("Digit2")),
    (4, "3", Some("Digit3")),
    (5, "4", Some("Digit4")),
    (6, "5", Some("Digit5")),
    (7, "6", Some("Digit6")),
    (8, "7", Some("Digit7")),
    (9, "8", Some("Digit8")),
    (10, "9", Some("Digit9")),
    (11, "0", Some("Digit0")),
    (12, "-", Some("Minus")),
    (13, "=", Some("Equal")),
    (14, "Backspace", Some("Backspace")),
    (15, "Tab", Some("Tab")),
    (16, "Q", Some("KeyQ")),
    (17, "W", Some("KeyW")),
    (18, "E", Some("KeyE")),
    (19, "R", Some("KeyR")),
    (20, "T", Some("KeyT")),
    (21, "Y", Some("KeyY")),
    (22, "U", Some("KeyU")),
    (23, "I", Some("KeyI")),
    (24, "O", Some("KeyO")),
    (25, "P", Some("KeyP")),
    (26, "[", Some("BracketLeft")),
    (27, "]", Some("BracketRight")),
    (28, "Enter", Some("Enter")),
    (29, "Left Ctrl", Some("ControlLeft")),
    (30, "A", Some("KeyA")),
    (31, "S", Some("KeyS")),
    (32, "D", Some("KeyD")),
    (33, "F", Some("KeyF")),
    (34, "G", Some("KeyG")),
    (35, "H", Some("KeyH")),
    (36, "J", Some("KeyJ")),
    (37, "K", Some("KeyK")),
    (38, "L", Some("KeyL")),
    (39, ";", Some("Semicolon")),
    (40, "'", Some("Quote")),
    (41, "`", Some("Backquote")),
    (42, "Left Shift", Some("ShiftLeft")),
    (43, "\\", Some("Backslash")),
    (44, "Z", Some("KeyZ")),
    (45, "X", Some("KeyX")),
    (46, "C", Some("KeyC")),
    (47, "V", Some("KeyV")),
    (48, "B", Some("KeyB")),
    (49, "N", Some("KeyN")),
    (50, "M", Some("KeyM")),
    (51, ",", Some("Comma")),
    (52, ".", Some("Period")),
    (53, "/", Some("Slash")),
    (54, "Right Shift", Some("ShiftRight")),
    (55, "Numpad *", Some("NumpadMultiply")),
    (56, "Left Alt", Some("AltLeft")),
    (57, "Space", Some("Space")),
    (58, "Caps Lock", Some("CapsLock")),
    (59, "F1", Some("F1")),
    (60, "F2", Some("F2")),
    (61, "F3", Some("F3")),
    (62, "F4", Some("F4")),
    (63, "F5", Some("F5")),
    (64, "F6", Some("F6")),
    (65, "F7", Some("F7")),
    (66, "F8", Some("F8")),
    (67, "F9", Some("F9")),
    (68, "F10", Some("F10")),
    (69, "Num Lock", Some("NumLock")),
    (70, "Scroll Lock", Some("ScrollLock")),
    (71, "Numpad 7", Some("Numpad7")),
    (72, "Numpad 8", Some("Numpad8")),
    (73, "Numpad 9", Some("Numpad9")),
    (74, "Numpad -", Some("NumpadSubtract")),
    (75, "Numpad 4", Some("Numpad4")),
    (76, "Numpad 5", Some("Numpad5")),
    (77, "Numpad 6", Some("Numpad6")),
    (78, "Numpad +", Some("NumpadAdd")),
    (79, "Numpad 1", Some("Numpad1")),
    (80, "Numpad 2", Some("Numpad2")),
    (81, "Numpad 3", Some("Numpad3")),
    (82, "Numpad 0", Some("Numpad0")),
    (83, "Numpad .", Some("NumpadDecimal")),
    (87, "F11", Some("F11")),
    (88, "F12", Some("F12")),
    (141, "Numpad =", None),
    (145, "@", None),
    (146, ":", None),
    (147, "_", None),
    (149, "Stop", None),
    (150, "AX", None),
    (151, "Unlabeled", None),
    (156, "Numpad Enter", Some("NumpadEnter")),
    (157, "Right Ctrl", Some("ControlRight")),
    (179, "Numpad ,", None),
    (181, "Numpad /", Some("NumpadDivide")),
    (183, "Print Screen", Some("PrintScreen")),
    (184, "Right Alt", Some("AltRight")),
    (199, "Home", Some("Home")),
    (200, "Up", Some("ArrowUp")),
    (201, "Page Up", Some("PageUp")),
    (203, "Left", Some("ArrowLeft")),
    (205, "Right", Some("ArrowRight")),
    (207, "End", Some("End")),
    (208, "Down", Some("ArrowDown")),
    (209, "Page Down", Some("PageDown")),
    (210, "Insert", Some("Insert")),
    (211, "Delete", Some("Delete")),
    (219, "Left Win", Some("MetaLeft")),
    (220, "Right Win", Some("MetaRight")),
    (221, "Menu", Some("ContextMenu")),
];

/// What to call a scancode, given as its decimal text, or `None` where the table does not name it.
#[must_use]
pub fn key_name(scancode: &str) -> Option<&'static str> {
    let code: u16 = scancode.parse().ok()?;
    KEYS.iter()
        .find(|(held, _, _)| *held == code)
        .map(|(_, name, _)| *name)
}

/// What a captured keypress writes.
///
/// Keyed by `KeyboardEvent.code` rather than `key` because a scancode is the physical key: `key`
/// carries the layout, so the same code would mean two different scancodes.
#[must_use]
pub fn scancode_for_dom_code(dom_code: &str) -> Option<u16> {
    KEYS.iter()
        .find(|(_, _, held)| *held == Some(dom_code))
        .map(|(code, _, _)| *code)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn names_the_keys_a_binding_uses() {
        assert_eq!(key_name("0"), Some("None"));
        assert_eq!(key_name("28"), Some("Enter"));
        assert_eq!(key_name("221"), Some("Menu"));
    }

    #[test]
    fn a_scancode_the_table_does_not_name_answers_none() {
        assert_eq!(key_name("9999"), None);
        assert_eq!(key_name("not a number"), None);
    }

    #[test]
    fn a_dom_code_maps_back_to_its_scancode() {
        assert_eq!(scancode_for_dom_code("Enter"), Some(28));
        assert_eq!(scancode_for_dom_code("ArrowUp"), Some(200));
        assert_eq!(scancode_for_dom_code("Nonsense"), None);
    }

    #[test]
    fn every_capturable_key_can_also_be_named() {
        // The reason this is one table: a key the capture control can set must be one the display
        // can name, or a user binds a key the interface then shows as a bare number.
        for (code, name, dom) in KEYS {
            if dom.is_some() {
                assert!(
                    !name.is_empty(),
                    "scancode {code} has a DOM code but no name"
                );
                assert_eq!(key_name(&code.to_string()), Some(*name));
            }
        }
    }

    #[test]
    fn no_scancode_or_dom_code_is_listed_twice() {
        // A duplicate would make one of the two unreachable, silently.
        let mut codes = BTreeSet::new();
        let mut doms = BTreeSet::new();
        for (code, _, dom) in KEYS {
            assert!(codes.insert(*code), "scancode {code} is listed twice");
            if let Some(dom) = dom {
                assert!(doms.insert(*dom), "DOM code {dom} is listed twice");
            }
        }
    }
}

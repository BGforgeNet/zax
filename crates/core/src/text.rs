//! Bytes to text and back, and bytes into lines.
//!
//! The TypeScript this replaces carried file content as latin1 strings, because JavaScript has no
//! byte type and that mapping is the one encoding it can round-trip byte for byte. Rust has `[u8]`,
//! so the documents work on bytes directly and decoding happens only where something is displayed.
//! `String` here would be actively harmful: it is UTF-8, so a latin1 code point past 0x7f occupies
//! two bytes and every length and slice index would be wrong.

/// Decodes bytes as latin1, which maps each byte to the code point of the same value. For showing a
/// value to the user; never for deciding what to write back.
#[must_use]
pub fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| b as char).collect()
}

/// The inverse of [`latin1`]. A code point past 0xff cannot be represented and is truncated to its
/// low byte, exactly as the TypeScript's `charCodeAt(i) & 0xff` did.
#[must_use]
pub fn latin1_bytes(text: &str) -> Vec<u8> {
    text.chars().map(|c| (c as u32 & 0xff) as u8).collect()
}

/// Whitespace as JavaScript's regular-expression engine defines it, restricted to the bytes that
/// can appear in a latin1 file. 0xa0 is a non-breaking space and JavaScript's `\s` matches it, so
/// the port has to as well or a line holding one round-trips differently.
#[must_use]
pub const fn is_space(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\n' | 0x0b | 0x0c | b'\r' | 0xa0)
}

/// One line and the terminator it carried.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Line<'a> {
    pub body: &'a [u8],
    /// Empty for a final line that carried no terminator.
    pub eol: &'a [u8],
}

/// Splits into lines, each retaining its own terminator. A final line without one keeps an empty
/// terminator, which is what lets a file with no trailing newline round-trip.
#[must_use]
pub fn split_lines(text: &[u8]) -> Vec<Line<'_>> {
    let mut out = Vec::new();
    let mut start = 0;
    for i in 0..text.len() {
        if text[i] != b'\n' {
            continue;
        }
        let has_cr = i > start && text[i - 1] == b'\r';
        let body_end = if has_cr { i - 1 } else { i };
        out.push(Line {
            body: &text[start..body_end],
            eol: &text[body_end..=i],
        });
        start = i + 1;
    }
    if start < text.len() {
        out.push(Line {
            body: &text[start..],
            eol: b"",
        });
    }
    out
}

/// Lowercases a latin1 byte the way JavaScript's `toLowerCase` does, which is what the TypeScript
/// folded section and key names with. Only the ASCII range and 0xc0-0xde matter here; 0xd7 is the
/// multiplication sign rather than a letter, and 0xdf has no single-character uppercase.
#[must_use]
pub const fn fold_byte(byte: u8) -> u8 {
    if byte.is_ascii_uppercase() || (byte >= 0xc0 && byte <= 0xde && byte != 0xd7) {
        byte + 0x20
    } else {
        byte
    }
}

/// Whether two names are the same once folded, without allocating either.
#[must_use]
pub fn same_name(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .all(|(&a, &b)| fold_byte(a) == fold_byte(b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn latin1_round_trips_every_byte() {
        let all: Vec<u8> = (0..=255).collect();
        assert_eq!(latin1_bytes(&latin1(&all)), all);
    }

    #[test]
    fn split_lines_keeps_each_terminator() {
        let lines = split_lines(b"a\r\nb\nc");
        assert_eq!(
            lines,
            vec![
                Line { body: b"a", eol: b"\r\n" },
                Line { body: b"b", eol: b"\n" },
                Line { body: b"c", eol: b"" },
            ]
        );
    }

    #[test]
    fn split_lines_keeps_a_trailing_terminator() {
        let lines = split_lines(b"a\n");
        assert_eq!(lines, vec![Line { body: b"a", eol: b"\n" }]);
    }

    #[test]
    fn split_lines_treats_a_lone_cr_as_body() {
        // A bare CR is not a terminator on any host ZAX targets, so it stays in the body.
        let lines = split_lines(b"a\rb\n");
        assert_eq!(lines, vec![Line { body: b"a\rb", eol: b"\n" }]);
    }

    #[test]
    fn split_lines_of_empty_input_is_empty() {
        assert_eq!(split_lines(b""), Vec::new());
    }

    #[test]
    fn an_empty_line_before_a_terminator_keeps_its_place() {
        let lines = split_lines(b"\n\n");
        assert_eq!(
            lines,
            vec![
                Line { body: b"", eol: b"\n" },
                Line { body: b"", eol: b"\n" },
            ]
        );
    }

    #[test]
    fn a_non_breaking_space_counts_as_whitespace() {
        assert!(is_space(0xa0));
        assert!(is_space(b' '));
        assert!(!is_space(b'x'));
    }

    #[test]
    fn folding_matches_javascript_lowercasing() {
        assert_eq!(fold_byte(b'A'), b'a');
        assert_eq!(fold_byte(b'a'), b'a');
        assert_eq!(fold_byte(0xc9), 0xe9);
        // The multiplication sign and the sharp s are not cased letters.
        assert_eq!(fold_byte(0xd7), 0xd7);
        assert_eq!(fold_byte(0xdf), 0xdf);
    }

    #[test]
    fn same_name_ignores_case_but_not_length() {
        assert!(same_name(b"DamageFormula", b"damageformula"));
        assert!(!same_name(b"Damage", b"DamageFormula"));
    }
}

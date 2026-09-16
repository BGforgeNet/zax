//! Valve's key-values format, in the subset the two Steam files a scan reads are written in:
//! `libraryfolders.vdf` for where the libraries are, and `appmanifest_<id>.acf` for the folder one
//! game sits in. Both are the same format under different extensions, so they share one reader.
//!
//! Deliberately lenient. This parses files another program wrote and a scan must survive whatever it
//! finds: an unterminated string, a stray brace or a key with no value yields whatever was readable
//! up to that point rather than failing, because a malformed library list should cost the installs it
//! describes, not the whole scan.

/// How deep a nested map may go before the reader stops descending.
///
/// The TypeScript had no such bound: V8 turned runaway nesting into an exception the scan could
/// surface. A Rust stack overflow aborts the process instead, so leniency here has to include
/// refusing to recurse. Steam's own files nest three or four deep.
const MAX_DEPTH: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VdfValue {
    Text(String),
    Map(VdfMap),
}

/// Insertion-ordered, and a repeated key overwrites in place - the semantics the TypeScript got from
/// assigning into a plain object, which [`VdfMap::entry`]'s case-insensitive scan depends on.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VdfMap {
    entries: Vec<(String, VdfValue)>,
}

impl VdfMap {
    fn insert(&mut self, key: String, value: VdfValue) {
        if let Some(held) = self
            .entries
            .iter_mut()
            .find(|(name, _)| *name == key)
            .map(|(_, value)| value)
        {
            *held = value;
        } else {
            self.entries.push((key, value));
        }
    }

    /// Keys are matched case-insensitively because these files are not written by hand and their
    /// casing has changed across Steam versions - `libraryfolders.vdf` held `LibraryFolders` before
    /// it held `libraryfolders`.
    #[must_use]
    pub fn entry(&self, key: &str) -> Option<&VdfValue> {
        self.entries
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case(key))
            .map(|(_, value)| value)
    }

    /// The value at a key when it is text, for the common case of reading one leaf.
    #[must_use]
    pub fn text(&self, key: &str) -> Option<&str> {
        match self.entry(key) {
            Some(VdfValue::Text(text)) => Some(text),
            _ => None,
        }
    }

    /// The value at a key when it is a nested map.
    #[must_use]
    pub fn map(&self, key: &str) -> Option<&Self> {
        match self.entry(key) {
            Some(VdfValue::Map(map)) => Some(map),
            _ => None,
        }
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &VdfValue)> {
        self.entries
            .iter()
            .map(|(name, value)| (name.as_str(), value))
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

struct Reader<'a> {
    text: &'a [u8],
    at: usize,
}

#[derive(Debug, PartialEq, Eq)]
enum Token {
    Open,
    Close,
    Text(String),
}

impl Reader<'_> {
    /// Braces are tokens of their own; anything else is a key or a value. `None` at the end.
    fn next_token(&mut self) -> Option<Token> {
        while self.at < self.text.len() {
            let byte = self.text[self.at];
            if byte == b'/' && self.text.get(self.at + 1) == Some(&b'/') {
                while self.at < self.text.len() && self.text[self.at] != b'\n' {
                    self.at += 1;
                }
                continue;
            }
            if !byte.is_ascii_whitespace() {
                break;
            }
            self.at += 1;
        }
        if self.at >= self.text.len() {
            return None;
        }

        let byte = self.text[self.at];
        if byte == b'{' {
            self.at += 1;
            return Some(Token::Open);
        }
        if byte == b'}' {
            self.at += 1;
            return Some(Token::Close);
        }
        if byte == b'"' {
            return Some(Token::Text(self.read_quoted()));
        }

        let start = self.at;
        while self.at < self.text.len() {
            let byte = self.text[self.at];
            if byte.is_ascii_whitespace() || matches!(byte, b'{' | b'}' | b'"') {
                break;
            }
            self.at += 1;
        }
        Some(Token::Text(
            String::from_utf8_lossy(&self.text[start..self.at]).into_owned(),
        ))
    }

    fn read_quoted(&mut self) -> String {
        self.at += 1;
        let mut out = Vec::new();
        while self.at < self.text.len() {
            let byte = self.text[self.at];
            if byte == b'\\' {
                // Valve escapes the path separator, so `C:\\Steam` is one backslash. Only the two
                // whitespace escapes mean anything else; every other pair keeps what followed.
                match self.text.get(self.at + 1) {
                    Some(b'n') => out.push(b'\n'),
                    Some(b't') => out.push(b'\t'),
                    Some(other) => out.push(*other),
                    None => {}
                }
                self.at += 2;
                continue;
            }
            if byte == b'"' {
                self.at += 1;
                break;
            }
            out.push(byte);
            self.at += 1;
        }
        String::from_utf8_lossy(&out).into_owned()
    }

    fn read_map(&mut self, top: bool, depth: usize) -> VdfMap {
        let mut out = VdfMap::default();
        loop {
            let Some(key) = self.next_token() else {
                return out;
            };
            let key = match key {
                // A closing brace ends this map, except at the top level where it can only be stray
                // punctuation.
                Token::Close if top => continue,
                Token::Close => return out,
                Token::Open => continue,
                Token::Text(text) => text,
            };

            let Some(value) = self.next_token() else {
                return out;
            };
            let value = match value {
                Token::Open => {
                    if depth >= MAX_DEPTH {
                        // Past the bound the nesting is not something Steam wrote. Skipping the key
                        // keeps whatever was readable before it, which is what leniency means here.
                        continue;
                    }
                    VdfValue::Map(self.read_map(false, depth + 1))
                }
                Token::Close => VdfValue::Text("}".to_owned()),
                Token::Text(text) => VdfValue::Text(text),
            };
            out.insert(key, value);
        }
    }
}

#[must_use]
pub fn parse_vdf(text: &[u8]) -> VdfMap {
    Reader { text, at: 0 }.read_map(true, 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> VdfMap {
        parse_vdf(text.as_bytes())
    }

    #[test]
    fn reads_a_flat_map() {
        let map = parse("\"one\" \"1\"\n\"two\" \"2\"\n");
        assert_eq!(map.text("one"), Some("1"));
        assert_eq!(map.text("two"), Some("2"));
    }

    #[test]
    fn reads_a_nested_map() {
        let map = parse("\"libraryfolders\"\n{\n  \"0\"\n  {\n    \"path\" \"/games\"\n  }\n}\n");
        let folders = map.map("libraryfolders").expect("the outer map is present");
        let first = folders.map("0").expect("the numbered entry is present");
        assert_eq!(first.text("path"), Some("/games"));
    }

    #[test]
    fn matches_keys_case_insensitively() {
        // libraryfolders.vdf held `LibraryFolders` before it held `libraryfolders`.
        let map = parse("\"LibraryFolders\"\n{\n  \"path\" \"/games\"\n}\n");
        assert!(map.map("libraryfolders").is_some());
        assert!(map.map("LIBRARYFOLDERS").is_some());
    }

    #[test]
    fn unquotes_an_escaped_path_separator() {
        let map = parse("\"path\" \"C:\\\\Steam\\\\steamapps\"\n");
        assert_eq!(map.text("path"), Some("C:\\Steam\\steamapps"));
    }

    #[test]
    fn honours_the_two_whitespace_escapes() {
        let map = parse("\"a\" \"one\\ntwo\\tthree\"\n");
        assert_eq!(map.text("a"), Some("one\ntwo\tthree"));
    }

    #[test]
    fn skips_line_comments() {
        let map = parse("// a note\n\"one\" \"1\"\n// another\n");
        assert_eq!(map.text("one"), Some("1"));
        assert_eq!(map.len(), 1);
    }

    #[test]
    fn reads_unquoted_tokens() {
        let map = parse("one 1\ntwo 2\n");
        assert_eq!(map.text("one"), Some("1"));
        assert_eq!(map.text("two"), Some("2"));
    }

    #[test]
    fn a_repeated_key_overwrites_in_place() {
        let map = parse("\"k\" \"first\"\n\"k\" \"second\"\n");
        assert_eq!(map.text("k"), Some("second"));
        assert_eq!(map.len(), 1);
    }

    #[test]
    fn an_unterminated_string_yields_what_was_readable() {
        let map = parse("\"one\" \"1\"\n\"two\" \"unterminated");
        assert_eq!(map.text("one"), Some("1"));
        assert_eq!(map.text("two"), Some("unterminated"));
    }

    #[test]
    fn a_key_with_no_value_is_dropped_rather_than_failing() {
        let map = parse("\"one\" \"1\"\n\"dangling\"");
        assert_eq!(map.text("one"), Some("1"));
        assert_eq!(map.len(), 1);
    }

    #[test]
    fn a_stray_closing_brace_at_the_top_level_is_ignored() {
        let map = parse("}\n\"one\" \"1\"\n}\n");
        assert_eq!(map.text("one"), Some("1"));
    }

    #[test]
    fn runaway_nesting_stops_rather_than_overflowing_the_stack() {
        // A Rust stack overflow aborts the process, so the bound is what keeps a malformed file from
        // taking the application down with it.
        let text = "a{".repeat(100_000);
        let map = parse_vdf(text.as_bytes());
        assert!(!map.is_empty());
    }

    #[test]
    fn an_empty_document_is_an_empty_map() {
        assert!(parse("").is_empty());
    }
}

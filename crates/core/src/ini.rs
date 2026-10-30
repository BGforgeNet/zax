//! Lossless INI reader and writer.
//!
//! Config files belong to the user and carry hand-written comments, so anything not understood
//! passes through untouched and setting one key rewrites exactly one line. Content is carried as
//! bytes, so a file in an unknown legacy codepage round-trips byte for byte without ever being
//! decoded as something it is not.

use crate::text::{Line, fold_byte, is_space, latin1, same_name, split_lines};

/// Pieces of an entry line, kept so a value change rewrites nothing but the value.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct EntryParts {
    indent: Vec<u8>,
    key: Vec<u8>,
    separator: Vec<u8>,
    /// Inline comment after the value, with its leading whitespace, e.g. `" ; ORIGINAL 480"`.
    comment: Vec<u8>,
    trailing: Vec<u8>,
    eol: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Node {
    Blank {
        raw: Vec<u8>,
    },
    Comment {
        raw: Vec<u8>,
    },
    Section {
        name: Vec<u8>,
        raw: Vec<u8>,
    },
    Entry {
        section: Vec<u8>,
        value: Vec<u8>,
        raw: Vec<u8>,
        parts: EntryParts,
    },
    Unknown {
        raw: Vec<u8>,
    },
}

impl Node {
    fn raw(&self) -> &[u8] {
        match self {
            Self::Blank { raw }
            | Self::Comment { raw }
            | Self::Section { raw, .. }
            | Self::Entry { raw, .. }
            | Self::Unknown { raw } => raw,
        }
    }

    fn raw_mut(&mut self) -> &mut Vec<u8> {
        match self {
            Self::Blank { raw }
            | Self::Comment { raw }
            | Self::Section { raw, .. }
            | Self::Entry { raw, .. }
            | Self::Unknown { raw } => raw,
        }
    }
}

/// One entry as a reader sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub section: String,
    pub key: String,
    pub value: String,
    /// The comment block directly above the entry. sfall documents most of its settings inline, so
    /// this is the only description available for keys the catalog does not model.
    pub comment: Option<String>,
}

fn is_comment(body: &[u8]) -> bool {
    body.iter()
        .find(|&&b| !is_space(b))
        .is_some_and(|&b| b == b';' || b == b'#')
}

/// Splits a `[name]` line into its name, or `None` when the line is not a section header. The whole
/// line outside the brackets must be whitespace, and the name itself may not contain `]`.
fn parse_section(body: &[u8]) -> Option<&[u8]> {
    let open = body.iter().position(|&b| b == b'[')?;
    if !body[..open].iter().all(|&b| is_space(b)) {
        return None;
    }
    let rest = &body[open + 1..];
    let close = rest.iter().position(|&b| b == b']')?;
    if !rest[close + 1..].iter().all(|&b| is_space(b)) {
        return None;
    }
    Some(&rest[..close])
}

struct ParsedEntry {
    value: Vec<u8>,
    parts: EntryParts,
}

/// Splits an entry line into its value and the pieces that surround it, or `None` when it is not an
/// entry.
///
/// Hand-parsed rather than matched by one expression, as the TypeScript was: the natural expression
/// needs a lazy key group in front of the separator, and a backtracking engine walks a line holding
/// no `=` that ends in whitespace in quadratic time. Config files come from the user and from mod
/// archives, so their line lengths are not ours to bound.
fn parse_entry(body: &[u8]) -> Option<ParsedEntry> {
    let eq = body.iter().position(|&b| b == b'=')?;

    let mut key_start = 0;
    while key_start < eq && is_space(body[key_start]) {
        key_start += 1;
    }
    let mut key_end = eq;
    while key_end > key_start && is_space(body[key_end - 1]) {
        key_end -= 1;
    }
    // Nothing but whitespace in front of the "=" names no key, so the line is not an entry.
    if key_end == key_start {
        return None;
    }

    // The separator carries the whitespace on both sides of the "=", so writing a value disturbs
    // neither.
    let mut value_start = eq + 1;
    while value_start < body.len() && is_space(body[value_start]) {
        value_start += 1;
    }

    let mut trailing_start = body.len();
    while trailing_start > value_start && is_space(body[trailing_start - 1]) {
        trailing_start -= 1;
    }

    // The value stops at an inline comment: the first run of whitespace that a ";" or "#" follows.
    // Requiring the whitespace keeps a separator inside a value (a path, a list) from being mistaken
    // for one.
    let mut comment_start = trailing_start;
    let mut i = value_start;
    while i < trailing_start {
        if !is_space(body[i]) {
            i += 1;
            continue;
        }
        let mut after = i;
        while after < body.len() && is_space(body[after]) {
            after += 1;
        }
        if matches!(body.get(after), Some(b';' | b'#')) {
            comment_start = i;
            break;
        }
        i = after;
    }

    Some(ParsedEntry {
        value: body[value_start..comment_start].to_vec(),
        parts: EntryParts {
            indent: body[..key_start].to_vec(),
            key: body[key_start..key_end].to_vec(),
            separator: body[key_end..value_start].to_vec(),
            comment: body[comment_start..trailing_start].to_vec(),
            trailing: body[trailing_start..].to_vec(),
            eol: Vec::new(),
        },
    })
}

/// A run of six or more `X` characters is sfall's section divider, not documentation.
fn is_divider(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed.len() >= 6 && trimmed.bytes().all(|b| b == b'X')
}

/// Strips one leading comment marker and at most one space after it, matching the TypeScript's
/// `/^\s*[;#]\s?/`.
fn comment_text(raw: &[u8]) -> String {
    let mut at = 0;
    while at < raw.len() && is_space(raw[at]) {
        at += 1;
    }
    if matches!(raw.get(at), Some(b';' | b'#')) {
        at += 1;
        if raw.get(at).copied().is_some_and(is_space) {
            at += 1;
        }
    }
    let mut end = raw.len();
    while end > at && is_space(raw[end - 1]) {
        end -= 1;
    }
    latin1(&raw[at..end])
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IniDocument {
    nodes: Vec<Node>,
    /// Terminator used for lines this document adds.
    dominant_eol: Vec<u8>,
}

impl IniDocument {
    /// Parses bytes. Never fails: a line that is not understood becomes an unknown node and passes
    /// through unchanged, which is the whole point of the reader.
    #[must_use]
    pub fn parse(text: &[u8]) -> Self {
        let mut nodes = Vec::new();
        let mut crlf = 0usize;
        let mut lf = 0usize;
        let mut section: Vec<u8> = Vec::new();

        for Line { body, eol } in split_lines(text) {
            if eol == b"\r\n" {
                crlf += 1;
            } else if eol == b"\n" {
                lf += 1;
            }
            let mut raw = body.to_vec();
            raw.extend_from_slice(eol);

            if body.iter().all(|&b| is_space(b)) {
                nodes.push(Node::Blank { raw });
                continue;
            }
            if is_comment(body) {
                nodes.push(Node::Comment { raw });
                continue;
            }
            if let Some(name) = parse_section(body) {
                section = name.to_vec();
                nodes.push(Node::Section {
                    name: name.to_vec(),
                    raw,
                });
                continue;
            }
            if let Some(parsed) = parse_entry(body) {
                let mut parts = parsed.parts;
                parts.eol = eol.to_vec();
                nodes.push(Node::Entry {
                    section: section.clone(),
                    value: parsed.value,
                    raw,
                    parts,
                });
                continue;
            }
            nodes.push(Node::Unknown { raw });
        }

        let dominant_eol = if crlf >= lf && crlf > 0 {
            b"\r\n".to_vec()
        } else {
            b"\n".to_vec()
        };
        Self {
            nodes,
            dominant_eol,
        }
    }

    /// The terminator lines added by [`IniDocument::set`] carry.
    #[must_use]
    pub fn dominant_eol(&self) -> &[u8] {
        &self.dominant_eol
    }

    /// The raw value of one key, or `None` when it is not present.
    #[must_use]
    pub fn get(&self, section: &str, key: &str) -> Option<&[u8]> {
        let at = self.find_entry(section.as_bytes(), key.as_bytes())?;
        match self.nodes.get(at) {
            Some(Node::Entry { value, .. }) => Some(value.as_slice()),
            _ => None,
        }
    }

    /// The value of one key decoded for display.
    #[must_use]
    pub fn get_str(&self, section: &str, key: &str) -> Option<String> {
        self.get(section, key).map(latin1)
    }

    /// Every entry the file actually contains, with the comment block directly above it.
    #[must_use]
    pub fn entries(&self) -> Vec<Entry> {
        let mut out = Vec::new();
        for (i, node) in self.nodes.iter().enumerate() {
            let Node::Entry {
                section,
                value,
                parts,
                ..
            } = node
            else {
                continue;
            };
            let mut comment: Vec<String> = Vec::new();
            for previous in self.nodes[..i].iter().rev() {
                let Node::Comment { raw } = previous else {
                    break;
                };
                let text = comment_text(raw);
                if is_divider(&text) {
                    break;
                }
                comment.push(text);
            }
            comment.reverse();
            let joined = comment.join(" ").trim().to_owned();
            out.push(Entry {
                section: latin1(section),
                key: latin1(&parts.key),
                value: latin1(value),
                comment: if joined.is_empty() {
                    None
                } else {
                    Some(joined)
                },
            });
        }
        out
    }

    /// Every section present in the file, in order of first appearance.
    #[must_use]
    pub fn sections(&self) -> Vec<String> {
        let mut seen: Vec<Vec<u8>> = Vec::new();
        for node in &self.nodes {
            if let Node::Section { name, .. } = node
                && !seen.iter().any(|held| same_name(held, name))
            {
                seen.push(name.clone());
            }
        }
        seen.iter().map(|name| latin1(name)).collect()
    }

    /// Writes a value, rewriting one line and only when it actually differs. A missing key is
    /// appended to its section; a missing section is appended to the file.
    pub fn set(&mut self, section: &str, key: &str, value: &[u8]) {
        if let Some(at) = self.find_entry(section.as_bytes(), key.as_bytes()) {
            let Some(Node::Entry {
                value: held,
                raw,
                parts,
                ..
            }) = self.nodes.get_mut(at)
            else {
                return;
            };
            if held == value {
                return;
            }
            held.clear();
            held.extend_from_slice(value);
            // The inline comment is carried across: it is the author's note, not part of the value.
            raw.clear();
            raw.extend_from_slice(&parts.indent);
            raw.extend_from_slice(&parts.key);
            raw.extend_from_slice(&parts.separator);
            raw.extend_from_slice(value);
            raw.extend_from_slice(&parts.comment);
            raw.extend_from_slice(&parts.trailing);
            raw.extend_from_slice(&parts.eol);
            return;
        }

        let eol = self.dominant_eol.clone();
        let mut raw = Vec::new();
        raw.extend_from_slice(key.as_bytes());
        raw.push(b'=');
        raw.extend_from_slice(value);
        raw.extend_from_slice(&eol);
        let entry = Node::Entry {
            section: section.as_bytes().to_vec(),
            value: value.to_vec(),
            raw,
            parts: EntryParts {
                key: key.as_bytes().to_vec(),
                separator: b"=".to_vec(),
                eol: eol.clone(),
                ..EntryParts::default()
            },
        };

        match self.end_of_section(section.as_bytes()) {
            None => {
                if !self.nodes.is_empty() {
                    self.terminate_line(self.nodes.len() - 1);
                }
                let mut header = Vec::new();
                header.push(b'[');
                header.extend_from_slice(section.as_bytes());
                header.push(b']');
                header.extend_from_slice(&eol);
                self.nodes.push(Node::Section {
                    name: section.as_bytes().to_vec(),
                    raw: header,
                });
                self.nodes.push(entry);
            }
            Some(at) => {
                // The line inserted after need not be the file's last, but it can be: config files
                // are not required to end with a newline, and splicing after an unterminated line
                // would join two keys into one.
                if at > 0 {
                    self.terminate_line(at - 1);
                }
                self.nodes.insert(at, entry);
            }
        }
    }

    /// Writes a value given as text, encoded back to latin1.
    pub fn set_str(&mut self, section: &str, key: &str, value: &str) {
        self.set(section, key, &crate::text::latin1_bytes(value));
    }

    #[must_use]
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        for node in &self.nodes {
            out.extend_from_slice(node.raw());
        }
        out
    }

    fn find_entry(&self, section: &[u8], key: &[u8]) -> Option<usize> {
        self.nodes.iter().position(|node| {
            matches!(node, Node::Entry { section: held, parts, .. }
                if same_name(held, section) && same_name(&parts.key, key))
        })
    }

    /// Index just past the last meaningful line of a section, or `None` when the section is absent.
    fn end_of_section(&self, section: &[u8]) -> Option<usize> {
        let mut in_section = false;
        let mut last = 0;
        for (i, node) in self.nodes.iter().enumerate() {
            if let Node::Section { name, .. } = node {
                if in_section {
                    break;
                }
                in_section = same_name(name, section);
                if in_section {
                    last = i + 1;
                }
                continue;
            }
            if in_section && !matches!(node, Node::Blank { .. }) {
                last = i + 1;
            }
        }
        in_section.then_some(last)
    }

    /// Gives the node at `index` a line terminator if it lacks one, so the next line starts on its
    /// own.
    fn terminate_line(&mut self, index: usize) {
        let eol = self.dominant_eol.clone();
        let Some(node) = self.nodes.get_mut(index) else {
            return;
        };
        let raw = node.raw_mut();
        if !raw.is_empty() && !raw.ends_with(b"\n") {
            raw.extend_from_slice(&eol);
        }
    }
}

/// Lowercases a name for use as a map key, where a borrowed comparison will not do.
#[must_use]
pub fn fold(name: &str) -> String {
    name.bytes().map(|b| fold_byte(b) as char).collect()
}

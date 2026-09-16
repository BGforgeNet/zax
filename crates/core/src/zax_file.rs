//! `zax.yml`: the installs ZAX knows about and the application's own preferences.
//!
//! The file is the Python implementation's, key for key, so an existing one loads rather than the
//! application starting over with an empty list - which is a silent failure, since an empty list
//! looks exactly like a first run.
//!
//! What kind of install sits at a path is *not* stored. It is decided by reading the directory, so a
//! mod installed since the file was written is reflected rather than remembered wrongly.

use yaml_rust2::{Yaml, YamlEmitter, YamlLoader};

use crate::install::{Theme, WineConfig};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredInstall {
    pub path: String,
    /// Only what the user typed: an install left at its type's name stores nothing, so it follows
    /// the type.
    pub alias: Option<String>,
    pub wine: Option<WineConfig>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZaxFile {
    pub installs: Vec<StoredInstall>,
    pub theme: Theme,
    /// Whether an edit is written as it is made, rather than waiting for the Save button. On unless
    /// turned off.
    pub autosave: bool,
    /// Engines whose caution the user has said not to show again. Ids rather than one flag: the
    /// warnings say different things, so dismissing one must not silence the next engine that needs
    /// something said.
    pub accepted_cautions: Vec<String>,
}

impl Default for ZaxFile {
    /// The empty state, which is also what a first run has.
    fn default() -> Self {
        Self {
            installs: Vec::new(),
            theme: Theme::System,
            autosave: true,
            accepted_cautions: Vec::new(),
        }
    }
}

/// A scalar read as text, with blank treated as absent.
fn trimmed(value: &Yaml) -> Option<String> {
    let text = value.as_str()?.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

/// Reads the file, keeping whatever is well-formed and dropping the rest.
///
/// Entries are skipped one at a time rather than the file being rejected whole: one hand-edited line
/// should not cost the user every other install.
///
/// # Errors
///
/// Fails only when the YAML itself will not parse, which the caller reports - silently answering
/// with an empty state there would look like a first run and then overwrite the file the user was
/// trying to keep.
pub fn parse_zax_file(text: &str) -> Result<ZaxFile, String> {
    let documents = YamlLoader::load_from_str(text).map_err(|err| err.to_string())?;
    let Some(root) = documents.first() else {
        return Ok(ZaxFile::default());
    };
    let Some(record) = root.as_hash() else {
        return Ok(ZaxFile::default());
    };
    let field = |name: &str| record.get(&Yaml::String(name.to_owned()));

    let mut installs = Vec::new();
    for entry in field("games").and_then(Yaml::as_vec).unwrap_or(&Vec::new()) {
        let Some(fields) = entry.as_hash() else {
            continue;
        };
        let at = |name: &str| fields.get(&Yaml::String(name.to_owned())).and_then(trimmed);
        let Some(path) = at("path") else {
            continue;
        };
        let wine = WineConfig {
            prefix: at("wine_prefix"),
            debug: at("wine_debug"),
        };
        installs.push(StoredInstall {
            path,
            alias: at("alias"),
            wine: (!wine.is_empty()).then_some(wine),
        });
    }

    // Each entry checked rather than the list taken whole: one hand-edited line loses that id, not
    // the rest, which is how the installs above are read.
    let accepted_cautions = field("accepted_cautions")
        .and_then(Yaml::as_vec)
        .map(|ids| ids.iter().filter_map(trimmed).collect())
        .unwrap_or_default();

    Ok(ZaxFile {
        installs,
        accepted_cautions,
        theme: field("theme")
            .and_then(trimmed)
            .and_then(|name| Theme::from_name(&name))
            .unwrap_or(Theme::System),
        // Only an explicit false turns it off, so a file written before ZAX had the setting - the
        // Python implementation's, or a hand-edited one - reads as the default rather than as a
        // choice to save by hand.
        autosave: field("autosave").and_then(Yaml::as_bool) != Some(false),
    })
}

/// Writes the file back.
///
/// Empty Wine fields are dropped rather than written blank, so an install the user never configured
/// does not accumulate two empty keys every time anything else is saved.
#[must_use]
pub fn format_zax_file(state: &ZaxFile) -> String {
    let mut installs = state.installs.clone();
    installs.sort_by(|a, b| a.path.cmp(&b.path));

    let games: Vec<Yaml> = installs
        .iter()
        .map(|install| {
            let mut fields = yaml_rust2::yaml::Hash::new();
            let mut put = |key: &str, value: &str| {
                fields.insert(Yaml::String(key.to_owned()), Yaml::String(value.to_owned()));
            };
            put("path", &install.path);
            if let Some(alias) = &install.alias {
                put("alias", alias);
            }
            if let Some(prefix) = install.wine.as_ref().and_then(|w| w.prefix.as_ref()) {
                put("wine_prefix", prefix);
            }
            if let Some(debug) = install.wine.as_ref().and_then(|w| w.debug.as_ref()) {
                put("wine_debug", debug);
            }
            Yaml::Hash(fields)
        })
        .collect();

    let mut root = yaml_rust2::yaml::Hash::new();
    root.insert(Yaml::String("games".to_owned()), Yaml::Array(games));
    root.insert(
        Yaml::String("theme".to_owned()),
        Yaml::String(state.theme.as_str().to_owned()),
    );
    root.insert(
        Yaml::String("autosave".to_owned()),
        Yaml::Boolean(state.autosave),
    );
    // Omitted while empty rather than written as `[]`, so a file from before ZAX had the key stays
    // as it was until something is actually dismissed.
    if !state.accepted_cautions.is_empty() {
        let mut ids = state.accepted_cautions.clone();
        ids.sort();
        root.insert(
            Yaml::String("accepted_cautions".to_owned()),
            Yaml::Array(ids.into_iter().map(Yaml::String).collect()),
        );
    }

    let mut out = String::new();
    let mut emitter = YamlEmitter::new(&mut out);
    // A write that cannot fail: the sink is a String, and every value here is one the emitter can
    // represent. Nothing is left to report to.
    let _ = emitter.dump(&Yaml::Hash(root));
    // The emitter opens every document with a directives marker, which the file this replaces does
    // not carry and which a hand-editing user has never seen in it.
    let body = out.strip_prefix("---\n").unwrap_or(&out).to_owned();
    if body.ends_with('\n') {
        body
    } else {
        format!("{body}\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_document_reads_as_a_first_run() {
        assert_eq!(parse_zax_file("").expect("parse"), ZaxFile::default());
        assert_eq!(parse_zax_file("null").expect("parse"), ZaxFile::default());
    }

    #[test]
    fn yaml_that_will_not_parse_is_reported_rather_than_swallowed() {
        // Answering with an empty state would look like a first run and then overwrite the file the
        // user was trying to keep.
        assert!(parse_zax_file("games: [unclosed").is_err());
    }

    #[test]
    fn an_install_is_read_with_its_alias_and_wine_settings() {
        let text = "games:\n  - path: /games/f2\n    alias: My run\n    wine_prefix: /home/u/.wine\n    wine_debug: -all\n";
        let held = parse_zax_file(text).expect("parse");
        assert_eq!(held.installs.len(), 1);
        let install = &held.installs[0];
        assert_eq!(install.path, "/games/f2");
        assert_eq!(install.alias.as_deref(), Some("My run"));
        let wine = install.wine.as_ref().expect("wine settings");
        assert_eq!(wine.prefix.as_deref(), Some("/home/u/.wine"));
        assert_eq!(wine.debug.as_deref(), Some("-all"));
    }

    #[test]
    fn an_install_with_no_path_is_skipped_and_the_rest_survive() {
        // One hand-edited line should not cost the user every other install.
        let text = "games:\n  - alias: no path here\n  - path: /games/f2\n  - path: '   '\n";
        let held = parse_zax_file(text).expect("parse");
        assert_eq!(
            held.installs
                .iter()
                .map(|i| i.path.as_str())
                .collect::<Vec<_>>(),
            vec!["/games/f2"]
        );
    }

    #[test]
    fn an_install_with_no_wine_settings_carries_none() {
        let held = parse_zax_file("games:\n  - path: /games/f2\n").expect("parse");
        assert_eq!(held.installs[0].wine, None);
        assert_eq!(held.installs[0].alias, None);
    }

    #[test]
    fn autosave_is_on_unless_the_file_says_false() {
        // A file written before ZAX had the setting reads as the default.
        assert!(parse_zax_file("theme: dark\n").expect("parse").autosave);
        assert!(parse_zax_file("autosave: true\n").expect("parse").autosave);
        assert!(!parse_zax_file("autosave: false\n").expect("parse").autosave);
        // Anything that is not the boolean false is not a choice to save by hand.
        assert!(parse_zax_file("autosave: maybe\n").expect("parse").autosave);
    }

    #[test]
    fn an_unknown_theme_falls_back_to_system() {
        assert_eq!(
            parse_zax_file("theme: dark\n").expect("parse").theme,
            Theme::Dark
        );
        assert_eq!(
            parse_zax_file("theme: neon\n").expect("parse").theme,
            Theme::System
        );
    }

    #[test]
    fn cautions_are_kept_entry_by_entry() {
        let text = "accepted_cautions:\n  - fallout2-ce\n  - '  '\n  - 42\n  - sfall\n";
        let held = parse_zax_file(text).expect("parse");
        assert_eq!(
            held.accepted_cautions,
            vec!["fallout2-ce".to_owned(), "sfall".to_owned()]
        );
    }

    #[test]
    fn what_is_written_reads_back_the_same() {
        let state = ZaxFile {
            installs: vec![
                StoredInstall {
                    path: "/games/b".to_owned(),
                    alias: Some("Second".to_owned()),
                    wine: Some(WineConfig {
                        prefix: Some("/home/u/.wine".to_owned()),
                        debug: None,
                    }),
                },
                StoredInstall {
                    path: "/games/a".to_owned(),
                    alias: None,
                    wine: None,
                },
            ],
            theme: Theme::Dark,
            autosave: false,
            accepted_cautions: vec!["sfall".to_owned(), "fallout2-ce".to_owned()],
        };
        let text = format_zax_file(&state);
        let back = parse_zax_file(&text).expect("parse");

        // Written sorted by path, so the file does not reorder itself between saves.
        assert_eq!(
            back.installs
                .iter()
                .map(|i| i.path.as_str())
                .collect::<Vec<_>>(),
            vec!["/games/a", "/games/b"]
        );
        assert_eq!(back.theme, Theme::Dark);
        assert!(!back.autosave);
        assert_eq!(
            back.accepted_cautions,
            vec!["fallout2-ce".to_owned(), "sfall".to_owned()]
        );
        assert_eq!(back.installs[1].alias.as_deref(), Some("Second"));
    }

    #[test]
    fn an_install_the_user_never_configured_gains_no_empty_keys() {
        let state = ZaxFile {
            installs: vec![StoredInstall {
                path: "/games/f2".to_owned(),
                alias: None,
                wine: None,
            }],
            ..ZaxFile::default()
        };
        let text = format_zax_file(&state);
        assert!(!text.contains("wine_prefix"), "{text}");
        assert!(!text.contains("alias"), "{text}");
    }

    #[test]
    fn no_cautions_writes_no_key_at_all() {
        // A file from before ZAX had the key stays as it was until something is dismissed.
        let text = format_zax_file(&ZaxFile::default());
        assert!(!text.contains("accepted_cautions"), "{text}");
    }

    #[test]
    fn a_long_install_path_is_written_on_one_line() {
        // The emitter folding a long scalar is lossless but splits an install path over two lines in
        // a file people hand-edit, which is why the TypeScript set lineWidth to 0.
        let path = format!(
            "/games/{}/Fallout 2",
            "a-very-long-directory-name".repeat(8)
        );
        let state = ZaxFile {
            installs: vec![StoredInstall {
                path: path.clone(),
                alias: None,
                wine: None,
            }],
            ..ZaxFile::default()
        };
        let text = format_zax_file(&state);
        assert!(
            text.lines().any(|line| line.contains(&path)),
            "the path was folded across lines:\n{text}"
        );
        assert_eq!(parse_zax_file(&text).expect("parse").installs[0].path, path);
    }

    #[test]
    fn the_written_file_carries_no_document_marker() {
        // The file this replaces does not have one, and a hand-editing user has never seen it there.
        let text = format_zax_file(&ZaxFile::default());
        assert!(!text.starts_with("---"), "{text}");
    }
}

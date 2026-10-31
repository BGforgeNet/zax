//! A source file: one followed mod, written by ZAX's maintainers on the index branch.
//!
//! What is here is what a mod's own manifest cannot be trusted to say about itself - where it is
//! published, what it may write outside `mods/`, how a base mod installs - plus a document to stand in
//! for a manifest the author has not published. Adding one is the trust grant a ZAX release used to
//! be. Parsed strictly, as an author's manifest is: a misspelt key would otherwise drop a grant or a
//! line without a word.

use std::collections::BTreeMap;

use yaml_rust2::{Yaml, YamlLoader};
use zax_fallout2::index::IndexedLine;
use zax_fallout2::manifest::is_mod_id;
use zax_platform::{Error, Result};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Source {
    pub id: String,
    /// `owner/name` as last known; the numeric id below is what is followed.
    pub repository: String,
    /// GitHub's id for the repository, which survives a rename and is not handed to whoever registers
    /// a freed name.
    pub repository_id: u64,
    /// What to call the mod where no release can be read.
    pub name: String,
    pub base: bool,
    pub line: Option<IndexedLine>,
    /// The manifest to use for a tag the repository publishes none at, written as an author would.
    pub document: Option<String>,
    /// Asset name endings set aside before a payload or installer is inferred, for a document the
    /// maintainers wrote: what lets a release publishing two archives still have a sole payload.
    pub companions: Vec<String>,
    /// Directories outside `mods/` the mod may write.
    pub grants: Vec<String>,
    /// The load order this mod's edition states for itself.
    pub order: Option<EditionOrder>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditionOrder {
    /// The game type the order is for, as ZAX names it.
    pub game: String,
    pub entries: Vec<String>,
}

const FIELDS: &[&str] = &[
    "id",
    "repository",
    "repository-id",
    "name",
    "base",
    "line",
    "document",
    "companions",
    "grants",
    "order",
];

fn refuse<T>(file: &str, why: &str) -> Result<T> {
    Err(Error::Unsupported(format!("{file}: {why}")))
}

fn text_list(value: &Yaml, file: &str, what: &str) -> Result<Vec<String>> {
    let Some(items) = value.as_vec() else {
        return refuse(file, &format!("\"{what}\" must be a list"));
    };
    items
        .iter()
        .map(|item| match item.as_str() {
            Some(text) => Ok(text.to_owned()),
            None => refuse(
                file,
                &format!("\"{what}\" holds something that is not text"),
            ),
        })
        .collect()
}

fn mapping<'a>(
    value: &'a Yaml,
    file: &str,
    what: &str,
    allowed: &[&str],
) -> Result<BTreeMap<String, &'a Yaml>> {
    let Some(hash) = value.as_hash() else {
        return refuse(file, &format!("{what} must be a mapping"));
    };
    let mut out = BTreeMap::new();
    for (key, held) in hash {
        let Some(name) = key.as_str() else {
            return refuse(file, &format!("{what} has a key that is not text"));
        };
        if !allowed.contains(&name) {
            return refuse(file, &format!("{what} has an unknown field \"{name}\""));
        }
        out.insert(name.to_owned(), held);
    }
    Ok(out)
}

/// Reads one source file. `file` names it in every refusal.
///
/// # Errors
///
/// Fails on anything but a source this indexer can act on, naming the field.
pub fn parse_source(text: &str, file: &str) -> Result<Source> {
    let documents = YamlLoader::load_from_str(text)
        .map_err(|err| Error::Unsupported(format!("{file}: it does not parse ({err})")))?;
    let Some(root) = documents.first() else {
        return refuse(file, "it is empty");
    };
    let fields = mapping(root, file, "the source", FIELDS)?;
    let text_of = |key: &str| -> Result<String> {
        match fields.get(key).and_then(|held| held.as_str()) {
            Some(held) => Ok(held.to_owned()),
            None => refuse(file, &format!("\"{key}\" is missing or not text")),
        }
    };

    let id = text_of("id")?;
    if !is_mod_id(&id) {
        return refuse(file, &format!("\"id\" (\"{id}\") is not an id"));
    }
    let repository = text_of("repository")?;
    if repository.split('/').count() != 2 {
        return refuse(file, "\"repository\" is not owner/name");
    }
    let repository_id = match fields.get("repository-id") {
        Some(Yaml::Integer(held)) if *held > 0 => u64::try_from(*held).map_err(|_| {
            Error::Unsupported(format!("{file}: \"repository-id\" is out of range"))
        })?,
        _ => {
            return refuse(
                file,
                "\"repository-id\" is missing or not a positive number",
            );
        }
    };
    let line = match fields.get("line") {
        None => None,
        Some(held) => {
            let parts = mapping(held, file, "\"line\"", &["prefix", "counter"])?;
            let Some(prefix) = parts.get("prefix").and_then(|held| held.as_str()) else {
                return refuse(file, "\"line\" has no \"prefix\"");
            };
            Some(IndexedLine {
                prefix: prefix.to_owned(),
                counter: parts
                    .get("counter")
                    .and_then(|held| held.as_bool())
                    .unwrap_or(false),
            })
        }
    };
    let order = match fields.get("order") {
        None => None,
        Some(held) => {
            let parts = mapping(held, file, "\"order\"", &["game", "entries"])?;
            let Some(game) = parts.get("game").and_then(|held| held.as_str()) else {
                return refuse(file, "\"order\" has no \"game\"");
            };
            let Some(entries) = parts.get("entries") else {
                return refuse(file, "\"order\" has no \"entries\"");
            };
            Some(EditionOrder {
                game: game.to_owned(),
                entries: text_list(entries, file, "order.entries")?,
            })
        }
    };
    let list = |key: &str| -> Result<Vec<String>> {
        fields
            .get(key)
            .map_or_else(|| Ok(Vec::new()), |held| text_list(held, file, key))
    };

    Ok(Source {
        name: text_of("name")?,
        base: fields
            .get("base")
            .and_then(|held| held.as_bool())
            .unwrap_or(false),
        document: match fields.get("document") {
            None => None,
            Some(held) => Some(held.as_str().map(ToOwned::to_owned).ok_or_else(|| {
                Error::Unsupported(format!(
                    "{file}: \"document\" must be the manifest's text, as a block"
                ))
            })?),
        },
        companions: list("companions")?,
        grants: list("grants")?,
        id,
        repository,
        repository_id,
        line,
        order,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const RPU24: &str = "\
id: rpu24
repository: BGforgeNet/Fallout2_Restoration_Project
repository-id: 193099881
name: RPU 2.4
base: true
line: { prefix: \"2.4.\", counter: false }
companions: [_translations.zip]
order: { game: fallout2rpu, entries: [rpu.dat, upu.dat] }
document: |
  spec: 1
  game: fallout2
  id: rpu24
  name: RPU 2.4
";

    #[test]
    fn a_source_reads_every_field() {
        let source = parse_source(RPU24, "rpu24.yml").expect("a source");
        assert_eq!(source.repository_id, 193_099_881);
        assert!(source.base);
        assert_eq!(
            source.line,
            Some(IndexedLine {
                prefix: "2.4.".to_owned(),
                counter: false
            })
        );
        assert_eq!(source.companions, vec!["_translations.zip".to_owned()]);
        assert_eq!(
            source.order.map(|order| order.game),
            Some("fallout2rpu".to_owned())
        );
        assert!(
            source
                .document
                .is_some_and(|text| text.contains("id: rpu24"))
        );
    }

    #[test]
    fn a_misspelt_key_refuses_naming_it() {
        let err = parse_source(&format!("{RPU24}grnats: [data]\n"), "rpu24.yml")
            .expect_err("a misspelling");
        assert!(err.to_string().contains("\"grnats\""), "{err}");
    }

    #[test]
    fn a_source_without_its_repository_id_refuses() {
        let text = "id: a\nrepository: o/a\nname: A\n";
        assert!(parse_source(text, "a.yml").is_err());
    }
}

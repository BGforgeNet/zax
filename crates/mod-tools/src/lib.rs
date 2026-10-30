//! What a mod author checks before a release: that a `f2mod.yml` reads the way ZAX will read it, and
//! that the ini files it describes agree with it. The judgement is the application's own - the parser
//! and `mod_ini` - and this adds only the report around it, so `pnpm check-manifest`, `pnpm mod-ini` and
//! the mod-ini action cannot come to an answer ZAX would not.

use std::collections::BTreeMap;

use zax_fallout2::manifest::{ManifestDefaults, ModManifest, ModType, Pick, parse_manifest};
use zax_fallout2::mod_ini::{IniMatch, check_mod_ini, generate_mod_ini};

/// A committed manifest states no version, since its tag does, and names no archive, since the
/// release's sole one is taken - so it is described with both supplied, as its release will be read.
fn release_defaults() -> ManifestDefaults {
    ManifestDefaults {
        version: Some("0".to_owned()),
        archive: Some("payload.zip".to_owned()),
    }
}

/// The ini judgement depends on neither value, so only the one a committed manifest cannot state is
/// supplied, and an archive it does name is read as written.
fn committed_defaults() -> ManifestDefaults {
    ManifestDefaults {
        version: Some("0".to_owned()),
        archive: None,
    }
}

/// The report `pnpm check-manifest` prints for an accepted manifest, a line each.
///
/// # Errors
///
/// Answers with the parser's own refusal, word for word.
pub fn describe_manifest(bytes: &[u8]) -> Result<Vec<String>, String> {
    // Read as written first, so a manifest that does state its version reports it. Only a manifest
    // the release's values rescue counts as waiting on its tag; anything else refused both ways
    // reports the refusal of the file as written.
    let (manifest, tagged) = match parse_manifest(bytes, &ManifestDefaults::default()) {
        Ok(manifest) => (manifest, false),
        Err(refusal) => match parse_manifest(bytes, &release_defaults()) {
            Ok(manifest) => (manifest, true),
            Err(_) => return Err(refusal.to_string()),
        },
    };

    let version = if tagged {
        "(version from the tag)"
    } else {
        manifest.version.as_str()
    };
    let payload = payload_of(&manifest, tagged);
    let mut lines = vec![format!(
        "OK: {} {version} ({}); payload: {payload}; {} setting(s), {} conflict rule(s)",
        manifest.id,
        type_name(manifest.mod_type),
        manifest.settings.len(),
        manifest.conflicts.len()
    )];

    // Spelled out because a part id is permanent and an author's first sight of one is here: what this
    // prints is what every future release has to keep naming, and what an install records.
    for group in manifest.parts.as_deref().unwrap_or_default() {
        let parts = group
            .options
            .iter()
            .map(|part| format!("{} -> {}", part.id, part.archive))
            .collect::<Vec<_>>()
            .join(", ");
        lines.push(format!(
            "  {} (pick {}): {parts}",
            group.label,
            pick_name(group.pick)
        ));
    }

    // What a creating mod makes and asks for, since neither is visible in the payload it names: the
    // directory is the bound every write passes, and each input is a question the user is put to.
    if let Some(creates) = &manifest.creates {
        let becomes = manifest.becomes.map_or("", |kind| kind.as_str());
        lines.push(format!(
            "  creates {}/ beside the install, reporting as {becomes}",
            creates.directory
        ));
        for input in manifest.inputs.as_deref().unwrap_or_default() {
            lines.push(format!(
                "  asks for {}: {} ({})",
                input.id, input.label, input.holds
            ));
        }
        if let Some(extract) = &manifest.extract_dat {
            lines.push(format!(
                "  unpacks {}'s archive into {}/{}, as {} names",
                extract.from, creates.directory, extract.into, extract.list
            ));
        }
    }

    // Not a refusal: the mod installs and these controls do not appear. Reported because an author
    // writing to a later spec would otherwise see a clean OK and no sign the schema was trimmed.
    for gone in &manifest.dropped {
        lines.push(format!("  dropped \"{}\": {}", gone.address, gone.why));
    }
    Ok(lines)
}

fn payload_of(manifest: &ModManifest, tagged: bool) -> String {
    if let Some(installer) = &manifest.installer {
        let from_release = "(asset from the release)";
        let mut routes = Vec::new();
        if let Some(windows) = &installer.windows {
            routes.push(format!(
                "windows: {}",
                windows.asset.as_deref().unwrap_or(from_release)
            ));
        }
        if let Some(other) = &installer.other {
            routes.push(format!(
                "other: {}",
                other.asset.as_deref().unwrap_or(from_release)
            ));
        }
        return routes.join(", ");
    }
    if let Some(groups) = &manifest.parts {
        let count: usize = groups.iter().map(|group| group.options.len()).sum();
        return format!("{count} part(s), each naming its own asset");
    }
    if tagged {
        return "(payload from the release)".to_owned();
    }
    manifest.archive.clone().unwrap_or_else(|| {
        "no \"archive\" named - valid, but a release without one cannot offer a download".to_owned()
    })
}

const fn type_name(kind: ModType) -> &'static str {
    match kind {
        ModType::Pluggable => "pluggable",
        ModType::Permanent => "permanent",
        ModType::Base => "base",
    }
}

const fn pick_name(pick: Pick) -> &'static str {
    match pick {
        Pick::One => "one",
        Pick::Any => "any",
    }
}

/// `soft` or `hard`, as the command line and the action spell them.
#[must_use]
pub fn ini_match(name: &str) -> Option<IniMatch> {
    match name {
        "soft" => Some(IniMatch::Soft),
        "hard" => Some(IniMatch::Hard),
        _ => None,
    }
}

const fn match_name(match_: IniMatch) -> &'static str {
    match match_ {
        IniMatch::Soft => "soft",
        IniMatch::Hard => "hard",
    }
}

/// What a check found, as lines for standard output and for standard error.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Checked {
    pub ok: bool,
    pub said: Vec<String>,
    pub complaints: Vec<String>,
}

/// Measures the ini files `read` returns against the manifest, `manifest_name` being what the
/// report calls it.
#[must_use]
pub fn check_ini(
    manifest_bytes: &[u8],
    manifest_name: &str,
    match_: IniMatch,
    read: &dyn Fn(&str) -> Option<Vec<u8>>,
) -> Checked {
    let manifest = match parse_manifest(manifest_bytes, &committed_defaults()) {
        Ok(manifest) => manifest,
        Err(refusal) => {
            return Checked {
                ok: false,
                said: Vec::new(),
                complaints: vec![refusal.to_string()],
            };
        }
    };
    let report = check_mod_ini(&manifest, read, match_);
    let how = match_name(match_);
    if !report.mismatches.is_empty() {
        let count = report.mismatches.len();
        let mut complaints = report.mismatches;
        complaints.push(format!(
            "{count} mismatch(es) between {manifest_name} and its ini ({how})."
        ));
        return Checked {
            ok: false,
            said: Vec::new(),
            complaints,
        };
    }
    // Said on success too, because a soft pass over a file the schema barely covers looks the same as
    // a full one.
    let left = if match_ == IniMatch::Soft && report.undescribed > 0 {
        format!("; {} entry(ies) not described", report.undescribed)
    } else {
        String::new()
    };
    Checked {
        ok: true,
        said: vec![format!(
            "OK: {} setting(s) match {} ({how}{left}).",
            manifest.settings.len(),
            report.files.join(", ")
        )],
        complaints: Vec::new(),
    }
}

/// The ini files written from the manifest, by the name its settings address them under, and how many
/// settings they carry.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Generated {
    pub files: BTreeMap<String, Vec<u8>>,
    pub settings: usize,
}

/// # Errors
///
/// Answers with the parser's refusal, or the generator's, for the author.
pub fn generate_ini(
    manifest_bytes: &[u8],
    existing: &dyn Fn(&str) -> Option<Vec<u8>>,
) -> Result<Generated, String> {
    let manifest = parse_manifest(manifest_bytes, &committed_defaults())
        .map_err(|refusal| refusal.to_string())?;
    let files = generate_mod_ini(&manifest, existing)?;
    Ok(Generated {
        files,
        settings: manifest.settings.len(),
    })
}

#[cfg(target_arch = "wasm32")]
mod wasm;

#[cfg(test)]
mod tests;

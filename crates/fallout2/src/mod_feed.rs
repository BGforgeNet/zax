//! Where mods come from, and whether this install can take them.
//!
//! Every mod ZAX offers comes from one document, the mod index, which ZAX's maintainers build from the
//! repositories they follow: which mods exist, each release's manifest with every value explicit, and
//! where its files are with their digests. Being listed there is the trust grant; nothing here reads a
//! repository, a tag or an asset name, so a rule about any of those changes in the indexer rather than
//! in every copy of ZAX already installed.
//!
//! The index is cached with a short life, and a stale copy answers when the network cannot: a listing
//! that worked yesterday beats an empty tab today, and the install re-verifies every download against
//! its digest anyway.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use zax_core::install::{GameType, Install};
use zax_core::version::compare_versions;
use zax_platform::fs::FileKind;
use zax_platform::{Error, Platform, Result};

use crate::base_version::{BaseVersion, installed_base_version};
use crate::index::{Index, IndexedLine, IndexedMod, generated_millis, read_index, read_release};
use crate::manifest::ModPart;
use crate::manifest::{ModInput, ModManifest, ModType, is_mod_version, part_options};
use crate::mod_choice::ChoiceGroup;
use crate::mod_created::{created_install_path, no_upgrade_here};
use crate::mod_parts::{CarriedSelection, carry_over, offered_parts};
use crate::mods::{MODS_DIRECTORY, answers_to_id};
use crate::records::{InstallRecord, manifest_of};

/// The index every copy of ZAX reads: the file itself on the repository's `index` branch.
pub const INDEX_URL: &str = "https://raw.githubusercontent.com/BGforgeNet/zax/index/v1/index.json";

/// Which of the two installer routes a host takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "lowercase")]
pub enum InstallerRoute {
    Windows,
    Other,
}

/// A base mod's installer for the platform ZAX is running on, and which of the two routes it is.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct ReleaseInstaller {
    pub route: InstallerRoute,
    pub asset: ReleaseAsset,
}

/// One release as ZAX holds it: the parsed manifest, its exact bytes, and where the payload is.
#[derive(Debug, Clone, PartialEq)]
pub struct ModRelease {
    pub manifest: ModManifest,
    /// The manifest's text as fetched - recorded with the install and pinned by an open transaction.
    pub manifest_text: String,
    /// The payload asset the manifest names, with what the release states about it.
    pub archive: Option<ReleaseAsset>,
    /// A part's asset by part id, for a manifest that declares parts. Only the parts this release
    /// actually publishes are here: a release missing one asset still offers the others, rather than
    /// nothing. Empty for a manifest declaring none.
    pub parts: BTreeMap<String, ReleaseAsset>,
    /// Resolved here rather than at the install so eligibility can say "not for this system" without
    /// downloading anything.
    pub installer: Option<ReleaseInstaller>,
    /// The route this host would take, kept even where its asset did not resolve. Without it a miss
    /// cannot be told from a mod that does not install here at all, and the two send the reader to
    /// different places.
    pub installer_route: Option<InstallerRoute>,
    /// The release line this came from: an install stamping another line's version is another mod
    /// rather than an older copy of this one.
    pub line: Option<IndexedLine>,
    /// Where this release stands among its mod's, higher being newer, and every listed version's
    /// standing: the only ordering ZAX applies to a mod's versions. Empty for a release rebuilt from an
    /// open transaction, which nothing compares.
    pub rank: u64,
    pub ranks: BTreeMap<String, u64>,
}

/// How this release compares with another version of its mod: by equality, then by the index's ranks.
/// Nothing where the index does not list the other, which no rule here could order.
#[must_use]
pub fn compare_listed(release: &ModRelease, version: &str) -> Option<Ordering> {
    if release.manifest.version == version {
        return Some(Ordering::Equal);
    }
    release
        .ranks
        .get(version)
        .map(|other| release.rank.cmp(other))
}

const INDEX_CACHE_MS: i64 = 30 * 60 * 1000;

/// Where the index is cached. Public because a host can seed this cache instead of answering the
/// network for it, and it must write the path the reader reads.
#[must_use]
pub fn index_cache_path(platform: &dyn Platform) -> PathBuf {
    platform.paths().cache().join("mod-index.json")
}

/// The index, from the cache while it is fresh, the network when it is not, and the stale cache again
/// when the network refuses.
///
/// # Errors
///
/// Fails where neither the network nor a cached copy answers, or where what answered is not an index
/// this version reads.
pub fn read_mod_index(platform: &dyn Platform, now: i64) -> Result<Index> {
    let cache_path = index_cache_path(platform);
    let cached = platform.fs().stat(&cache_path)?;
    let held = cached.is_some_and(|stat| stat.kind == FileKind::File);
    if let Some(stat) = cached
        && stat.kind == FileKind::File
        && now - stat.modified < INDEX_CACHE_MS
    {
        return read_index(&String::from_utf8_lossy(&platform.fs().read(&cache_path)?));
    }
    let body = match platform.net().fetch_text(INDEX_URL) {
        Ok(body) => body,
        Err(err) => {
            if matches!(err, Error::Network(_)) && held {
                return read_index(&String::from_utf8_lossy(&platform.fs().read(&cache_path)?));
            }
            return Err(err);
        }
    };
    // Read before it is kept, so a document this version cannot use never replaces one it can.
    let index = read_index(&body)?;
    platform.fs().write(&cache_path, body.as_bytes())?;
    Ok(index)
}

/// The editions' load orders as the last index read states them, however old, keyed as the index keys
/// them. Empty where no index was ever read: an order nobody has stated leaves every entry unranked,
/// which is where a mods folder stands without one anyway.
///
/// # Errors
///
/// Fails where a cached index is there but cannot be read from disk.
pub fn held_orders(platform: &dyn Platform) -> Result<BTreeMap<String, Vec<String>>> {
    let cache_path = index_cache_path(platform);
    if platform.fs().stat(&cache_path)?.map(|stat| stat.kind) != Some(FileKind::File) {
        return Ok(BTreeMap::new());
    }
    let text = String::from_utf8_lossy(&platform.fs().read(&cache_path)?).into_owned();
    // Kept only after it read, so a copy that no longer does is one a newer version wrote; its orders
    // are not this version's to apply.
    Ok(read_index(&text)
        .map(|index| index.orders)
        .unwrap_or_default())
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct ReleaseAsset {
    pub name: String,
    pub url: String,
    /// GitHub states `sha256:<hex>`; kept verbatim and split where it is checked.
    pub digest: Option<String>,
    pub size: Option<u64>,
}

/// Payload assets ZAX can open. Anything else on a release - checksums, signatures, notes - is not a
/// payload.
const ARCHIVE_SUFFIXES: &[&str] = &[".zip", ".7z", ".rar", ".tar.gz", ".tgz", ".tar"];

/// Whether an asset is one 7-Zip opens. A payload that is not is a single file, deployed as it stands.
#[must_use]
pub fn is_archive_name(name: &str) -> bool {
    let name = name.to_lowercase();
    ARCHIVE_SUFFIXES.iter().any(|end| name.ends_with(end))
}

/// The payload when the manifest does not name one: a release's sole archive-shaped asset. Two of them
/// is an ambiguity only the author can settle, so the manifest's `archive` stays in the format for that
/// case - and so does a release of loose files, where nothing distinguishes the payload from anything
/// else published.
fn sole(assets: &[ReleaseAsset], wanted: impl Fn(&str) -> bool) -> Option<&ReleaseAsset> {
    let mut matching = assets.iter().filter(|asset| wanted(&asset.name));
    let first = matching.next()?;
    matching.next().is_none().then_some(first)
}

#[must_use]
pub fn sole_archive(assets: &[ReleaseAsset]) -> Option<&ReleaseAsset> {
    sole(assets, is_archive_name)
}

/// The Windows installer when the manifest does not name one, under the same rule as the payload: a
/// release's sole executable. Matched on the shape rather than on `built-with`, which would be a table
/// with one row - and a toolkit this version does not know refuses at parse, so the guess never reaches
/// an unknown one.
#[must_use]
pub fn sole_executable(assets: &[ReleaseAsset]) -> Option<&ReleaseAsset> {
    sole(assets, |name| name.to_lowercase().ends_with(".exe"))
}

/// Which route a host takes. Both exist because upstream publishes both, and a host is on one or the
/// other.
fn route_for(platform: &dyn Platform) -> InstallerRoute {
    if platform.os() == zax_platform::OperatingSystem::Windows {
        InstallerRoute::Windows
    } else {
        InstallerRoute::Other
    }
}

/// What the manifest declares for a route: whether it declares one at all, and the asset it names.
fn declared_installer(manifest: &ModManifest, route: InstallerRoute) -> Option<Option<&str>> {
    let installer = manifest.installer.as_ref()?;
    match route {
        InstallerRoute::Windows => installer.windows.as_ref().map(|one| one.asset.as_deref()),
        InstallerRoute::Other => installer.other.as_ref().map(|one| one.asset.as_deref()),
    }
}

/// A tag's version: `v14.7` is 14.7. A tag shaped like anything else names no version and is passed
/// over.
#[must_use]
pub fn version_from_tag(tag: &str) -> Option<String> {
    let version = tag
        .strip_prefix('v')
        .or_else(|| tag.strip_prefix('V'))
        .unwrap_or(tag);
    is_mod_version(version).then(|| version.to_owned())
}

/// Which of a base manifest's routes this host takes, and the asset it resolves to - or nothing for a
/// miss.
fn installer_for(
    route: InstallerRoute,
    manifest: &ModManifest,
    assets: &[ReleaseAsset],
) -> Option<ReleaseInstaller> {
    // Named, never inferred: the indexer writes the asset it took into every manifest it serves.
    let named = declared_installer(manifest, route)??;
    let asset = assets.iter().find(|entry| entry.name == named)?;
    Some(ReleaseInstaller {
        route,
        asset: asset.clone(),
    })
}

/// Why there is no installer to run here, told apart by what the manifest declares. A mod with no route
/// for this platform does not install here at all; a route whose asset is missing from the release is
/// the author's mistake, not the user's system. One message for both sends half its readers to look in
/// the wrong place.
#[must_use]
pub fn installer_miss(manifest: &ModManifest, route: Option<InstallerRoute>) -> String {
    let Some(declared) = route.and_then(|route| declared_installer(manifest, route)) else {
        return format!("{} does not install on this system.", manifest.name);
    };
    let what = match route {
        Some(InstallerRoute::Windows) => "Windows installer",
        _ => "installer for this system",
    };
    if let Some(named) = declared {
        return format!(
            "{} names \"{named}\" as its {what}, which this release does not publish.",
            manifest.name
        );
    }
    let shape = match route {
        Some(InstallerRoute::Windows) => "executable",
        _ => "archive",
    };
    format!(
        "{}'s {what} names no asset, and this release publishes no single {shape} to take as one.",
        manifest.name
    )
}

/// One listed release as ZAX installs it: read and checked through the index's own reader, with the
/// installer route this host takes resolved. The listed versions' ranks come along, so where it stands
/// against what is installed needs nothing more.
///
/// # Errors
///
/// Fails where the release needs what this version lacks, or where its manifest is refused.
pub fn release_from_index(
    platform: &dyn Platform,
    listed: &IndexedMod,
    at: usize,
) -> Result<ModRelease> {
    let Some(release) = listed.releases.get(at) else {
        return Err(Error::Unsupported(format!(
            "The index lists no such release of {}.",
            listed.name
        )));
    };
    let read = read_release(listed, release)?;
    let manifest = read.manifest;
    let find = |name: &str| read.assets.iter().find(|asset| asset.name == name).cloned();
    let archive = manifest.archive.as_deref().and_then(find);
    let parts = part_options(&manifest)
        .into_iter()
        .filter_map(|part| find(&part.archive).map(|asset| (part.id.clone(), asset)))
        .collect();
    let route = route_for(platform);
    let installer = installer_for(route, &manifest, &read.assets);
    let installer_route = declared_installer(&manifest, route).map(|_| route);
    Ok(ModRelease {
        manifest_text: read.manifest_text,
        line: listed.line.clone(),
        archive,
        parts,
        installer,
        installer_route,
        manifest,
        rank: release.rank,
        ranks: listed
            .releases
            .iter()
            .map(|one| (one.version.clone(), one.rank))
            .collect(),
    })
}

/// A mod's current release: the newest listed one this version can install. Older ones stay
/// installable by a version of ZAX that predates a feature a newer one uses.
///
/// # Errors
///
/// Fails where no listed release can be read, with the newest one's reason.
pub fn current_release(platform: &dyn Platform, listed: &IndexedMod) -> Result<ModRelease> {
    let mut first_refusal = None;
    for at in 0..listed.releases.len() {
        match release_from_index(platform, listed, at) {
            Ok(release) => return Ok(release),
            Err(err) => {
                first_refusal.get_or_insert(err);
            }
        }
    }
    Err(first_refusal.unwrap_or_else(|| {
        Error::Unsupported(format!("The index lists no release of {}.", listed.name))
    }))
}

fn listed_mod<'a>(index: &'a Index, id: &str) -> Result<&'a IndexedMod> {
    index
        .mods
        .iter()
        .find(|listed| listed.id == id)
        .ok_or_else(|| Error::Unsupported(format!("The mod index does not list \"{id}\".")))
}

/// Every version the index lists for a mod, newest first.
///
/// # Errors
///
/// Fails where the index does not list the mod.
pub fn list_mod_versions(index: &Index, id: &str) -> Result<Vec<String>> {
    Ok(listed_mod(index, id)?
        .releases
        .iter()
        .map(|release| release.version.clone())
        .collect())
}

/// The listed release naming one particular version, for installing something other than the newest.
///
/// # Errors
///
/// Fails where the index does not list the mod or the version, or where that release cannot be read.
pub fn release_named(
    platform: &dyn Platform,
    index: &Index,
    id: &str,
    version: &str,
) -> Result<ModRelease> {
    let listed = listed_mod(index, id)?;
    let Some(at) = listed
        .releases
        .iter()
        .position(|release| release.version == version)
    else {
        return Err(Error::Unsupported(format!(
            "The mod index lists no {} {version}.",
            listed.name
        )));
    };
    release_from_index(platform, listed, at)
}

/// What the interface offers for one mod on one install, decided from what is already known.
///
/// Tagged with the kind, which is the field every surface branches on, and spelled the way the
/// interface reads it: `install-over` rather than `installOver`, as the TypeScript named them.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Availability {
    Install,
    /// Present without a record - hand-installed - so the offer is the latest release laid over it.
    InstallOver,
    /// A build from between releases, named by the commit it was built from - see `base_version`.
    Nightly {
        commit: String,
    },
    Installed,
    Upgrade {
        from: String,
    },
    /// Recorded at one type and offered at another. The version rises, but what the install *is*
    /// changes with it - a mod taking its own removability away, and later a stacking mod becoming a
    /// base one - so the offer names the change instead of calling it an update. `was` is what is on
    /// disk, which is what decides whether it can still be removed.
    Convert {
        from: String,
        was: ModType,
    },
    /// The index offering an older version than the record - what a rolled-back index looks like.
    Downgrade {
        from: String,
    },
    /// Installed at a version the index does not list, so nothing can say whether the offer is newer:
    /// it is offered in that one's place without calling it an upgrade.
    Unlisted {
        from: String,
    },
    /// An install that never finished; the working directory decides between resume and restore.
    Retry {
        version: String,
    },
    /// Recorded as installed while the index does not list the id - still removable, never updatable.
    Unfollowed,
    /// ZAX refuses this release. `from` is what the record says is installed, which several of these
    /// arms sit in front of - the sfall gate answers before the version comparison, so a refused row is
    /// often an installed mod. Absent where nothing is installed, or where the refusal is the install
    /// type and no version applies.
    Blocked {
        why: String,
        from: Option<String>,
    },
}

#[derive(Debug, Clone)]
pub struct ModContext<'a> {
    pub install: &'a Install,
    pub record: &'a InstallRecord,
    /// The installed sfall version, or nothing when the install has none.
    pub sfall: Option<&'a str>,
    /// Whether anything under `mods/` answers to the mod's name - the hand-installed case.
    pub present: bool,
    /// What a base install says about itself in `ddraw.ini`, where ZAX has no record of installing it.
    /// This is the common state rather than an edge: upstream's Windows route is an exe installer, so
    /// most base installs were never ZAX's, and without this they are a game type with no version and
    /// no update on offer. The outer `None` is "nothing read it"; the inner one is "read, and it stamps
    /// nothing".
    pub base_version: Option<Option<BaseVersion>>,
}

/// Whether a lined base mod is this installation's to offer: its own line's stamp, or - for the line
/// the pre-split history belongs to - an installation stating no version at all, which no later line
/// ever wrote.
fn offered_on_line(line: &IndexedLine, held: Option<&BaseVersion>) -> bool {
    match held {
        Some(BaseVersion::Release { version }) => line.holds(version),
        _ => line.counter,
    }
}

/// A refusal that carries the installed version along with it; `blocked_by_type` has none to carry.
fn refuse(why: String, from: Option<String>) -> Availability {
    Availability::Blocked { why, from }
}

#[must_use]
#[expect(
    clippy::too_many_lines,
    reason = "one decision with many arms, each a sentence about what the install already holds; \
              splitting it would put the order the arms answer in out of one reader's sight"
)]
pub fn availability(release: &ModRelease, context: &ModContext<'_>) -> Availability {
    let manifest = &release.manifest;
    let held = context.record.mods.iter().find(|one| one.id == manifest.id);
    // A created install the user deleted by hand is gone, whatever the record says - and deleting that
    // folder is exactly what ZAX tells them to do, since it will not remove one itself. The directory
    // decides, and a record describing a folder that is not there would otherwise report it installed
    // for good.
    let recorded = if manifest.creates.is_some() && !context.present {
        None
    } else {
        held
    };

    if let Some(recorded) = recorded
        && !recorded.complete
    {
        return Availability::Retry {
            version: recorded.version.clone(),
        };
    }

    // The sfall requirement is the new release's and binds upgrades too; the updater answers it either
    // way.
    if let Some(wanted) = &manifest.requires_sfall {
        let behind = context
            .sfall
            .is_none_or(|have| compare_versions(have, wanted) == Ordering::Less);
        if behind {
            let has = context.sfall.unwrap_or("none");
            return refuse(
                format!(
                    "{} needs sfall {wanted} or newer - this install has {has}. ZAX's sfall updater \
                     can raise it first.",
                    manifest.name
                ),
                recorded.map(|one| one.version.clone()),
            );
        }
    }

    // A recorded version the index does not list cannot be ordered against the offer; the arms below
    // still decide whether it can be offered at all, and the last one says which kind of offer it is.
    let mut unlisted = false;
    if let Some(recorded) = recorded {
        match compare_listed(release, &recorded.version) {
            Some(Ordering::Less) => {
                return Availability::Downgrade {
                    from: recorded.version.clone(),
                };
            }
            Some(Ordering::Equal) => return Availability::Installed,
            Some(Ordering::Greater) => {}
            None => unlisted = true,
        }
    }

    // A mod that creates an install answers from the created directory's own stamp, and it answers
    // here - before the offers below - so an install already at this version reads as installed even on
    // a host where a later step could not run. A stamp the index does not list falls to the refusal
    // below, which names it.
    if manifest.creates.is_some()
        && let Some(Some(BaseVersion::Release { version })) = &context.base_version
    {
        match compare_listed(release, version) {
            Some(Ordering::Equal) => return Availability::Installed,
            Some(Ordering::Less) => {
                return Availability::Downgrade {
                    from: version.clone(),
                };
            }
            Some(Ordering::Greater) | None => {}
        }
    }

    // An install this mod made is installed once. Every arm above answers where the version on disk is
    // this release's or newer; anything else would be laying a release over a whole game, and there is
    // no such operation to offer - upstream publishes an unpack into a folder that has none and nothing
    // else, and doing it anyway would overwrite the mod's own configuration and load order with the
    // release's defaults.
    //
    // Any of the three is that install being there: a record of it, a version stamped in it, or the
    // directory itself. A reading that found no stamp is not the second.
    if manifest.creates.is_some()
        && (recorded.is_some() || matches!(context.base_version, Some(Some(_))) || context.present)
    {
        let stamped = match &context.base_version {
            Some(Some(BaseVersion::Release { version })) => Some(version.clone()),
            _ => None,
        };
        return refuse(
            no_upgrade_here(manifest, context.install.game_type),
            recorded.map(|one| one.version.clone()).or(stamped),
        );
    }

    // Everything from here on is an offer to download, which a release that never names its payload
    // cannot make. For a parts release the payload is whatever parts resolved: one asset short is not
    // nothing to install.
    if manifest.creates.is_some() {
        // Its payload is an ordinary archive, so the archive check below is the one that applies - said
        // here because the installer arm is the other kind of base mod's and does not fit this one.
        if release.archive.is_none() {
            return refuse(
                format!(
                    "The {} release does not say which of its files is the mod.",
                    manifest.name
                ),
                recorded.map(|one| one.version.clone()),
            );
        }
    } else if manifest.mod_type == ModType::Base {
        // A base mod's payload is its installer, and a release that publishes one for another system is
        // not a release that named nothing - the mod is real and this machine cannot run it, which is
        // what it says.
        if release.installer.is_none() {
            return refuse(
                installer_miss(manifest, release.installer_route),
                recorded.map(|one| one.version.clone()),
            );
        }
    } else if release.archive.is_none() && offered_parts(release).is_empty() {
        return refuse(
            if manifest.parts.is_some() {
                format!(
                    "The {} release publishes none of the files its parts name.",
                    manifest.name
                )
            } else {
                format!(
                    "The {} release does not say which of its files is the mod.",
                    manifest.name
                )
            },
            recorded.map(|one| one.version.clone()),
        );
    }

    if let Some(recorded) = recorded {
        // A record written before the type was kept carries none, and unknown is not a change.
        if let Some(was) = recorded.mod_type
            && was != manifest.mod_type
        {
            return Availability::Convert {
                from: recorded.version.clone(),
                was,
            };
        }
        let from = recorded.version.clone();
        return if unlisted {
            Availability::Unlisted { from }
        } else {
            Availability::Upgrade { from }
        };
    }

    // A mod that creates an install has nowhere to put one here, or the arm above would have refused
    // it: what is left is a first install, on a host of a type the manifest allows.
    if manifest.creates.is_some() {
        return blocked_by_type(manifest, context).unwrap_or(Availability::Install);
    }

    // Presence always comes from the directory. For a base mod that means the type the directory
    // reports and nothing else - a hand-installed RPU is the common state, and this arm is both its
    // upgrade path and its repair. A file in `mods/` answering to the mod's id is somebody else's dat
    // with a similar name, and reading it as "already installed" would walk past the gate that keeps a
    // base mod off a changed game.
    if manifest.mod_type == ModType::Base {
        if Some(context.install.game_type) != manifest.becomes {
            return blocked_by_type(manifest, context).unwrap_or(Availability::Install);
        }
        let held = context.base_version.as_ref().and_then(Option::as_ref);
        // A nightly stamps the commit it was built from where a release stamps its number, so nothing
        // here can order it against what the index offers - and a build from after the last release is
        // the common case. Reported as what it is rather than as an install with no version, which is
        // what it was read as.
        if let Some(BaseVersion::Nightly { commit }) = held {
            return Availability::Nightly {
                commit: commit.clone(),
            };
        }
        // What the install stamped into `ddraw.ini` stands in for the record it has not got. Where the
        // mod is published in parallel lines that stamp also says WHICH of them is here, and only one
        // base mod fits an installation: another line's version is that other mod already installed,
        // refused in the same sentence as any other base mod meeting an installation it does not
        // install on.
        if let Some(line) = &release.line
            && !offered_on_line(line, held)
        {
            return blocked_by_type(manifest, context).unwrap_or(Availability::InstallOver);
        }
        if let Some(BaseVersion::Release { version }) = held {
            let from = version.clone();
            return match compare_listed(release, version) {
                Some(Ordering::Equal) => Availability::Installed,
                Some(Ordering::Greater) => Availability::Upgrade { from },
                Some(Ordering::Less) => Availability::Downgrade { from },
                None => Availability::Unlisted { from },
            };
        }
        return Availability::InstallOver;
    }
    if context.present {
        return Availability::InstallOver;
    }

    // The game-type gate protects a first install alone - install-over and upgrades are the same mod
    // already.
    blocked_by_type(manifest, context).unwrap_or(Availability::Install)
}

/// The game-type gate: what a mod says it installs on, against what this install is.
fn blocked_by_type(manifest: &ModManifest, context: &ModContext<'_>) -> Option<Availability> {
    let allowed = manifest.install_on.as_ref()?;
    if allowed.contains(&context.install.game_type) {
        return None;
    }
    let wanted: Vec<&str> = allowed.iter().map(|one| one.name()).collect();
    Some(Availability::Blocked {
        why: format!(
            "{} installs on {} - this install is {}.",
            manifest.name,
            wanted.join(" or "),
            context.install.game_type.name()
        ),
        from: None,
    })
}

/// Whether the mod is already in the install's `mods/`.
///
/// A release that declares its `entries` is judged against those, which is the only thing that answers
/// for a payload whose filename an id cannot reach: an id carries no underscore and most of these
/// filenames do, so `cassidy_head.dat` matches no id that could be minted for it. Without a declaration
/// the id's own convention stands - `<id>` or `<id>.*`, file or folder alike - which is what every
/// manifest written before the field relied on.
///
/// # Errors
///
/// Fails where the mods folder is there but cannot be listed.
pub fn present_in_mods(
    platform: &dyn Platform,
    install_path: &str,
    id: &str,
    entries: &[String],
) -> Result<bool> {
    let directory = Path::new(install_path).join(MODS_DIRECTORY);
    if platform.fs().stat(&directory)?.map(|stat| stat.kind) != Some(FileKind::Dir) {
        return Ok(false);
    }
    let held = platform.fs().list(&directory)?;
    // A declared entry may be nested - `patches/extra.dat` - and only its first piece is a name the mods
    // folder itself lists. Matching on that over-reports where the folder exists without its dat, which
    // is the harmless direction: it offers the release laid over what is there rather than beside it.
    if !entries.is_empty() {
        return Ok(entries.iter().any(|entry| {
            let top = entry.split('/').next().unwrap_or(entry).to_lowercase();
            held.iter().any(|found| found.name.to_lowercase() == top)
        }));
    }
    Ok(held.iter().any(|entry| answers_to_id(&entry.name, id)))
}

/// One mod as the interface lists it, everything plain enough to cross the process boundary.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct ModOffer {
    pub id: String,
    pub name: String,
    pub version: String,
    pub mod_type: ModType,
    /// What the release says about itself. The pages are flags: the interface asks for one by name.
    pub author: Option<String>,
    pub description: Option<String>,
    pub forum: bool,
    pub homepage: bool,
    /// A permanent mod's declared reason, standing where the Remove control would be.
    pub reason: Option<String>,
    /// What a base mod turns this install into, which is the thing worth knowing before installing one.
    pub becomes: Option<GameType>,
    /// The directory a creating mod makes inside this install, where it makes one.
    pub creates: Option<String>,
    /// What the user must be asked for before this can be installed, so the interface reads no manifest.
    pub asks: Vec<ModInput>,
    /// The choice to make before installing this release, and where this install stands in it.
    pub choices: Option<ChoiceOffer>,
    /// Set on a row the record alone describes, where the index offers no release: `version` is then
    /// what is on disk rather than what is offered. Both readings otherwise have the same shape, and a retry row
    /// arrives either way, so nothing downstream could tell an offered version from an installed one
    /// without this.
    pub no_feed: bool,
    pub availability: Availability,
}

/// Everything the interface needs to draw a choice it cannot compute: the renderer reads no manifest.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct ChoiceOffer {
    /// The groups this release can deliver, in the order the manifest declares them.
    pub groups: Vec<ChoiceGroup<ModPart>>,
    pub carried: CarriedSelection,
}

/// A listed mod none of whose releases this version can install, and why.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct FeedFailure {
    pub id: String,
    pub name: String,
    pub why: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct ModListing {
    pub offers: Vec<ModOffer>,
    /// Listed mods none of whose releases this version can install, each with why.
    pub failures: Vec<FeedFailure>,
    /// What to say about the index itself: that it could not be read, or that it is old.
    pub notice: Option<String>,
}

/// What the index offers for one mod, with nothing of any install in it - one current release,
/// whichever game folder is on screen. This is the half of an offer that survives a change of game.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct PublishedMod {
    pub id: String,
    pub name: String,
    pub version: String,
    pub mod_type: ModType,
    /// What the release says about itself, for the row offering it. Absent where the manifest says
    /// nothing.
    pub author: Option<String>,
    pub description: Option<String>,
    /// Whether the mod publishes each page, rather than where: the address is the backend's to resolve.
    pub forum: bool,
    pub homepage: bool,
    pub reason: Option<String>,
    pub becomes: Option<GameType>,
    pub creates: Option<String>,
    pub asks: Vec<ModInput>,
    /// The choice this release offers, without an install's answer to it. Empty where it offers none.
    pub choice: Vec<ChoiceGroup<ModPart>>,
}

/// Every listed mod's current release, and the mods that have none to offer. Read once, not once per
/// install.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct ModFeedListing {
    pub published: Vec<PublishedMod>,
    pub failures: Vec<FeedFailure>,
    pub notice: Option<String>,
}

/// Where one install stands against the published mods, which is everything a change of game
/// invalidates.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct ModInstallState {
    /// By mod id, for the published mods this install could say something about.
    pub standing: BTreeMap<String, Standing>,
    /// Rows only this install's record knows about, complete as they are drawn - no release describes them.
    pub unfollowed: Vec<ModOffer>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../../packages/ui/src/lib/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct Standing {
    pub availability: Availability,
    pub carried: CarriedSelection,
}

/// The per-app half of an offer: what the release says about itself, before any folder is considered.
fn published_from(release: &ModRelease) -> PublishedMod {
    let manifest = &release.manifest;
    PublishedMod {
        id: manifest.id.clone(),
        name: manifest.name.clone(),
        version: manifest.version.clone(),
        mod_type: manifest.mod_type,
        author: manifest.author.clone(),
        description: manifest.description.clone(),
        forum: manifest.forum.is_some(),
        homepage: manifest.homepage.is_some(),
        reason: manifest.reason.clone(),
        becomes: manifest.becomes,
        creates: manifest
            .creates
            .as_ref()
            .map(|creates| creates.directory.clone()),
        asks: manifest.inputs.clone().unwrap_or_default(),
        choice: offered_parts(release),
    }
}

/// One read of the index: what the interface lists, the releases behind it, and the index itself for
/// a version the user picks. No index where none could be read.
#[derive(Debug, Clone, Default)]
pub struct ModFeeds {
    pub listing: ModFeedListing,
    pub releases: Vec<ModRelease>,
    pub index: Option<Index>,
}

/// Past this age the index is still used, and the tab says how old it is: an indexer that stopped is
/// then visible on every machine rather than nowhere.
const STALE_INDEX_MS: i64 = 14 * 24 * 60 * 60 * 1000;

/// Every listed mod's current release. A mod with none this version can install costs its own row, not
/// the listing; one the index lists no release of at all has nothing to say and no row.
#[must_use]
pub fn read_mod_feeds(platform: &dyn Platform, now: i64) -> ModFeeds {
    let index = match read_mod_index(platform, now) {
        Ok(index) => index,
        Err(err) => {
            return ModFeeds {
                listing: ModFeedListing {
                    notice: Some(format!(
                        "The mod index could not be read, so no mod can be installed or updated: \
                         {err} Installed mods stay listed and can still be removed."
                    )),
                    ..ModFeedListing::default()
                },
                releases: Vec::new(),
                index: None,
            };
        }
    };
    let mut published = Vec::new();
    let mut releases = Vec::new();
    let mut failures = Vec::new();
    for listed in &index.mods {
        if listed.releases.is_empty() {
            continue;
        }
        match current_release(platform, listed) {
            Ok(release) => {
                published.push(published_from(&release));
                releases.push(release);
            }
            Err(err) => failures.push(FeedFailure {
                id: listed.id.clone(),
                name: listed.name.clone(),
                why: err.to_string(),
            }),
        }
    }
    let notice = generated_millis(&index.generated)
        .filter(|generated| now - generated > STALE_INDEX_MS)
        .map(|generated| {
            let days = (now - generated) / (24 * 60 * 60 * 1000);
            format!(
                "The mod index was last updated {days} days ago, so releases published since may be \
                 missing."
            )
        });
    ModFeeds {
        listing: ModFeedListing {
            published,
            failures,
            notice,
        },
        releases,
        index: Some(index),
    }
}

/// Where one install stands against releases already read. Everything here reads the game folder or the
/// install's own record, which is why it is asked again for each install and the index above is not.
///
/// # Errors
///
/// Fails where the game folder cannot be read.
pub fn read_mod_install_state(
    platform: &dyn Platform,
    feeds: &ModFeeds,
    install: &Install,
    record: &InstallRecord,
    sfall: Option<&str>,
) -> Result<ModInstallState> {
    let releases = &feeds.releases;
    let mut standing = BTreeMap::new();
    for release in releases {
        let manifest = &release.manifest;
        // A parts mod declares nothing at the top level, so presence is judged against every part's
        // entries: any one of them in the folder is the mod being there. A mod that creates an install
        // is not in the mods folder at all: what answers for it is the directory it makes - or this
        // installation, where that is already what this one is.
        let created = manifest.creates.as_ref().map(|creates| {
            created_install_path(
                Path::new(&install.path),
                install.game_type,
                manifest.becomes,
                &creates.directory,
            )
        });
        let declared: Vec<String> = manifest.entries.clone().unwrap_or_else(|| {
            part_options(manifest)
                .into_iter()
                .flat_map(|part| part.entries.clone().unwrap_or_default())
                .collect()
        });
        let present = match &created {
            None => present_in_mods(platform, &install.path, &manifest.id, &declared)?,
            Some(at) => platform.fs().stat(at)?.map(|stat| stat.kind) == Some(FileKind::Dir),
        };
        // Read only for a base mod, and only where it could answer: a stacking mod's version is the
        // record's. A created install stamps its own copy, one directory in, which is where this reads
        // it.
        let base_version = if manifest.mod_type == ModType::Base {
            let root = created
                .clone()
                .unwrap_or_else(|| PathBuf::from(&install.path));
            Some(installed_base_version(platform, &root)?)
        } else {
            None
        };
        let recorded = record.mods.iter().find(|one| one.id == manifest.id);
        let carried = carry_over(release, recorded.map(|one| one.parts.as_slice()));
        standing.insert(
            manifest.id.clone(),
            Standing {
                availability: availability(
                    release,
                    &ModContext {
                        install,
                        record,
                        sfall,
                        present,
                        base_version,
                    },
                ),
                carried,
            },
        );
    }

    // Recorded with no release on offer: the row is what keeps Remove reachable - the tab is otherwise
    // index-driven, and such a mod would be installed yet invisible. Taken from the releases that
    // actually resolved, so a listed mod none of whose releases this version can read gets a row too,
    // saying why rather than calling it unfollowed.
    let followed: BTreeSet<&str> = releases
        .iter()
        .map(|release| release.manifest.id.as_str())
        .collect();
    let mut unfollowed = Vec::new();
    for held in &record.mods {
        if followed.contains(held.id.as_str()) {
            continue;
        }
        let refused = |why: String| Availability::Blocked {
            why,
            from: Some(held.version.clone()),
        };
        let standing = match &feeds.index {
            None => refused(
                "The mod index could not be read, so whether a newer version is out is not known."
                    .to_owned(),
            ),
            Some(index) if index.mods.iter().any(|listed| listed.id == held.id) => {
                match feeds.listing.failures.iter().find(|one| one.id == held.id) {
                    Some(failure) => refused(failure.why.clone()),
                    None => refused("The mod index lists no release of it.".to_owned()),
                }
            }
            Some(_) => Availability::Unfollowed,
        };
        // An unreadable snapshot still names the mod through the record's own fields, and defaulting
        // the type to removable is safe: uninstall re-reads the type itself, so a wrong guess costs a
        // refused click.
        let manifest = manifest_of(held);
        unfollowed.push(ModOffer {
            id: held.id.clone(),
            name: manifest
                .as_ref()
                .map_or_else(|| held.id.clone(), |one| one.name.clone()),
            version: held.version.clone(),
            mod_type: manifest
                .as_ref()
                .map_or(ModType::Pluggable, |one| one.mod_type),
            no_feed: true,
            // What the snapshot says about the mod, but no page flag whatever it names: the address is
            // resolved from a held release, and the whole of what makes this row is that none is held.
            author: manifest.as_ref().and_then(|one| one.author.clone()),
            description: manifest.as_ref().and_then(|one| one.description.clone()),
            reason: manifest.as_ref().and_then(|one| one.reason.clone()),
            forum: false,
            homepage: false,
            becomes: None,
            creates: None,
            asks: Vec::new(),
            choices: None,
            availability: if held.complete {
                standing
            } else {
                Availability::Retry {
                    version: held.version.clone(),
                }
            },
        });
    }
    Ok(ModInstallState {
        standing,
        unfollowed,
    })
}

/// The two halves as one listing. Pure, so the interface can hold the feeds across a change of game and
/// redraw from a fresh install state alone. A published mod the install state says nothing about is
/// dropped rather than drawn without one: it means the two were read either side of a refresh that
/// changed what is published, and a row with no standing has no status line, no button and nothing to
/// do.
#[must_use]
pub fn listing_from(feeds: &ModFeedListing, state: &ModInstallState) -> ModListing {
    let mut offers = Vec::new();
    for mod_ in &feeds.published {
        let Some(standing) = state.standing.get(&mod_.id) else {
            continue;
        };
        offers.push(ModOffer {
            id: mod_.id.clone(),
            name: mod_.name.clone(),
            version: mod_.version.clone(),
            mod_type: mod_.mod_type,
            author: mod_.author.clone(),
            description: mod_.description.clone(),
            forum: mod_.forum,
            homepage: mod_.homepage,
            reason: mod_.reason.clone(),
            becomes: mod_.becomes,
            creates: mod_.creates.clone(),
            asks: mod_.asks.clone(),
            choices: (!mod_.choice.is_empty()).then(|| ChoiceOffer {
                groups: mod_.choice.clone(),
                carried: standing.carried.clone(),
            }),
            no_feed: false,
            availability: standing.availability.clone(),
        });
    }
    offers.extend(state.unfollowed.iter().cloned());
    ModListing {
        offers,
        failures: feeds.failures.clone(),
        notice: feeds.notice.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::{ManifestDefaults, parse_manifest};
    use crate::records::InstalledMod;
    use serde_json::{Value, json};
    use std::collections::BTreeMap;
    use zax_platform::memory::{Content, MemoryOptions, MemoryPlatform, Response};

    /// The memory host's clock starts here and steps once per write, so a file it wrote reads as
    /// newer than this and an index cached during a test is fresh unless the test says otherwise.
    const EARLY: i64 = 1_700_000_000_000;
    const LATE: i64 = EARLY + 24 * 60 * 60 * 1000;
    /// When the test indexes say they were built: the same day as `EARLY`.
    const BUILT: &str = "2023-11-14T22:13:20Z";

    fn manifest_text(id: &str) -> String {
        format!("spec: 1\nid: {id}\nname: FO2tweaks\ngame: fallout2\ntype: pluggable\n")
    }

    /// One listed release, its manifest explicit as the indexer writes it.
    fn listed_release(id: &str, version: &str, rank: u64, extra: &Value) -> Value {
        let archive = format!("{id}_{version}.zip");
        let mut release = json!({
            "version": version,
            "rank": rank,
            "published": BUILT,
            "assets": [{
                "name": archive,
                "url": format!("https://example/{archive}"),
                "size": 7,
                "sha256": "a".repeat(64),
            }],
            "manifest": format!("{}version: '{version}'\narchive: {archive}\n", manifest_text(id)),
        });
        if let (Some(into), Some(from)) = (release.as_object_mut(), extra.as_object()) {
            for (key, value) in from {
                into.insert(key.clone(), value.clone());
            }
        }
        release
    }

    /// An index listing `fo2tweaks` with these releases, newest first.
    fn index_with(releases: Vec<Value>) -> String {
        json!({
            "format": 1,
            "generated": BUILT,
            "orders": { "fallout2": ["fo2tweaks.dat"] },
            "mods": [{ "id": "fo2tweaks", "name": "FO2tweaks", "releases": releases }],
        })
        .to_string()
    }

    /// A machine whose network answers the index with this text.
    fn serving(index: &str) -> MemoryPlatform {
        MemoryPlatform::new(MemoryOptions {
            responses: BTreeMap::from([(INDEX_URL.to_owned(), Response::Body(index.to_owned()))]),
            ..MemoryOptions::default()
        })
    }

    fn install() -> Install {
        Install::new("/games/f2", GameType::Fallout2)
    }

    fn record_with(mods: Vec<InstalledMod>) -> InstallRecord {
        InstallRecord {
            path: "/games/f2".to_owned(),
            mods,
            ..InstallRecord::default()
        }
    }

    fn installed(id: &str, version: &str, complete: bool) -> InstalledMod {
        InstalledMod {
            id: id.to_owned(),
            version: version.to_owned(),
            mod_type: Some(ModType::Pluggable),
            reason: None,
            complete,
            files: Vec::new(),
            entries: Vec::new(),
            parts: Vec::new(),
            manifest: manifest_text(id),
            shipped: BTreeMap::new(),
            before: BTreeMap::new(),
            carried: BTreeMap::new(),
        }
    }

    /// The versions every test release is listed beside, oldest first, ranked as the indexer would.
    const LISTED: &[&str] = &["0.9", "1.0", "2.0", "3.0"];

    fn release_of(id: &str, version: &str) -> ModRelease {
        let text = format!("{}version: {version}\n", manifest_text(id));
        let ranks: BTreeMap<String, u64> = (1..)
            .zip(LISTED)
            .map(|(rank, listed)| ((*listed).to_owned(), rank))
            .collect();
        ModRelease {
            manifest: parse_manifest(text.as_bytes(), &ManifestDefaults::default())
                .expect("a manifest the test writes"),
            manifest_text: text,
            archive: Some(ReleaseAsset {
                name: "payload.zip".to_owned(),
                url: "https://example/payload.zip".to_owned(),
                digest: None,
                size: None,
            }),
            parts: BTreeMap::new(),
            installer: None,
            installer_route: None,
            line: None,
            rank: ranks.get(version).copied().expect("a listed version"),
            ranks,
        }
    }

    fn context<'a>(record: &'a InstallRecord, install: &'a Install) -> ModContext<'a> {
        ModContext {
            install,
            record,
            sfall: None,
            present: false,
            base_version: None,
        }
    }

    #[test]
    fn a_tag_names_a_version_only_where_it_is_shaped_like_one() {
        assert_eq!(version_from_tag("v14.7").as_deref(), Some("14.7"));
        assert_eq!(version_from_tag("2.3.34").as_deref(), Some("2.3.34"));
        assert_eq!(version_from_tag("nightly"), None);
    }

    #[test]
    fn the_newest_listed_release_is_offered_with_its_payload_and_its_mods_ranks() {
        let platform = serving(&index_with(vec![
            listed_release("fo2tweaks", "2.0", 2, &json!({})),
            listed_release("fo2tweaks", "1.0", 1, &json!({})),
        ]));
        let feeds = read_mod_feeds(&platform, EARLY);
        assert_eq!(feeds.listing.notice, None);
        let [found] = feeds.releases.as_slice() else {
            panic!("one release: {:?}", feeds.listing);
        };
        assert_eq!(found.manifest.version, "2.0");
        assert_eq!(
            found.archive.as_ref().map(|asset| asset.digest.as_deref()),
            Some(Some(format!("sha256:{}", "a".repeat(64)).as_str()))
        );
        assert_eq!(compare_listed(found, "1.0"), Some(Ordering::Greater));
        assert_eq!(compare_listed(found, "1.5"), None);
        assert_eq!(feeds.listing.published[0].version, "2.0");
    }

    #[test]
    fn a_release_needing_a_newer_zax_gives_way_to_the_newest_one_this_version_installs() {
        // A newer feature in the newest release is no reason to offer nothing: the older one installs.
        let platform = serving(&index_with(vec![
            listed_release("fo2tweaks", "2.0", 2, &json!({ "requires": ["later"] })),
            listed_release("fo2tweaks", "1.0", 1, &json!({})),
        ]));
        let feeds = read_mod_feeds(&platform, EARLY);
        assert_eq!(feeds.releases[0].manifest.version, "1.0");
        assert!(feeds.listing.failures.is_empty());
    }

    #[test]
    fn a_listed_mod_none_of_whose_releases_installs_says_why() {
        let platform = serving(&index_with(vec![listed_release(
            "fo2tweaks",
            "2.0",
            1,
            &json!({ "requires": ["later"] }),
        )]));
        let feeds = read_mod_feeds(&platform, EARLY);
        assert!(feeds.releases.is_empty());
        let [failure] = feeds.listing.failures.as_slice() else {
            panic!("one failure: {:?}", feeds.listing);
        };
        assert_eq!(failure.id, "fo2tweaks");
        assert!(
            failure.why.contains("needs a newer version of ZAX"),
            "{}",
            failure.why
        );
    }

    #[test]
    fn a_listed_mod_with_no_release_has_nothing_to_say() {
        let feeds = read_mod_feeds(&serving(&index_with(Vec::new())), EARLY);
        assert!(feeds.releases.is_empty());
        assert!(feeds.listing.failures.is_empty());
        assert!(feeds.index.is_some());
    }

    #[test]
    fn an_index_that_cannot_be_read_says_so_and_keeps_installed_mods_removable() {
        // Nothing answers the network, and nothing was ever cached.
        let platform = MemoryPlatform::new(MemoryOptions::default());
        let feeds = read_mod_feeds(&platform, EARLY);
        assert!(feeds.index.is_none());
        let notice = feeds.listing.notice.clone().expect("a notice");
        assert!(notice.contains("could not be read"), "{notice}");
        // Not "no longer followed": nothing can say that while the index is unread.
        let record = record_with(vec![installed("fo2tweaks", "1.0", true)]);
        let state = read_mod_install_state(&platform, &feeds, &install(), &record, None)
            .expect("a reading");
        let Availability::Blocked { why, from } = &state.unfollowed[0].availability else {
            panic!("{:?}", state.unfollowed);
        };
        assert!(why.contains("could not be read"), "{why}");
        assert_eq!(from.as_deref(), Some("1.0"));
    }

    #[test]
    fn an_old_index_is_used_and_its_age_is_said() {
        let platform = serving(&index_with(vec![listed_release(
            "fo2tweaks",
            "1.0",
            1,
            &json!({}),
        )]));
        let weeks_on = EARLY + 20 * 24 * 60 * 60 * 1000;
        let feeds = read_mod_feeds(&platform, weeks_on);
        assert_eq!(feeds.releases.len(), 1);
        let notice = feeds.listing.notice.expect("a notice");
        assert!(notice.contains("20 days ago"), "{notice}");
        // And a fresh one says nothing about itself.
        assert_eq!(read_mod_feeds(&platform, LATE).listing.notice, None);
    }

    #[test]
    fn an_index_that_worked_yesterday_answers_when_the_network_refuses() {
        // Nothing answers the network here, and the cache is past its life.
        let offline = MemoryPlatform::new(MemoryOptions::default());
        offline
            .fs()
            .write(
                &index_cache_path(&offline),
                index_with(vec![listed_release("fo2tweaks", "1.0", 1, &json!({}))]).as_bytes(),
            )
            .expect("a cache the test seeds");
        let feeds = read_mod_feeds(&offline, LATE);
        assert_eq!(feeds.releases[0].manifest.version, "1.0");
        // And the orders it states are what an install places a new entry against.
        let orders = held_orders(&offline).expect("a read");
        assert_eq!(orders["fallout2"], ["fo2tweaks.dat"]);
    }

    #[test]
    fn a_document_this_version_cannot_read_never_replaces_the_one_it_can() {
        let offline = MemoryPlatform::new(MemoryOptions {
            responses: BTreeMap::from([(
                INDEX_URL.to_owned(),
                Response::Body(r#"{"format": 2, "generated": "x"}"#.to_owned()),
            )]),
            ..MemoryOptions::default()
        });
        let err = read_mod_index(&offline, EARLY).expect_err("a later format");
        assert!(err.to_string().contains("Update ZAX"), "{err}");
        assert!(
            offline
                .fs()
                .stat(&index_cache_path(&offline))
                .expect("a read")
                .is_none()
        );
        assert!(held_orders(&offline).expect("a read").is_empty());
    }

    #[test]
    fn every_listed_version_is_offered_newest_first_and_one_is_found_by_name() {
        let platform = serving(&index_with(vec![
            listed_release("fo2tweaks", "2.0", 2, &json!({})),
            listed_release("fo2tweaks", "1.0", 1, &json!({})),
        ]));
        let index = read_mod_index(&platform, EARLY).expect("an index");
        assert_eq!(
            list_mod_versions(&index, "fo2tweaks").expect("listed"),
            ["2.0", "1.0"]
        );
        let found = release_named(&platform, &index, "fo2tweaks", "1.0").expect("a release");
        assert_eq!(found.manifest.version, "1.0");
        let err = release_named(&platform, &index, "fo2tweaks", "9.9").expect_err("not listed");
        assert!(err.to_string().contains("FO2tweaks 9.9"), "{err}");
        assert!(list_mod_versions(&index, "ecco").is_err());
    }

    #[test]
    fn an_installer_is_the_asset_the_index_names_for_this_hosts_route() {
        let manifest = "spec: 1\nid: upu\nname: UPU\nversion: '34'\ngame: fallout2\ntype: base\n\
                        becomes: fallout2upu\ninstaller.other.run: setup.sh\n\
                        installer.other.asset: upu_v34.zip\n";
        let index = json!({
            "format": 1,
            "generated": BUILT,
            "mods": [{
                "id": "upu",
                "name": "UPU",
                "base": true,
                "releases": [{
                    "version": "34",
                    "rank": 1,
                    "published": BUILT,
                    "requires": ["base.script"],
                    "assets": [{
                        "name": "upu_v34.zip",
                        "url": "https://example/upu_v34.zip",
                        "size": 7,
                        "sha256": "b".repeat(64),
                    }],
                    "manifest": manifest,
                }],
            }],
        });
        let feeds = read_mod_feeds(&serving(&index.to_string()), EARLY);
        let installer = feeds.releases[0].installer.clone().expect("an installer");
        // The memory host is not Windows, so the other route is this host's.
        assert_eq!(installer.route, InstallerRoute::Other);
        assert_eq!(installer.asset.name, "upu_v34.zip");
    }

    #[test]
    fn an_archive_shaped_asset_is_told_from_anything_else_on_a_release() {
        assert!(is_archive_name("payload.ZIP"));
        assert!(is_archive_name("payload.tar.gz"));
        assert!(!is_archive_name("payload.zip.sha256"));
        assert!(!is_archive_name("notes.txt"));
    }

    #[test]
    fn a_mod_that_does_not_install_here_is_told_apart_from_a_release_missing_its_asset() {
        // One message for both sends half its readers to look in the wrong place.
        let text = "spec: 1\nid: upu\nname: UPU\nversion: 1.0\ngame: fallout2\ntype: base\n\
                    becomes: fallout2upu\ninstaller.windows.built-with: inno\n";
        let manifest = parse_manifest(text.as_bytes(), &ManifestDefaults::default())
            .expect("a manifest the test writes");
        assert_eq!(
            installer_miss(&manifest, Some(InstallerRoute::Other)),
            "UPU does not install on this system."
        );
        let said = installer_miss(&manifest, Some(InstallerRoute::Windows));
        assert!(said.contains("no single executable"), "{said}");
    }

    #[test]
    fn a_named_installer_asset_the_release_lacks_is_the_authors_mistake() {
        let text = "spec: 1\nid: upu\nname: UPU\nversion: 1.0\ngame: fallout2\ntype: base\n\
                    becomes: fallout2upu\ninstaller.windows.built-with: inno\n\
                    installer.windows.asset: setup.exe\n";
        let manifest = parse_manifest(text.as_bytes(), &ManifestDefaults::default())
            .expect("a manifest the test writes");
        let said = installer_miss(&manifest, Some(InstallerRoute::Windows));
        assert!(said.contains("\"setup.exe\""), "{said}");
        assert!(said.contains("does not publish"), "{said}");
    }

    #[test]
    fn a_mod_nothing_records_and_nothing_holds_is_offered() {
        let record = record_with(Vec::new());
        let install = install();
        assert_eq!(
            availability(&release_of("fo2tweaks", "1.0"), &context(&record, &install)),
            Availability::Install
        );
    }

    #[test]
    fn a_hand_installed_mod_is_offered_laid_over_what_is_there() {
        let record = record_with(Vec::new());
        let install = install();
        let mut held = context(&record, &install);
        held.present = true;
        assert_eq!(
            availability(&release_of("fo2tweaks", "1.0"), &held),
            Availability::InstallOver
        );
    }

    #[test]
    fn a_record_at_the_same_version_reads_as_installed() {
        let record = record_with(vec![installed("fo2tweaks", "1.0", true)]);
        let install = install();
        assert_eq!(
            availability(&release_of("fo2tweaks", "1.0"), &context(&record, &install)),
            Availability::Installed
        );
    }

    #[test]
    fn a_newer_release_is_an_upgrade_and_an_older_one_a_downgrade() {
        let record = record_with(vec![installed("fo2tweaks", "1.0", true)]);
        let install = install();
        assert_eq!(
            availability(&release_of("fo2tweaks", "2.0"), &context(&record, &install)),
            Availability::Upgrade {
                from: "1.0".to_owned()
            }
        );
        let ahead = record_with(vec![installed("fo2tweaks", "3.0", true)]);
        assert_eq!(
            availability(&release_of("fo2tweaks", "2.0"), &context(&ahead, &install)),
            Availability::Downgrade {
                from: "3.0".to_owned()
            }
        );
    }

    #[test]
    fn a_recorded_version_the_index_does_not_list_is_offered_in_its_place_not_as_an_upgrade() {
        // Nothing can order `1.5` against what is listed, so the offer claims neither direction.
        let record = record_with(vec![installed("fo2tweaks", "1.5", true)]);
        let install = install();
        assert_eq!(
            availability(&release_of("fo2tweaks", "2.0"), &context(&record, &install)),
            Availability::Unlisted {
                from: "1.5".to_owned()
            }
        );
    }

    #[test]
    fn an_install_that_never_finished_is_offered_as_a_retry() {
        let record = record_with(vec![installed("fo2tweaks", "1.0", false)]);
        let install = install();
        assert_eq!(
            availability(&release_of("fo2tweaks", "2.0"), &context(&record, &install)),
            Availability::Retry {
                version: "1.0".to_owned()
            }
        );
    }

    #[test]
    fn a_type_the_record_disagrees_with_is_a_conversion_rather_than_an_update() {
        // A mod taking its own removability away is not an update.
        let record = record_with(vec![InstalledMod {
            mod_type: Some(ModType::Permanent),
            ..installed("fo2tweaks", "1.0", true)
        }]);
        let install = install();
        assert_eq!(
            availability(&release_of("fo2tweaks", "2.0"), &context(&record, &install)),
            Availability::Convert {
                from: "1.0".to_owned(),
                was: ModType::Permanent
            }
        );
    }

    #[test]
    fn the_sfall_gate_answers_before_the_version_comparison() {
        let text = "spec: 1\nid: fo2tweaks\nname: FO2tweaks\nversion: 2.0\ngame: fallout2\n\
                    type: pluggable\nneeds.sfall: '4.4'\n";
        let manifest = parse_manifest(text.as_bytes(), &ManifestDefaults::default())
            .expect("a manifest the test writes");
        let release = ModRelease {
            manifest,
            ..release_of("fo2tweaks", "2.0")
        };
        let record = record_with(vec![installed("fo2tweaks", "1.0", true)]);
        let install = install();
        let mut held = context(&record, &install);
        held.sfall = Some("4.3");
        let Availability::Blocked { why, from } = availability(&release, &held) else {
            panic!("the gate must refuse");
        };
        assert!(why.contains("sfall 4.4"), "{why}");
        // A refused row is often an installed mod, and the version it holds is worth carrying.
        assert_eq!(from.as_deref(), Some("1.0"));
        held.sfall = Some("4.4");
        assert_eq!(
            availability(&release, &held),
            Availability::Upgrade {
                from: "1.0".to_owned()
            }
        );
    }

    #[test]
    fn a_release_that_names_no_payload_cannot_offer_a_download() {
        let release = ModRelease {
            archive: None,
            ..release_of("fo2tweaks", "1.0")
        };
        let record = record_with(Vec::new());
        let install = install();
        let Availability::Blocked { why, .. } = availability(&release, &context(&record, &install))
        else {
            panic!("nothing to download");
        };
        assert!(why.contains("which of its files is the mod"), "{why}");
    }

    #[test]
    fn the_game_type_gate_protects_a_first_install_alone() {
        let text = "spec: 1\nid: fo2tweaks\nname: FO2tweaks\nversion: 1.0\ngame: fallout2\n\
                    type: pluggable\nneeds.game: [fallout2rpu]\n";
        let manifest = parse_manifest(text.as_bytes(), &ManifestDefaults::default())
            .expect("a manifest the test writes");
        let release = ModRelease {
            manifest,
            ..release_of("fo2tweaks", "1.0")
        };
        let record = record_with(Vec::new());
        let install = install();
        let Availability::Blocked { why, from } =
            availability(&release, &context(&record, &install))
        else {
            panic!("the wrong game");
        };
        assert!(why.contains("Restoration Project Updated"), "{why}");
        assert_eq!(from, None, "nothing is installed to name a version of");
        // An upgrade is the same mod already, so the gate does not apply.
        let held = record_with(vec![installed("fo2tweaks", "0.9", true)]);
        assert_eq!(
            availability(&release, &context(&held, &install)),
            Availability::Upgrade {
                from: "0.9".to_owned()
            }
        );
    }

    #[test]
    fn a_base_mod_meeting_the_installation_it_makes_is_read_from_its_own_stamp() {
        let text = "spec: 1\nid: upu\nname: UPU\nversion: 2.0\ngame: fallout2\ntype: base\n\
                    becomes: fallout2upu\ninstaller.other.run: upu-install.sh\n";
        let manifest = parse_manifest(text.as_bytes(), &ManifestDefaults::default())
            .expect("a manifest the test writes");
        let release = ModRelease {
            manifest,
            installer: Some(ReleaseInstaller {
                route: InstallerRoute::Other,
                asset: ReleaseAsset {
                    name: "upu.zip".to_owned(),
                    url: "https://example/upu.zip".to_owned(),
                    digest: None,
                    size: None,
                },
            }),
            installer_route: Some(InstallerRoute::Other),
            ..release_of("upu", "2.0")
        };
        let record = record_with(Vec::new());
        let install = Install::new("/games/f2", GameType::Fallout2Upu);
        let mut held = context(&record, &install);
        held.base_version = Some(Some(BaseVersion::Release {
            version: "1.0".to_owned(),
        }));
        assert_eq!(
            availability(&release, &held),
            Availability::Upgrade {
                from: "1.0".to_owned()
            }
        );
        // A stamp the index does not list is offered the release in its place.
        held.base_version = Some(Some(BaseVersion::Release {
            version: "1.5".to_owned(),
        }));
        assert_eq!(
            availability(&release, &held),
            Availability::Unlisted {
                from: "1.5".to_owned()
            }
        );
        // A nightly stamps the commit it was built from, which nothing here can order.
        held.base_version = Some(Some(BaseVersion::Nightly {
            commit: "abc123".to_owned(),
        }));
        assert_eq!(
            availability(&release, &held),
            Availability::Nightly {
                commit: "abc123".to_owned()
            }
        );
    }

    #[test]
    fn a_created_install_read_with_no_version_stamped_is_not_one_that_is_there() {
        // The reading ran and found nothing, which is the ordinary state of a game Fallout et tu was never
        // unpacked into - only a stamped version, a record or the folder itself says it is there.
        let text = "spec: 1\nid: fo1in2\nname: Fallout et tu\nversion: 1.0\ngame: fallout2\ntype: base\n\
                    becomes: fo1in2\ncreates.directory: Fallout1in2\n";
        let manifest = parse_manifest(text.as_bytes(), &ManifestDefaults::default())
            .expect("a manifest the test writes");
        let release = ModRelease {
            manifest,
            ..release_of("fo1in2", "1.0")
        };
        let record = record_with(Vec::new());
        let install = Install::new("/games/f2", GameType::Fallout2Upu);
        let mut held = context(&record, &install);
        held.base_version = Some(None);
        assert_eq!(availability(&release, &held), Availability::Install);
    }

    #[test]
    fn a_mods_folder_entry_answering_to_the_id_is_the_mod_being_there() {
        let platform = MemoryPlatform::new(MemoryOptions {
            files: BTreeMap::from([(
                "/games/f2/mods/fo2tweaks.dat".to_owned(),
                Content::from("dat"),
            )]),
            ..MemoryOptions::default()
        });
        assert!(present_in_mods(&platform, "/games/f2", "fo2tweaks", &[]).expect("a read"));
        assert!(!present_in_mods(&platform, "/games/f2", "ecco", &[]).expect("a read"));
    }

    #[test]
    fn a_declared_entry_answers_where_an_id_never_could() {
        // An id carries no underscore and most of these filenames do.
        let platform = MemoryPlatform::new(MemoryOptions {
            files: BTreeMap::from([(
                "/games/f2/mods/cassidy_head.dat".to_owned(),
                Content::from("dat"),
            )]),
            ..MemoryOptions::default()
        });
        let declared = ["cassidy_head.dat".to_owned()];
        assert!(present_in_mods(&platform, "/games/f2", "ecco", &declared).expect("a read"));
        // Only the first piece of a nested entry is a name the mods folder itself lists.
        let nested = ["cassidy_head.dat/extra.dat".to_owned()];
        assert!(present_in_mods(&platform, "/games/f2", "ecco", &nested).expect("a read"));
    }

    #[test]
    fn an_install_with_no_mods_folder_holds_nothing() {
        let platform = MemoryPlatform::new(MemoryOptions::default());
        assert!(!present_in_mods(&platform, "/games/f2", "fo2tweaks", &[]).expect("a read"));
    }

    #[test]
    fn a_recorded_mod_the_index_does_not_list_still_gets_a_row() {
        // The tab is otherwise index-driven, and such a mod would be installed yet invisible.
        let platform = serving(&index_with(Vec::new()));
        let feeds = read_mod_feeds(&platform, EARLY);
        let record = record_with(vec![
            installed("retired", "1.0", true),
            installed("fo2tweaks", "1.0", true),
        ]);
        let state = read_mod_install_state(&platform, &feeds, &install(), &record, None)
            .expect("a reading");
        assert_eq!(state.unfollowed.len(), 2);
        assert_eq!(state.unfollowed[0].id, "retired");
        assert!(state.unfollowed[0].no_feed);
        assert_eq!(state.unfollowed[0].availability, Availability::Unfollowed);
        // Listed, with nothing to offer: still followed, so not called unfollowed.
        let Availability::Blocked { why, from } = &state.unfollowed[1].availability else {
            panic!("{:?}", state.unfollowed[1]);
        };
        assert!(why.contains("lists no release"), "{why}");
        assert_eq!(from.as_deref(), Some("1.0"));
    }

    #[test]
    fn a_published_mod_the_install_state_says_nothing_about_is_dropped() {
        // A row with no standing has no status line, no button and nothing to do.
        let feeds = ModFeedListing {
            published: vec![published_from(&release_of("fo2tweaks", "1.0"))],
            ..ModFeedListing::default()
        };
        let empty = ModInstallState {
            standing: BTreeMap::new(),
            unfollowed: Vec::new(),
        };
        assert!(listing_from(&feeds, &empty).offers.is_empty());
    }

    #[test]
    fn a_listing_joins_what_is_published_to_where_this_install_stands() {
        let feeds = ModFeedListing {
            published: vec![published_from(&release_of("fo2tweaks", "1.0"))],
            failures: vec![FeedFailure {
                id: "fo2tweaks".to_owned(),
                name: "FO2tweaks".to_owned(),
                why: "offline".to_owned(),
            }],
            notice: Some("old".to_owned()),
        };
        let state = ModInstallState {
            standing: BTreeMap::from([(
                "fo2tweaks".to_owned(),
                Standing {
                    availability: Availability::Install,
                    carried: CarriedSelection::default(),
                },
            )]),
            unfollowed: vec![ModOffer {
                id: "retired".to_owned(),
                name: "Retired".to_owned(),
                version: "1.0".to_owned(),
                mod_type: ModType::Pluggable,
                author: None,
                description: None,
                forum: false,
                homepage: false,
                reason: None,
                becomes: None,
                creates: None,
                asks: Vec::new(),
                choices: None,
                no_feed: true,
                availability: Availability::Unfollowed,
            }],
        };
        let listed = listing_from(&feeds, &state);
        assert_eq!(listed.offers.len(), 2);
        assert_eq!(listed.offers[0].id, "fo2tweaks");
        assert_eq!(listed.offers[1].id, "retired");
        assert_eq!(listed.failures.len(), 1);
        assert_eq!(listed.notice.as_deref(), Some("old"));
    }
}

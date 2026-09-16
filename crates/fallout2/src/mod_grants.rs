//! Where a named mod may write outside `mods/`.
//!
//! Stacking mods are confined to `mods/`, and the exceptions are ZAX's to make rather than the
//! manifest's to claim: a mod declares the paths it writes, this list decides whether it may. Per
//! mod rather than per path, so a capability one mod needs is never handed to every mod, and it
//! changes only with a ZAX release - the same argument the feed list carries, since installing a mod
//! is trusting its publisher and this is where that trust is widened.
//!
//! A mod whose files can be packed into a `.dat` has no case here. EcCo's loose `data/` layout is
//! packable and was simply never packed, so repacking is its route in; a grant is for a mod with no
//! such route, because the engine reads its directory from the filesystem rather than through the
//! archives.
//!
//! Two are known to need one and neither can be entered yet. HQ music writes `data/sound/music/`,
//! which `music_path1` names as a filesystem directory the engine reads, and Hero Appearance writes
//! `appearance/`, where sfall reads its sets as folders or dats. Neither publishes a manifest, so
//! neither has an id, and for a stacking mod the id is the publisher's to declare: it is also the
//! name its files answer to in `mods/` and the prefix of every setting it exposes, so an id guessed
//! here would sit inert while the mod installed under another name. Each goes in beside its feed row
//! when that row is added.
//!
//! `mod_vendored` does mint ids, and this is not that case: those mods put nothing in `mods/` and
//! expose no settings, so their id names only the feed row and the record, both of which ZAX owns.

/// One mod's exception, and what it covers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModGrant {
    /// The mod's own id, as its manifest declares it - the same id a feed row follows.
    pub id: &'static str,
    /// Directories it may write below, relative to the install, matched as the engine matches paths.
    pub paths: &'static [&'static str],
}

pub const MOD_GRANTS: &[ModGrant] = &[];

/// What this mod may write outside `mods/`. Nothing, for every mod the list does not name.
#[must_use]
pub fn grants_for(id: &str) -> &'static [&'static str] {
    MOD_GRANTS
        .iter()
        .find(|grant| grant.id == id)
        .map_or(&[], |grant| grant.paths)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_mod_the_list_does_not_name_may_write_nothing() {
        assert_eq!(grants_for("anything.at.all"), &[] as &[&str]);
    }

    #[test]
    fn no_grant_is_listed_twice_and_none_is_empty() {
        // A second row for one id would make the first unreachable, silently widening or narrowing
        // what that mod may do depending on which one is found.
        let mut seen = std::collections::BTreeSet::new();
        for grant in MOD_GRANTS {
            assert!(seen.insert(grant.id), "{} is granted twice", grant.id);
            assert!(!grant.paths.is_empty(), "{} grants nothing", grant.id);
            for path in grant.paths {
                assert!(
                    !path.starts_with('/'),
                    "{path} is not relative to the install"
                );
                assert!(!path.contains(".."), "{path} climbs out of the install");
            }
        }
    }
}

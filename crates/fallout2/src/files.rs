//! The config files ZAX manages.

/// Config files ZAX manages, in the order they are presented.
pub const CONFIG_FILES: &[&str] = &["fallout2.cfg", "f2_res.ini", "ddraw.ini"];

/// Config files an alternative engine keeps, which the catalog's linked settings already address.
///
/// Kept apart from [`CONFIG_FILES`] because reaching one needs the engine installed and, for the
/// content config, the `master_patches` setting resolved: until then a target in one of them is
/// simply never written.
///
/// `fallout2.cfg` is absent on purpose - fallout2-ce writes its own sections into the game's own
/// config file, which ZAX already manages.
pub const ENGINE_CONFIG_FILES: &[&str] = &["fission.cfg", "game#patch.cfg"];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::settings;
    use std::collections::BTreeSet;

    #[test]
    fn no_file_is_named_in_both_lists() {
        // The two lists differ in whether reaching the file needs an engine installed, so a name in
        // both would be managed under two different rules.
        let managed: BTreeSet<&&str> = CONFIG_FILES.iter().collect();
        for engine_file in ENGINE_CONFIG_FILES {
            assert!(
                !managed.contains(engine_file),
                "{engine_file} is in both lists"
            );
        }
    }

    #[test]
    fn every_file_the_catalog_addresses_is_one_of_these() {
        // A target in a file neither list names is a value nothing would ever write.
        let known: BTreeSet<&str> = CONFIG_FILES
            .iter()
            .chain(ENGINE_CONFIG_FILES)
            .copied()
            .collect();
        for def in settings() {
            for target in def.targets.iter() {
                assert!(
                    known.contains(target.file.as_str()),
                    "{} writes to {}, which no list names",
                    def.id,
                    target.file
                );
            }
        }
    }
}

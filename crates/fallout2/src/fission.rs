//! What Fission does with the mods folder, which is not what sfall does with it.
//!
//! `mods` describes sfall's loader: the order file names a path relative to `mods\`, a dat or a
//! folder, under any name. Fission reads neither that file's format nor those paths. It scans
//! `mods/` for `mod_*.dat`, mounts from its own pipe-separated list, and rewrites that list from the
//! scan every time it starts. So a mod can sit in the folder, be enabled in the order, and still
//! never load - which nothing in the order file can show.
//!
//! Both facts live here rather than beside the catalog entry: the caution is shown in three places
//! and the rule decides what one of them lists, and a second copy of either is what drifts.

/// The engine these describe. Named once so the surfaces that single it out do not each carry the
/// literal.
pub const FISSION_ID: &str = "fission";

/// Said wherever Fission's mods are listed and before it is launched.
///
/// One text rather than one per surface: it is the same mechanic each time, and three wordings of
/// one constraint read as three different constraints.
pub const FISSION_CAUTION: &str = concat!(
    "Fission does not read the sfall load order. It loads only dat archives named mod_<name>.dat ",
    "from the mods folder - never a folder, and never a dat under another name - and it rewrites ",
    "mods_order.txt into its own format every time it starts. A mod installed as a folder will not ",
    "load under Fission whatever the load order says. ZAX keeps both lists: each engine's is filed ",
    "beside mods_order.txt under its own name and swapped back in before that engine runs, so ",
    "switching between engines does not cost you either one."
);

/// Whether Fission would find this entry in the mods folder. The name is the one the order file
/// writes.
///
/// Matched against the whole entry, so a dat inside a subfolder does not: Fission's scan reads the
/// top level of `mods/` only. Case-insensitive because the folder is the user's, and on Windows it
/// is theirs to spell.
#[must_use]
pub fn fission_mounts(name: &str) -> bool {
    let lowered = name.to_lowercase();
    let Some(rest) = lowered.strip_prefix("mod_") else {
        return false;
    };
    let Some(stem) = rest.strip_suffix(".dat") else {
        return false;
    };
    !stem.is_empty() && !stem.contains(['/', '\\'])
}

/// The file a Fission record names, which carries neither the prefix nor the extension its `datName`
/// field has.
fn fission_dat_file(dat_name: &str) -> String {
    format!("mod_{dat_name}.dat")
}

/// The dats a Fission list turns on, by the name they have on disk.
///
/// Only the first two fields are read, because only those two are what its mount path reads: the
/// enabled flag and the dat. Everything after them is a cache of what it found in the mod's own cfg,
/// for its in-game manager to list without opening every one, and no engine behaviour depends on any
/// of it.
#[must_use]
pub fn fission_enabled(text: &str) -> Vec<String> {
    let mut on = Vec::new();
    for line in text.lines() {
        let body = line.trim();
        if body.is_empty() || body.starts_with('#') || body.starts_with(';') {
            continue;
        }
        let mut fields = body.split('|');
        let flag = fields.next().unwrap_or("").trim();
        let dat_name = fields.next().unwrap_or("").trim();
        if flag != "1" || dat_name.is_empty() {
            continue;
        }
        on.push(fission_dat_file(dat_name));
    }
    on
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_top_level_dat_under_the_prefix_mounts() {
        assert!(fission_mounts("mod_ecco.dat"));
        assert!(
            fission_mounts("MOD_ECCO.DAT"),
            "the folder is the user's to spell"
        );
        assert!(!fission_mounts("ecco.dat"), "no prefix");
        assert!(!fission_mounts("mod_ecco"), "no extension");
        assert!(!fission_mounts("mod_.dat"), "nothing between the two");
        assert!(
            !fission_mounts("sub/mod_ecco.dat"),
            "the scan reads the top level only"
        );
        assert!(!fission_mounts("sub\\mod_ecco.dat"));
        assert!(
            !fission_mounts("a_mod_ecco.dat"),
            "the prefix must start it"
        );
    }

    #[test]
    fn a_folder_never_mounts_under_fission() {
        // The whole point of the caution: a mod installed as a folder will not load.
        assert!(!fission_mounts("ecco"));
        assert!(!fission_mounts("mod_ecco/"));
    }

    #[test]
    fn an_enabled_row_names_the_file_on_disk() {
        let list = "1|ecco|cached stuff|more\n";
        assert_eq!(fission_enabled(list), vec!["mod_ecco.dat".to_owned()]);
    }

    #[test]
    fn a_disabled_row_is_left_out() {
        let list = "0|ecco\n1|rpu\n";
        assert_eq!(fission_enabled(list), vec!["mod_rpu.dat".to_owned()]);
    }

    #[test]
    fn blank_and_commented_lines_are_skipped() {
        let list = "\n# a note\n; another\n1|ecco\n   \n";
        assert_eq!(fission_enabled(list), vec!["mod_ecco.dat".to_owned()]);
    }

    #[test]
    fn a_row_with_no_dat_name_is_skipped() {
        assert!(fission_enabled("1|\n1|   \n1\n").is_empty());
    }

    #[test]
    fn fields_are_trimmed() {
        assert_eq!(
            fission_enabled(" 1 | ecco \n"),
            vec!["mod_ecco.dat".to_owned()]
        );
    }

    #[test]
    fn carriage_returns_do_not_survive_into_a_name() {
        // The list is written on Windows as often as not.
        assert_eq!(
            fission_enabled("1|ecco\r\n1|rpu\r\n"),
            vec!["mod_ecco.dat".to_owned(), "mod_rpu.dat".to_owned()]
        );
    }

    #[test]
    fn everything_it_turns_on_is_something_it_would_mount() {
        // The two halves have to agree, or ZAX would enable a dat Fission then ignores.
        for name in fission_enabled("1|ecco\n1|rpu\n1|Mixed Case\n") {
            assert!(
                fission_mounts(&name),
                "{name} is enabled but would not mount"
            );
        }
    }
}

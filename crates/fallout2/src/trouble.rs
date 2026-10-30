//! What the debug archive collects from the install.
//!
//! Written here rather than in the view because it is a fact about this game's layout: sfall's log
//! names, the mod directory, and where saves live.

pub const DEBUG_PACKAGE_CONTENTS: &[&str] = &[
    "every .cfg and .ini in the game folder",
    "ddraw.dll, so the sfall version is unambiguous",
    "debug.log, sfall-log.txt and wine.log, if the run produced them",
    "a listing of the game folder and of mods/, plus every mods/*.ini",
    "mods_order.txt, which says which mods are on and in what order",
    "ZAX's own log, which records what ZAX did",
    "the savegames you pick",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_line_says_something() {
        assert!(!DEBUG_PACKAGE_CONTENTS.is_empty());
        for line in DEBUG_PACKAGE_CONTENTS {
            assert!(!line.trim().is_empty(), "an empty line is listed");
        }
    }
}

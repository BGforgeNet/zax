//! The alternative engines ZAX can install, as data. Hardcoded rather than fetched: a new engine is a
//! code change and a review, which is the point - this deploys a third-party binary into a user's game
//! folder.
//!
//! Beside `sfall` for the same reason it is: acquiring a third-party payload for this one game is this
//! crate's business, not `zax_core`'s.

use zax_platform::{Architecture, OperatingSystem};

use crate::fission::FISSION_CAUTION;
use crate::mods::OrderFormat;

/// How a project publishes. `Rolling` republishes one release in place and carries no version number,
/// so its publication time is its version; `Tagged` names versions that can be compared.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReleaseModel {
    Rolling,
    Tagged,
}

/// One thing taken out of a release archive: where it lives inside, and what it becomes in the install.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EngineMember {
    /// Path inside the archive, `/`-separated, wrapper directory included.
    pub from: &'static str,
    /// Path relative to the install directory.
    pub to: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EngineBuild {
    pub os: OperatingSystem,
    /// `None` where the project publishes one build for every processor - the macOS disk image is
    /// universal.
    pub arch: Option<Architecture>,
    /// The release asset's name, exactly as published.
    pub asset: &'static str,
    pub members: &'static [EngineMember],
    /// What is run, relative to the install.
    pub program: &'static str,
}

/// What proves an engine has written its own settings, which it does the first time it runs. An engine
/// with a config file of its own is answered by the file; fallout2-ce writes into the game's own config
/// file, which every install already has, so its mark is a section vanilla does not carry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SettingsMark {
    pub file: &'static str,
    pub section: Option<&'static str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EngineDefinition {
    pub id: &'static str,
    pub name: &'static str,
    /// What the second Run button says after "Run in".
    pub short: &'static str,
    pub repo: &'static str,
    pub page: &'static str,
    pub releases: ReleaseModel,
    pub builds: &'static [EngineBuild],
    pub settings_mark: SettingsMark,
    /// What has to be said before this engine is run or its mods are listed, where running it is not
    /// the same proposition as running the others. Declared here rather than decided by the views, so
    /// the surfaces that show it do not each test for one engine by name.
    pub caution: Option<&'static str>,
    /// The mod order format this engine reads, where it is not sfall's. The two are mutually unreadable
    /// and each rewrites the whole file, so the slot is swapped to this before the engine is launched.
    pub order_format: Option<OrderFormat>,
}

// `EXAMPLE_fallout2.cfg` ships in this project's archives and appears in no member list: deploying it
// would replace the user's settings with an example, which an engine install must not produce.
const CE_BUILDS: &[EngineBuild] = &[
    EngineBuild {
        os: OperatingSystem::Windows,
        arch: Some(Architecture::X64),
        asset: "fallout2-ce-windows-x64.zip",
        members: &[
            EngineMember {
                from: "fallout2-ce-windows-x64/fallout2-ce.exe",
                to: "fallout2-ce.exe",
            },
            EngineMember {
                from: "fallout2-ce-windows-x64/ce.dat",
                to: "ce.dat",
            },
        ],
        program: "fallout2-ce.exe",
    },
    EngineBuild {
        os: OperatingSystem::Linux,
        arch: Some(Architecture::X64),
        asset: "fallout2-ce-linux-x64.tar.gz",
        members: &[
            EngineMember {
                from: "fallout2-ce-linux-x64/fallout2-ce",
                to: "fallout2-ce",
            },
            EngineMember {
                from: "fallout2-ce-linux-x64/ce.dat",
                to: "ce.dat",
            },
        ],
        program: "fallout2-ce",
    },
    EngineBuild {
        os: OperatingSystem::Linux,
        arch: Some(Architecture::Arm64),
        asset: "fallout2-ce-linux-arm64.tar.gz",
        members: &[
            EngineMember {
                from: "fallout2-ce-linux-arm64/fallout2-ce",
                to: "fallout2-ce",
            },
            EngineMember {
                from: "fallout2-ce-linux-arm64/ce.dat",
                to: "ce.dat",
            },
        ],
        program: "fallout2-ce",
    },
    // The disk image carries an application bundle, which goes into the game folder whole - the
    // project's own macOS instructions put it there, beside the data it reads.
    EngineBuild {
        os: OperatingSystem::MacOs,
        arch: None,
        asset: "Fallout.II.Community.Edition.dmg",
        members: &[EngineMember {
            from: "Fallout II Community Edition/Fallout II Community Edition.app",
            to: "Fallout II Community Edition.app",
        }],
        program: "Fallout II Community Edition.app/Contents/MacOS/fallout2-ce",
    },
];

// The 32-bit and armhf builds this project also publishes have no `Architecture` to match, and the
// shell ZAX itself ships in has no build for such a host either. Every archive here is flat, with no
// wrapper directory to name in a member.
const FISSION_BUILDS: &[EngineBuild] = &[
    EngineBuild {
        os: OperatingSystem::Windows,
        arch: Some(Architecture::X64),
        asset: "fallout-fission-windows-x64.zip",
        members: &[
            EngineMember {
                from: "fallout-fission-x64.exe",
                to: "fallout-fission-x64.exe",
            },
            EngineMember {
                from: "fission.dat",
                to: "fission.dat",
            },
        ],
        program: "fallout-fission-x64.exe",
    },
    EngineBuild {
        os: OperatingSystem::Linux,
        arch: Some(Architecture::X64),
        asset: "fallout-fission-linux-x64.zip",
        members: &[
            EngineMember {
                from: "fallout-fission-linux-x64",
                to: "fallout-fission-linux-x64",
            },
            EngineMember {
                from: "fission.dat",
                to: "fission.dat",
            },
        ],
        program: "fallout-fission-linux-x64",
    },
    EngineBuild {
        os: OperatingSystem::Linux,
        arch: Some(Architecture::Arm64),
        asset: "fallout-fission-linux-arm64.zip",
        members: &[
            EngineMember {
                from: "fallout-fission-linux-arm64",
                to: "fallout-fission-linux-arm64",
            },
            EngineMember {
                from: "fission.dat",
                to: "fission.dat",
            },
        ],
        program: "fallout-fission-linux-arm64",
    },
];

pub const ENGINES: &[EngineDefinition] = &[
    EngineDefinition {
        id: "fallout2-ce",
        name: "Fallout II Community Edition",
        short: "CE",
        repo: "fallout2-ce/fallout2-ce",
        page: "https://github.com/fallout2-ce/fallout2-ce",
        releases: ReleaseModel::Rolling,
        builds: CE_BUILDS,
        // It writes all of [ui], [qol], [gameplay] and [screen] on its first run, where vanilla carries
        // only [debug], [preferences], [sound] and [system]; any one of them answers, and [ui] is the
        // largest.
        settings_mark: SettingsMark {
            file: "fallout2.cfg",
            section: Some("ui"),
        },
        caution: None,
        order_format: None,
    },
    // No macOS build, though the project publishes one: its disk image carries the `/Applications`
    // alias every drag-to-install image has, and `preflight_archive` refuses an archive holding a
    // symbolic link before it is opened. Widening that guard for one engine changes what every
    // downloaded archive is allowed to do.
    EngineDefinition {
        id: "fission",
        name: "Fallout Fission",
        short: "Fission",
        repo: "cambragol/fission-ce",
        page: "https://github.com/cambragol/fission-ce",
        // Named versions, unlike CE's one republished tag, so what is installed is compared by tag
        // rather than date.
        releases: ReleaseModel::Tagged,
        builds: FISSION_BUILDS,
        // Its own file, which nothing else in an install creates.
        settings_mark: SettingsMark {
            file: "fission.cfg",
            section: None,
        },
        caution: Some(FISSION_CAUTION),
        order_format: Some(OrderFormat::Fission),
    },
];

/// The engine with this id, or nothing where ZAX names none.
#[must_use]
pub fn engine_by_id(id: &str) -> Option<&'static EngineDefinition> {
    ENGINES.iter().find(|engine| engine.id == id)
}

/// The build for a machine, or nothing when the project publishes none it can run. A `None` `arch`
/// matches every processor; anything else must match exactly, because handing a host a binary it cannot
/// execute is worse than telling it there is nothing to install.
#[must_use]
pub fn build_for(
    engine: &EngineDefinition,
    os: OperatingSystem,
    arch: Architecture,
) -> Option<&'static EngineBuild> {
    engine
        .builds
        .iter()
        .find(|build| build.os == os && build.arch.is_none_or(|which| which == arch))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn no_engine_is_named_twice() {
        let mut seen = BTreeSet::new();
        for engine in ENGINES {
            assert!(seen.insert(engine.id), "{} is named twice", engine.id);
        }
    }

    #[test]
    fn an_unknown_id_answers_nothing() {
        assert_eq!(engine_by_id("fallout2-ce").map(|e| e.short), Some("CE"));
        assert!(engine_by_id("olympus").is_none());
    }

    #[test]
    fn a_build_must_match_the_processor_unless_it_names_none() {
        let ce = engine_by_id("fallout2-ce").expect("a named engine");
        let linux = build_for(ce, OperatingSystem::Linux, Architecture::Arm64)
            .expect("the project publishes one");
        assert_eq!(linux.asset, "fallout2-ce-linux-arm64.tar.gz");
        // The disk image is universal, so every processor gets it.
        for arch in [Architecture::X64, Architecture::Arm64, Architecture::Other] {
            let mac = build_for(ce, OperatingSystem::MacOs, arch).expect("universal");
            assert_eq!(mac.asset, "Fallout.II.Community.Edition.dmg");
        }
        // Handing a host a binary it cannot execute is worse than telling it there is nothing.
        assert!(build_for(ce, OperatingSystem::Linux, Architecture::Other).is_none());
    }

    #[test]
    fn fission_publishes_no_macos_build() {
        // Its disk image carries the `/Applications` alias the archive guard refuses.
        let fission = engine_by_id("fission").expect("a named engine");
        assert!(build_for(fission, OperatingSystem::MacOs, Architecture::Arm64).is_none());
    }

    #[test]
    fn every_member_lands_inside_the_install() {
        for engine in ENGINES {
            for build in engine.builds {
                for member in build.members {
                    assert!(
                        !member.to.starts_with('/') && !member.to.contains(".."),
                        "{} deploys {} outside the install",
                        engine.id,
                        member.to
                    );
                }
            }
        }
    }

    #[test]
    fn what_is_run_is_something_the_build_deploys() {
        // A program no member puts there could not be launched after an install that succeeded.
        for engine in ENGINES {
            for build in engine.builds {
                assert!(
                    build
                        .members
                        .iter()
                        .any(|member| build.program.starts_with(member.to)),
                    "{} runs {}, which no member deploys",
                    engine.id,
                    build.program
                );
            }
        }
    }

    #[test]
    fn only_the_engine_with_its_own_order_format_carries_a_caution() {
        // Both say the same thing about Fission: running it is not the same proposition.
        let fission = engine_by_id("fission").expect("a named engine");
        assert_eq!(fission.order_format, Some(OrderFormat::Fission));
        assert_eq!(fission.caution, Some(FISSION_CAUTION));
        let ce = engine_by_id("fallout2-ce").expect("a named engine");
        assert_eq!(ce.order_format, None);
        assert_eq!(ce.caution, None);
    }
}

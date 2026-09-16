//! Apple disk images, opened the way macOS opens one: attached by `hdiutil`, read as a folder, and
//! detached again.
//!
//! Mounting rather than parsing HFS+ keeps what the image holds exactly as Apple's own tools present
//! it - modes, extended attributes and a bundle's signature - and `hdiutil` ships with every macOS,
//! the only system a disk image is ever downloaded for.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use zax_platform::archive::{ArchiveEntryInfo, ArchiveEntryKind, ExtractOptions};
use zax_platform::{Error, Result};

use super::{failed, under, wanted};
use crate::process::run_with_timeout;

/// By absolute path rather than a `PATH` lookup: a GUI application on macOS inherits a minimal
/// environment, and this is where the system installs it.
const HDIUTIL: &str = "/usr/bin/hdiutil";

/// Attaching verifies the image's checksums first; an engine build of a few megabytes takes seconds.
const ATTACH_DEADLINE: Duration = Duration::from_secs(120);
const DETACH_DEADLINE: Duration = Duration::from_secs(60);

/// Distinguishes two mounts made by one process at once - a listing and an extraction can overlap.
static MOUNTS: AtomicU64 = AtomicU64::new(0);

/// An image attached under a mount root of its own, detached when dropped.
///
/// `-mountroot` puts each volume in a directory named for it, so a path under the root reads
/// `<volume name>/<path>` - the names the catalog's members were written against.
struct Mounted {
    root: PathBuf,
}

impl Mounted {
    fn attach(image: &Path) -> Result<Self> {
        if !cfg!(target_os = "macos") {
            return Err(Error::Unsupported(format!(
                "{} is an Apple disk image, which only macOS can open.",
                image.display()
            )));
        }
        let root = std::env::temp_dir().join(format!(
            "zax-image-{}-{}",
            std::process::id(),
            MOUNTS.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).map_err(|err| failed("mkdir", &root, err))?;
        // Held before the attach runs, so a volume that mounted before `hdiutil` failed is still
        // detached.
        let mounted = Self { root };

        let mut command = Command::new(HDIUTIL);
        command
            .args([
                "attach",
                "-readonly",
                "-nobrowse",
                "-noautoopen",
                "-mountroot",
            ])
            .arg(&mounted.root)
            .arg(image);
        let outcome = run_with_timeout(command, Path::new(HDIUTIL), Some(ATTACH_DEADLINE))?;
        if outcome.code != Some(0) {
            return Err(Error::Archive(format!(
                "Could not open {}: {}",
                image.display(),
                outcome.output.trim()
            )));
        }
        Ok(mounted)
    }
}

impl Drop for Mounted {
    fn drop(&mut self) {
        // Nothing to report to: the listing or extraction this served has already answered. A volume
        // that will not detach is read-only and hidden from the Finder, and goes at the next restart.
        if let Ok(volumes) = std::fs::read_dir(&self.root) {
            for volume in volumes.flatten() {
                let at = volume.path();
                if !detach(&at, false) {
                    detach(&at, true);
                }
                // `remove_dir` only ever removes an empty directory, so a volume still mounted there
                // is refused rather than emptied.
                let _ = std::fs::remove_dir(&at);
            }
        }
        let _ = std::fs::remove_dir(&self.root);
    }
}

fn detach(volume: &Path, force: bool) -> bool {
    let mut command = Command::new(HDIUTIL);
    command.arg("detach").arg(volume);
    if force {
        command.arg("-force");
    }
    run_with_timeout(command, Path::new(HDIUTIL), Some(DETACH_DEADLINE))
        .is_ok_and(|outcome| outcome.code == Some(0))
}

pub(super) fn list(image: &Path) -> Result<Vec<ArchiveEntryInfo>> {
    let mounted = Mounted::attach(image)?;
    list_tree(&mounted.root)
}

pub(super) fn extract(image: &Path, destination: &Path, options: &ExtractOptions) -> Result<()> {
    let mounted = Mounted::attach(image)?;
    copy_tree(&mounted.root, destination, options)
}

/// Every entry under `root`, named relative to it with `/` between segments. A symbolic link is
/// listed as one and not followed.
fn list_tree(root: &Path) -> Result<Vec<ArchiveEntryInfo>> {
    let mut out = Vec::new();
    walk(root, "", &mut |name, at, kind| {
        let size = if kind == ArchiveEntryKind::File {
            std::fs::symlink_metadata(at)
                .map_err(|err| failed("stat", at, err))?
                .len()
        } else {
            0
        };
        out.push(ArchiveEntryInfo {
            name: name.to_owned(),
            kind,
            size,
        });
        Ok(())
    })?;
    Ok(out)
}

/// Copies what `root` holds into `destination`, through the same path guard every other format
/// writes through.
fn copy_tree(root: &Path, destination: &Path, options: &ExtractOptions) -> Result<()> {
    walk(root, "", &mut |name, at, kind| match kind {
        // The archive preflight refuses a link before anything is extracted; this is the last word,
        // since recreating one is what would let a later write escape through it.
        ArchiveEntryKind::Link => Err(Error::Unsupported(format!(
            "\"{name}\" is a symbolic link - refused."
        ))),
        ArchiveEntryKind::Dir => {
            if options.only.is_empty() {
                let into = under(destination, name)?;
                std::fs::create_dir_all(&into).map_err(|err| failed("mkdir", &into, err))?;
            }
            Ok(())
        }
        ArchiveEntryKind::File => {
            if !wanted(&options.only, name) {
                return Ok(());
            }
            let into = under(destination, name)?;
            if let Some(parent) = into.parent() {
                std::fs::create_dir_all(parent).map_err(|err| failed("mkdir", parent, err))?;
            }
            // `copy` rather than a read and a write: it carries the mode across, and on macOS the
            // extended attributes with it.
            std::fs::copy(at, &into).map_err(|err| failed("extract", &into, err))?;
            Ok(())
        }
    })
}

fn walk(
    directory: &Path,
    prefix: &str,
    visit: &mut dyn FnMut(&str, &Path, ArchiveEntryKind) -> Result<()>,
) -> Result<()> {
    let mut entries = std::fs::read_dir(directory)
        .map_err(|err| failed("read_dir", directory, err))?
        .collect::<std::io::Result<Vec<_>>>()
        .map_err(|err| failed("read_dir", directory, err))?;
    // Sorted so a listing reads the same on every run.
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        let at = entry.path();
        let name = format!("{prefix}{}", entry.file_name().to_string_lossy());
        let kind = entry.file_type().map_err(|err| failed("stat", &at, err))?;
        if kind.is_symlink() {
            visit(&name, &at, ArchiveEntryKind::Link)?;
        } else if kind.is_dir() {
            visit(&name, &at, ArchiveEntryKind::Dir)?;
            walk(&at, &format!("{name}/"), visit)?;
        } else {
            visit(&name, &at, ArchiveEntryKind::File)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A mounted volume is a folder, so the reading half runs against one on any system.
    struct Volume(PathBuf);

    impl Volume {
        fn new(named: &str) -> Self {
            let at = std::env::temp_dir().join(format!("zax-disk-image-{named}"));
            let _ = std::fs::remove_dir_all(&at);
            let bundle = at.join("Fallout II Community Edition/Fallout.app/Contents/MacOS");
            std::fs::create_dir_all(&bundle).expect("a directory the test makes");
            std::fs::write(bundle.join("fallout2-ce"), b"mach-o").expect("a file");
            std::fs::write(
                at.join("Fallout II Community Edition/Fallout.app/Contents/Info.plist"),
                b"<plist/>",
            )
            .expect("a file");
            Self(at)
        }

        fn root(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Volume {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_volume_lists_under_its_own_name_the_way_the_catalog_names_members() {
        let volume = Volume::new("list");
        let listed = list_tree(volume.root()).expect("a listing");
        let names: Vec<(&str, ArchiveEntryKind)> = listed
            .iter()
            .map(|entry| (entry.name.as_str(), entry.kind))
            .collect();
        assert_eq!(
            names,
            [
                ("Fallout II Community Edition", ArchiveEntryKind::Dir),
                (
                    "Fallout II Community Edition/Fallout.app",
                    ArchiveEntryKind::Dir
                ),
                (
                    "Fallout II Community Edition/Fallout.app/Contents",
                    ArchiveEntryKind::Dir
                ),
                (
                    "Fallout II Community Edition/Fallout.app/Contents/Info.plist",
                    ArchiveEntryKind::File
                ),
                (
                    "Fallout II Community Edition/Fallout.app/Contents/MacOS",
                    ArchiveEntryKind::Dir
                ),
                (
                    "Fallout II Community Edition/Fallout.app/Contents/MacOS/fallout2-ce",
                    ArchiveEntryKind::File
                ),
            ]
        );
        assert_eq!(listed[3].size, 8);
    }

    #[cfg(unix)]
    #[test]
    fn a_copied_bundle_keeps_the_mode_its_program_runs_by() {
        use std::os::unix::fs::PermissionsExt as _;

        let volume = Volume::new("mode");
        let program = volume
            .0
            .join("Fallout II Community Edition/Fallout.app/Contents/MacOS/fallout2-ce");
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).expect("a mode");
        let out = volume.0.with_extension("out");
        let _ = std::fs::remove_dir_all(&out);

        copy_tree(volume.root(), &out, &ExtractOptions::default()).expect("a copy");
        let copied =
            out.join("Fallout II Community Edition/Fallout.app/Contents/MacOS/fallout2-ce");
        assert_eq!(std::fs::read(&copied).expect("a read"), b"mach-o");
        let mode = std::fs::metadata(&copied)
            .expect("a stat")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o755);
        let _ = std::fs::remove_dir_all(&out);
    }

    #[test]
    fn only_the_named_files_are_copied_when_the_caller_names_any() {
        let volume = Volume::new("only");
        let out = volume.0.with_extension("out");
        let _ = std::fs::remove_dir_all(&out);
        let only = "Fallout II Community Edition/Fallout.app/Contents/Info.plist";
        copy_tree(
            volume.root(),
            &out,
            &ExtractOptions {
                only: vec![only.to_owned()],
            },
        )
        .expect("a copy");
        assert!(out.join(only).exists());
        assert!(
            !out.join("Fallout II Community Edition/Fallout.app/Contents/MacOS")
                .exists()
        );
        let _ = std::fs::remove_dir_all(&out);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_on_the_volume_is_listed_as_one_and_never_recreated() {
        let volume = Volume::new("link");
        std::os::unix::fs::symlink("/etc", volume.0.join("Fallout II Community Edition/escape"))
            .expect("a link");
        let listed = list_tree(volume.root()).expect("a listing");
        assert!(listed.iter().any(|entry| {
            entry.name == "Fallout II Community Edition/escape"
                && entry.kind == ArchiveEntryKind::Link
        }));
        let out = volume.0.with_extension("out");
        let _ = std::fs::remove_dir_all(&out);
        let err = copy_tree(volume.root(), &out, &ExtractOptions::default())
            .expect_err("a link to refuse");
        assert!(format!("{err}").contains("symbolic link"), "{err}");
        assert!(!out.join("Fallout II Community Edition/escape").exists());
        let _ = std::fs::remove_dir_all(&out);
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn elsewhere_an_image_is_refused_with_the_system_that_can_open_it() {
        let err = list(Path::new("Fallout.dmg")).expect_err("no hdiutil here");
        assert!(format!("{err}").contains("only macOS"), "{err}");
    }
}

//! Reading and writing archives, in pure Rust.
//!
//! The TypeScript ran 7-Zip compiled to WebAssembly, which read every format the project meets from one
//! artifact. Pure crates cost that generality: `zip`, `sevenz-rust2` and `tar` over `flate2` cover the
//! four formats the releases this installs actually publish, and the two they do not cover are refused
//! by name rather than mis-read.
//!
//! What that leaves out is recorded here rather than left to be discovered:
//!
//! - `.rar` is in the payload suffixes a mod may publish, and no pure-Rust crate decodes it. A mod
//!   release that ships one is refused with a sentence saying so, which is the honest answer where the
//!   alternative is shipping a C library to read a format no followed feed currently uses.
//! - `.dmg` is how fallout2-ce publishes its macOS build. Reading one means reading HFS+, which again
//!   no pure-Rust crate does. The refusal names the format, so a macOS user is told why rather than
//!   shown a broken install.

use std::fs::File;
use std::io::{BufReader, BufWriter, Read as _, Write as _};
use std::path::{Component, Path, PathBuf};

use zax_platform::archive::{
    Archive, ArchiveEntry, ArchiveEntryInfo, ArchiveEntryKind, ExtractOptions,
};
use zax_platform::{Error, Result};

/// Which reader a file's name asks for. Decided by the name rather than by sniffing: a release states
/// what it published, and a `.tar.gz` and a `.7z` are told apart by their suffixes everywhere else in
/// this application too.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Format {
    Zip,
    SevenZip,
    Tar,
    TarGzip,
    /// A format this build has no reader for, named so the refusal can say which.
    Unreadable(&'static str),
}

fn format_of(archive: &Path) -> Format {
    let name = archive.to_string_lossy().to_lowercase();
    if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
        return Format::TarGzip;
    }
    if name.ends_with(".tar") {
        return Format::Tar;
    }
    if name.ends_with(".7z") {
        return Format::SevenZip;
    }
    if name.ends_with(".rar") {
        return Format::Unreadable("RAR");
    }
    if name.ends_with(".dmg") {
        return Format::Unreadable("Apple disk image");
    }
    // Everything else is tried as a zip, which is what an asset with no suffix ZAX knows most often is.
    Format::Zip
}

fn unreadable(archive: &Path, format: &str) -> Error {
    Error::Unsupported(format!(
        "{} is a {format} archive, which this build of ZAX cannot open.",
        archive.display()
    ))
}

fn failed(operation: &'static str, path: &Path, source: std::io::Error) -> Error {
    Error::Io {
        operation,
        path: path.to_string_lossy().into_owned(),
        source,
    }
}

fn broken(archive: &Path, why: &dyn std::fmt::Display) -> Error {
    Error::Archive(format!("Could not read {}: {why}", archive.display()))
}

/// A name from inside an archive, resolved under `destination` and refused where it would land outside
/// it.
///
/// The domain checks this too, at its own boundary, and both are meant: this one is the last word,
/// because it is what actually writes, and an archive reaching outside the directory it was given is
/// the one failure no later check can undo.
fn under(destination: &Path, name: &str) -> Result<PathBuf> {
    let held = name.replace('\\', "/");
    // Refused rather than trimmed: an entry naming an absolute path is not describing where it goes
    // relative to the folder it was handed, and quietly reading it as though it were would install it
    // somewhere the archive never said.
    if held.starts_with('/') {
        return Err(Error::Unsupported(format!(
            "\"{name}\" names a path outside the folder it is being unpacked into - refused."
        )));
    }
    let mut out = destination.to_path_buf();
    for segment in held.split('/') {
        match Path::new(segment).components().next() {
            None | Some(Component::CurDir) => {}
            Some(Component::Normal(held)) => out.push(held),
            // A parent hop, an absolute root, or a Windows drive prefix: all are an entry naming
            // somewhere other than where it was told to go.
            Some(Component::ParentDir | Component::RootDir | Component::Prefix(_)) => {
                return Err(Error::Unsupported(format!(
                    "\"{name}\" names a path outside the folder it is being unpacked into - refused."
                )));
            }
        }
    }
    Ok(out)
}

/// Whether this entry is one the caller asked for. An empty list is every entry.
fn wanted(only: &[String], name: &str) -> bool {
    if only.is_empty() {
        return true;
    }
    let name = name.replace('\\', "/").to_lowercase();
    only.iter()
        .any(|held| held.replace('\\', "/").to_lowercase() == name)
}

fn write_entry(destination: &Path, name: &str, bytes: &[u8]) -> Result<()> {
    let at = under(destination, name)?;
    if let Some(parent) = at.parent() {
        std::fs::create_dir_all(parent).map_err(|err| failed("mkdir", parent, err))?;
    }
    let mut file = File::create(&at).map_err(|err| failed("extract", &at, err))?;
    file.write_all(bytes)
        .map_err(|err| failed("extract", &at, err))
}

#[derive(Debug, Default)]
pub struct HostArchive;

impl HostArchive {
    fn open(archive: &Path) -> Result<BufReader<File>> {
        let file = File::open(archive).map_err(|err| failed("open", archive, err))?;
        Ok(BufReader::new(file))
    }

    /// A gzipped tar read whole into memory first, because `tar` wants a seekable reader for a second
    /// pass and a gzip stream is not one. The archives this meets are engine builds of a few megabytes.
    fn tar_bytes(archive: &Path, format: Format) -> Result<Vec<u8>> {
        let mut held = Vec::new();
        match format {
            Format::TarGzip => {
                let mut decoder = flate2::read::GzDecoder::new(Self::open(archive)?);
                decoder
                    .read_to_end(&mut held)
                    .map_err(|err| broken(archive, &err))?;
            }
            Format::Tar | Format::Zip | Format::SevenZip | Format::Unreadable(_) => {
                Self::open(archive)?
                    .read_to_end(&mut held)
                    .map_err(|err| failed("read", archive, err))?;
            }
        }
        Ok(held)
    }
}

impl Archive for HostArchive {
    fn extract(&self, archive: &Path, destination: &Path, options: &ExtractOptions) -> Result<()> {
        std::fs::create_dir_all(destination).map_err(|err| failed("mkdir", destination, err))?;
        match format_of(archive) {
            Format::Unreadable(format) => Err(unreadable(archive, format)),
            Format::Zip => {
                let mut held = zip::ZipArchive::new(Self::open(archive)?)
                    .map_err(|err| broken(archive, &err))?;
                for at in 0..held.len() {
                    let mut entry = held.by_index(at).map_err(|err| broken(archive, &err))?;
                    if entry.is_dir() || !wanted(&options.only, entry.name()) {
                        continue;
                    }
                    let name = entry.name().to_owned();
                    let mut bytes = Vec::new();
                    entry
                        .read_to_end(&mut bytes)
                        .map_err(|err| broken(archive, &err))?;
                    write_entry(destination, &name, &bytes)?;
                }
                Ok(())
            }
            Format::SevenZip => {
                let mut held = sevenz_rust2::ArchiveReader::new(
                    Self::open(archive)?,
                    sevenz_rust2::Password::empty(),
                )
                .map_err(|err| broken(archive, &err))?;
                let mut failure: Option<Error> = None;
                held.for_each_entries(|entry, reader| {
                    if entry.is_directory() || !wanted(&options.only, entry.name()) {
                        return Ok(true);
                    }
                    let mut bytes = Vec::new();
                    reader.read_to_end(&mut bytes)?;
                    if let Err(err) = write_entry(destination, entry.name(), &bytes) {
                        // Carried out rather than raised through the callback, whose error type is the
                        // library's: what reaches the caller is this application's own refusal.
                        failure = Some(err);
                        return Ok(false);
                    }
                    Ok(true)
                })
                .map_err(|err| broken(archive, &err))?;
                failure.map_or(Ok(()), Err)
            }
            format @ (Format::Tar | Format::TarGzip) => {
                let bytes = Self::tar_bytes(archive, format)?;
                let mut held = tar::Archive::new(std::io::Cursor::new(bytes));
                for entry in held.entries().map_err(|err| broken(archive, &err))? {
                    let mut entry = entry.map_err(|err| broken(archive, &err))?;
                    let name = entry
                        .path()
                        .map_err(|err| broken(archive, &err))?
                        .to_string_lossy()
                        .into_owned();
                    if entry.header().entry_type().is_dir() || !wanted(&options.only, &name) {
                        continue;
                    }
                    let mut content = Vec::new();
                    entry
                        .read_to_end(&mut content)
                        .map_err(|err| broken(archive, &err))?;
                    write_entry(destination, &name, &content)?;
                }
                Ok(())
            }
        }
    }

    fn list(&self, archive: &Path) -> Result<Vec<ArchiveEntryInfo>> {
        match format_of(archive) {
            Format::Unreadable(format) => Err(unreadable(archive, format)),
            Format::Zip => {
                let mut held = zip::ZipArchive::new(Self::open(archive)?)
                    .map_err(|err| broken(archive, &err))?;
                let mut out = Vec::new();
                for at in 0..held.len() {
                    let entry = held.by_index(at).map_err(|err| broken(archive, &err))?;
                    // A zip records the Unix mode of the machine that wrote it, and a symbolic link is
                    // the one entry the archive guard refuses outright.
                    let link = entry
                        .unix_mode()
                        .is_some_and(|mode| mode & 0o170_000 == 0o120_000);
                    out.push(ArchiveEntryInfo {
                        name: entry.name().replace('\\', "/"),
                        kind: if link {
                            ArchiveEntryKind::Link
                        } else if entry.is_dir() {
                            ArchiveEntryKind::Dir
                        } else {
                            ArchiveEntryKind::File
                        },
                        size: entry.size(),
                    });
                }
                Ok(out)
            }
            Format::SevenZip => {
                let held = sevenz_rust2::ArchiveReader::new(
                    Self::open(archive)?,
                    sevenz_rust2::Password::empty(),
                )
                .map_err(|err| broken(archive, &err))?;
                Ok(held
                    .archive()
                    .files
                    .iter()
                    .map(|entry| ArchiveEntryInfo {
                        name: entry.name().replace('\\', "/"),
                        kind: if entry.is_directory() {
                            ArchiveEntryKind::Dir
                        } else {
                            ArchiveEntryKind::File
                        },
                        size: entry.size(),
                    })
                    .collect())
            }
            format @ (Format::Tar | Format::TarGzip) => {
                let bytes = Self::tar_bytes(archive, format)?;
                let mut held = tar::Archive::new(std::io::Cursor::new(bytes));
                let mut out = Vec::new();
                for entry in held.entries().map_err(|err| broken(archive, &err))? {
                    let entry = entry.map_err(|err| broken(archive, &err))?;
                    let kind = entry.header().entry_type();
                    out.push(ArchiveEntryInfo {
                        name: entry
                            .path()
                            .map_err(|err| broken(archive, &err))?
                            .to_string_lossy()
                            .replace('\\', "/"),
                        kind: if kind.is_symlink() || kind.is_hard_link() {
                            ArchiveEntryKind::Link
                        } else if kind.is_dir() {
                            ArchiveEntryKind::Dir
                        } else {
                            ArchiveEntryKind::File
                        },
                        size: entry.size(),
                    });
                }
                Ok(out)
            }
        }
    }

    fn create_zip(&self, destination: &Path, entries: &[ArchiveEntry]) -> Result<()> {
        if let Some(parent) = destination.parent().filter(|at| !at.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent).map_err(|err| failed("mkdir", parent, err))?;
        }
        let file = File::create(destination).map_err(|err| failed("write", destination, err))?;
        let mut zip = zip::ZipWriter::new(BufWriter::new(file));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for entry in entries {
            let mut source =
                File::open(&entry.source).map_err(|err| failed("read", &entry.source, err))?;
            zip.start_file(entry.name.replace('\\', "/"), options)
                .map_err(|err| broken(destination, &err))?;
            std::io::copy(&mut source, &mut zip)
                .map_err(|err| failed("write", destination, err))?;
        }
        zip.finish().map_err(|err| broken(destination, &err))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(named: &str) -> Self {
            let at = std::env::temp_dir().join(format!("zax-archive-{named}"));
            let _ = std::fs::remove_dir_all(&at);
            std::fs::create_dir_all(&at).expect("a directory the test makes");
            Self(at)
        }

        fn at(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A zip built by the same crate that reads it, rather than a hand-typed fixture.
    fn zip_of(at: &Path, entries: &[(&str, &str)]) {
        let file = File::create(at).expect("a file the test writes");
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        for (name, body) in entries {
            zip.start_file(*name, options).expect("an entry");
            zip.write_all(body.as_bytes()).expect("its bytes");
        }
        zip.finish().expect("a built archive");
    }

    fn tar_gz_of(at: &Path, entries: &[(&str, &str)]) {
        let file = File::create(at).expect("a file the test writes");
        let encoder = flate2::write::GzEncoder::new(file, flate2::Compression::fast());
        let mut builder = tar::Builder::new(encoder);
        for (name, body) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(body.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder
                .append_data(&mut header, name, body.as_bytes())
                .expect("an entry");
        }
        builder
            .into_inner()
            .expect("a built archive")
            .finish()
            .expect("a flush");
    }

    #[test]
    fn a_name_decides_which_reader_an_archive_gets() {
        assert_eq!(format_of(Path::new("a/b.ZIP")), Format::Zip);
        assert_eq!(format_of(Path::new("sfall_4.5.7z")), Format::SevenZip);
        assert_eq!(format_of(Path::new("ce-linux.tar.gz")), Format::TarGzip);
        assert_eq!(format_of(Path::new("ce-linux.tgz")), Format::TarGzip);
        assert_eq!(format_of(Path::new("x.tar")), Format::Tar);
        assert_eq!(format_of(Path::new("mod.rar")), Format::Unreadable("RAR"));
        assert_eq!(
            format_of(Path::new("Fallout.dmg")),
            Format::Unreadable("Apple disk image")
        );
    }

    #[test]
    fn a_format_this_build_cannot_open_is_refused_by_name() {
        // Rather than mis-read, and rather than a word the user cannot act on.
        let scratch = Scratch::new("unreadable");
        let at = scratch.at("mod.rar");
        std::fs::write(&at, b"Rar!").expect("a file the test writes");
        let err = HostArchive.list(&at).expect_err("no reader for it");
        assert!(format!("{err}").contains("RAR archive"), "{err}");
        let err = HostArchive
            .extract(&at, &scratch.at("out"), &ExtractOptions::default())
            .expect_err("no reader for it");
        assert!(format!("{err}").contains("cannot open"), "{err}");
    }

    #[test]
    fn a_zip_lists_and_extracts_what_it_holds() {
        let scratch = Scratch::new("zip");
        let at = scratch.at("mod.zip");
        zip_of(&at, &[("mods/ecco.dat", "dat"), ("readme.txt", "hello")]);
        let mut listed = HostArchive.list(&at).expect("a listing");
        listed.sort_by(|a, b| a.name.cmp(&b.name));
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].name, "mods/ecco.dat");
        assert_eq!(listed[0].kind, ArchiveEntryKind::File);
        assert_eq!(listed[0].size, 3);

        let out = scratch.at("out");
        HostArchive
            .extract(&at, &out, &ExtractOptions::default())
            .expect("an extraction");
        assert_eq!(
            std::fs::read(out.join("mods/ecco.dat")).expect("a read"),
            b"dat"
        );
        assert_eq!(
            std::fs::read(out.join("readme.txt")).expect("a read"),
            b"hello"
        );
    }

    #[test]
    fn only_the_named_entries_are_unpacked_when_the_caller_names_any() {
        // An archive asked for another part's paths would be asked for paths it does not carry.
        let scratch = Scratch::new("only");
        let at = scratch.at("mod.zip");
        zip_of(&at, &[("mods/a.dat", "a"), ("mods/b.dat", "b")]);
        let out = scratch.at("out");
        HostArchive
            .extract(
                &at,
                &out,
                &ExtractOptions {
                    only: vec!["mods/a.dat".to_owned()],
                },
            )
            .expect("an extraction");
        assert!(out.join("mods/a.dat").exists());
        assert!(!out.join("mods/b.dat").exists());
    }

    #[test]
    fn an_entry_naming_a_path_outside_the_folder_is_refused() {
        // The last word, because it is what actually writes.
        let scratch = Scratch::new("escape");
        let at = scratch.at("evil.zip");
        zip_of(&at, &[("../escaped.txt", "out")]);
        let out = scratch.at("out");
        let err = HostArchive
            .extract(&at, &out, &ExtractOptions::default())
            .expect_err("an entry reaching outside");
        assert!(format!("{err}").contains("outside the folder"), "{err}");
        assert!(!scratch.at("escaped.txt").exists());
    }

    #[test]
    fn every_shape_of_escaping_name_is_refused() {
        // Against the guard itself rather than through an archive: a zip writer normalises a leading
        // slash away as it writes, so a fixture cannot carry one to the reader.
        let into = Path::new("/into");
        for name in ["../out", "a/../../out", "/etc/passwd", "a/./../../b"] {
            assert!(under(into, name).is_err(), "{name} was not refused");
        }
        // And the ordinary shapes still resolve where they were told to.
        assert_eq!(
            under(into, "mods/ecco.dat").expect("an ordinary name"),
            Path::new("/into/mods/ecco.dat")
        );
        assert_eq!(
            under(into, "./a/b.txt").expect("a name with a current-directory hop"),
            Path::new("/into/a/b.txt")
        );
        // A backslash is a separator here, as the archives that use one intend.
        assert_eq!(
            under(into, "mods\\ecco.dat").expect("a windows-spelled name"),
            Path::new("/into/mods/ecco.dat")
        );
    }

    #[test]
    fn a_gzipped_tar_reads_the_same_way_a_zip_does() {
        let scratch = Scratch::new("targz");
        let at = scratch.at("ce-linux.tar.gz");
        tar_gz_of(
            &at,
            &[
                ("fallout2-ce-linux-x64/fallout2-ce", "elf"),
                ("x/ce.dat", "dat"),
            ],
        );
        let listed = HostArchive.list(&at).expect("a listing");
        assert_eq!(listed.len(), 2);
        assert!(listed.iter().any(|one| one.name.ends_with("fallout2-ce")));
        let out = scratch.at("out");
        HostArchive
            .extract(&at, &out, &ExtractOptions::default())
            .expect("an extraction");
        assert_eq!(
            std::fs::read(out.join("fallout2-ce-linux-x64/fallout2-ce")).expect("a read"),
            b"elf"
        );
    }

    #[test]
    fn something_that_is_not_an_archive_at_all_fails_rather_than_unpacking_nothing() {
        let scratch = Scratch::new("garbage");
        let at = scratch.at("mod.zip");
        std::fs::write(&at, b"an error page, served with a 200").expect("a file the test writes");
        assert!(HostArchive.list(&at).is_err());
    }

    #[test]
    fn a_zip_is_written_from_the_files_it_is_given() {
        let scratch = Scratch::new("create");
        std::fs::create_dir_all(scratch.at("from")).expect("a directory the test makes");
        std::fs::write(scratch.at("from/a.cfg"), b"[system]\n").expect("a file");
        std::fs::write(scratch.at("from/b.log"), b"a line\n").expect("a file");
        let at = scratch.at("debug.zip");
        HostArchive
            .create_zip(
                &at,
                &[
                    ArchiveEntry {
                        source: scratch.at("from/a.cfg"),
                        name: "a.cfg".to_owned(),
                    },
                    ArchiveEntry {
                        source: scratch.at("from/b.log"),
                        name: "logs/b.log".to_owned(),
                    },
                ],
            )
            .expect("an archive");
        let mut listed = HostArchive.list(&at).expect("a listing");
        listed.sort_by(|a, b| a.name.cmp(&b.name));
        assert_eq!(listed[0].name, "a.cfg");
        assert_eq!(listed[1].name, "logs/b.log");
        // And it round-trips: what was written is what comes back out.
        let out = scratch.at("out");
        HostArchive
            .extract(&at, &out, &ExtractOptions::default())
            .expect("an extraction");
        assert_eq!(
            std::fs::read(out.join("logs/b.log")).expect("a read"),
            b"a line\n"
        );
    }

    #[test]
    fn a_zip_naming_a_file_that_is_not_there_fails_rather_than_writing_half_of_it() {
        let scratch = Scratch::new("create-missing");
        let err = HostArchive
            .create_zip(
                &scratch.at("debug.zip"),
                &[ArchiveEntry {
                    source: scratch.at("nothing"),
                    name: "nothing".to_owned(),
                }],
            )
            .expect_err("nothing to add");
        assert!(matches!(err, Error::Io { .. }), "{err:?}");
    }
}

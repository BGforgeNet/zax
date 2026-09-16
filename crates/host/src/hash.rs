//! Digests of files on disk.
//!
//! Streamed rather than read whole: the largest thing this hashes is a downloaded mod archive, and
//! RPU's runs to a gigabyte.

use std::fs::File;
use std::io::Read as _;
use std::path::Path;

use md5::Md5;
use sha2::{Digest, Sha256};
use zax_platform::hash::Hashing;
use zax_platform::{Error, Result};

/// 64 KiB: large enough that the syscall is not what this costs, small enough to stay off the stack
/// and out of a cache it would evict.
const CHUNK: usize = 64 * 1024;

fn failed(path: &Path, source: std::io::Error) -> Error {
    Error::Io {
        operation: "hash",
        path: path.to_string_lossy().into_owned(),
        source,
    }
}

fn stream<D: Digest>(path: &Path) -> Result<String> {
    let mut file = File::open(path).map_err(|err| failed(path, err))?;
    let mut digest = D::new();
    let mut buffer = vec![0u8; CHUNK];
    loop {
        let read = file.read(&mut buffer).map_err(|err| failed(path, err))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(hex::encode(digest.finalize()))
}

#[derive(Debug, Default)]
pub struct HostHashing;

impl Hashing for HostHashing {
    fn sha256(&self, path: &Path) -> Result<String> {
        stream::<Sha256>(path)
    }

    fn md5(&self, path: &Path) -> Result<String> {
        stream::<Md5>(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(named: &str, bytes: &[u8]) -> std::path::PathBuf {
        let at = std::env::temp_dir().join(format!("zax-hash-{named}"));
        std::fs::write(&at, bytes).expect("a file the test writes");
        at
    }

    #[test]
    fn the_digests_are_the_published_ones_for_an_empty_file() {
        // The two vectors every implementation of these is checked against.
        let at = scratch("empty", b"");
        assert_eq!(
            HostHashing.sha256(&at).expect("a digest"),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            HostHashing.md5(&at).expect("a digest"),
            "d41d8cd98f00b204e9800998ecf8427e"
        );
        std::fs::remove_file(&at).expect("the file the test wrote");
    }

    #[test]
    fn a_file_larger_than_one_chunk_hashes_as_its_whole_content() {
        // What catches a streaming loop that drops or repeats a block.
        let bytes: Vec<u8> = (0..CHUNK * 2 + 17).map(|at| (at % 251) as u8).collect();
        let at = scratch("chunks", &bytes);
        let streamed = HostHashing.sha256(&at).expect("a digest");
        let whole = hex::encode(Sha256::digest(&bytes));
        assert_eq!(streamed, whole);
        std::fs::remove_file(&at).expect("the file the test wrote");
    }

    #[test]
    fn a_file_that_is_not_there_fails_rather_than_answering_a_digest() {
        let at = std::env::temp_dir().join("zax-hash-nothing-at-all");
        let _ = std::fs::remove_file(&at);
        assert!(HostHashing.sha256(&at).is_err());
    }
}

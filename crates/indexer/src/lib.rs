//! The indexer: builds the one document every installed ZAX reads to find mods, from the source files
//! ZAX's maintainers keep and the releases the followed repositories publish.
//!
//! It is the only thing that interprets a repository - its tags, its assets, the manifest at a tag -
//! and it always runs the latest code, so a rule about any of those changes here rather than in every
//! copy of ZAX already installed.

pub mod build;
pub mod github;
pub mod source;

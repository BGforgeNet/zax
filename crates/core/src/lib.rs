//! Domain logic: ini parsing, catalog types, install state. Reaches the outside world only through
//! the seam in `zax-platform`, and holds no host calls of its own.
//!
//! One TypeScript module has no counterpart here. `record.ts` existed to narrow a parsed `unknown`
//! into something whose keys could be read, which is a question Rust answers at the deserializer
//! instead.

pub mod action;
pub mod catalog;
pub mod hash;
pub mod ini;
pub mod ini_merge;
pub mod install;
pub mod keys;
pub mod stamp;
pub mod text;
pub mod validate;
pub mod vdf;
pub mod version;

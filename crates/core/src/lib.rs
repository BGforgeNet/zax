//! Domain logic: ini parsing, catalog types, install state. Reaches the outside world only through
//! the seam in `zax-platform`, and holds no host calls of its own.

pub mod ini;
pub mod text;

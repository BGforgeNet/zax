#!/bin/bash
# Installs wasm-bindgen-cli at the version Cargo.lock pins the library to. The two must match exactly - the
# CLI refuses a module built against another version - so the version is read rather than restated here.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

version=$(awk '$0 == "name = \"wasm-bindgen\"" { getline; gsub(/version = |"/, ""); print; exit }' Cargo.lock)
if [ -z "$version" ]; then
  echo "Cargo.lock names no wasm-bindgen package to match." >&2
  exit 1
fi
# A restored cache carries the binary without cargo's record of installing it, which `cargo install` refuses
# to overwrite - so a binary already at this version is the answer, and any other, or none, is replaced. Its
# errors are discarded because every way of not answering the version means the same thing: install it.
if [ "$(wasm-bindgen --version 2>/dev/null || true)" = "wasm-bindgen $version" ]; then
  exit 0
fi
cargo install wasm-bindgen-cli --version "$version" --locked --force

#!/usr/bin/env bash
# Builds the browser preview's WebAssembly: the domain and the in-memory machine, for the host that has
# no machine to reach. The desktop build does not use it and does not carry it.
#
# Needs the wasm32-unknown-unknown target, which rust-toolchain.toml brings along under rustup, and
# wasm-bindgen-cli at the version Cargo.lock pins, which .github/scripts/install-wasm-bindgen.sh installs.

set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/packages/ui/src/lib/preview-wasm"

cd "$root"

cargo build --release --target wasm32-unknown-unknown --package zax-preview

# `web` rather than `bundler`: the preview is loaded by an import from the page, and this target needs
# no bundler plugin to do it. The declarations come with it, so the one call into the preview is typed
# the way every other call in the interface is.
wasm-bindgen \
  --target web \
  --out-dir "$out" \
  target/wasm32-unknown-unknown/release/zax_preview.wasm

printf 'preview built: %s\n' "$(du -h "$out/zax_preview_bg.wasm" | cut -f1)"

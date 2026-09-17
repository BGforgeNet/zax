#!/usr/bin/env bash
# Builds the mod-ini action's WebAssembly into actions/mod-ini/wasm, which is committed: an action runs
# from the repository at its caller's ref, with nothing built. CI rebuilds it and fails on any difference
# (`.github/scripts/check-generated.sh`), so the build has to give the same bytes on any machine.
#
# Needs what scripts/build-preview.sh needs: the wasm32-unknown-unknown target, and wasm-bindgen-cli at the
# version Cargo.lock pins.

set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/actions/mod-ini/wasm"
cargo_home="${CARGO_HOME:-$HOME/.cargo}"

cd "$root"

# Panic locations carry source paths, which differ between a checkout here and one on the runner; mapped
# to fixed names, they stop being part of the output. Its own target directory, because changed flags
# would otherwise rebuild everything the native builds share.
RUSTFLAGS="--remap-path-prefix=$root=zax --remap-path-prefix=$cargo_home=cargo" \
  CARGO_TARGET_DIR="$root/target/mod-tools" \
  cargo build --release --locked --target wasm32-unknown-unknown --package zax-mod-tools

# `web` for its `initSync`, which takes the module's bytes: the loader reads them from beside itself,
# and Node's fetch cannot read a file URL, which the other entry point would need. The declarations come
# along so the typecheck reads them rather than checking the generated JavaScript.
wasm-bindgen \
  --target web \
  --out-dir "$out" \
  target/mod-tools/wasm32-unknown-unknown/release/zax_mod_tools.wasm

printf 'mod tools built: %s\n' "$(du -h "$out/zax_mod_tools_bg.wasm" | cut -f1)"

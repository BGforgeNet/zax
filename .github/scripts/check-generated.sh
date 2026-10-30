#!/bin/bash
# The generated modules must be what their generators produce. The tests read the committed output, so a hand
# edit - or a generator change nobody regenerated for - passes every one of them.
set -euo pipefail

node scripts/gen/gen-catalog.mjs
node scripts/gen/gen-layout.mjs
git diff --exit-code crates/fallout2/data/

# The mod-ini action runs its committed WebAssembly, not the Rust the tests read.
scripts/build-mod-tools.sh
git diff --exit-code actions/mod-ini/wasm/

# The committed icons are a rendering of zax.svg, not hand-authored - the runner image ships Chrome, which
# gen-icons.mjs already looks for on PATH.
#
# All but the macOS icon: `tauri icon` writes a different `.icns` from the same rendering on every run, while
# the PNGs and the `.ico` cut from that rendering stay byte-identical - and they are what this compares.
node scripts/gen-icons.mjs
git diff --exit-code packages/ui/public/zax.png crates/shell/icons/ ':!crates/shell/icons/icon.icns'

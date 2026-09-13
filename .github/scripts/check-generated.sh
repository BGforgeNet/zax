#!/bin/bash
# The generated modules must be what their generators produce. The tests read the committed output, so a hand
# edit - or a generator change nobody regenerated for - passes every one of them.
set -euo pipefail

node scripts/gen/gen-catalog.mjs
node scripts/gen/gen-layout.mjs
git diff --exit-code packages/games-fallout2/src/catalog.ts packages/games-fallout2/src/layout.ts

# The mod-ini action runs its committed bundle, not the sources the tests read.
node scripts/mod-ini/build.mjs
git diff --exit-code actions/mod-ini/dist/action.mjs

# The committed icons are a rendering of zax.svg, not hand-authored - the runner image ships Chrome, which
# gen-icons.mjs already looks for on PATH.
node scripts/gen-icons.mjs
git diff --exit-code packages/ui/public/zax.png packages/app/build/icon.png

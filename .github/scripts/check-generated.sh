#!/bin/bash
# The generated modules must be what their generators produce. The tests read the committed output, so a hand
# edit - or a generator change nobody regenerated for - passes every one of them.
set -euo pipefail

node scripts/gen/gen-catalog.mjs
node scripts/gen/gen-layout.mjs
git diff --exit-code packages/games-fallout2/src/catalog.ts packages/games-fallout2/src/layout.ts

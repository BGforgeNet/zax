#!/bin/bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
readonly ROOT
scratch=$(mktemp -d)
trap 'rm -rf "${scratch}"' EXIT

cd "${scratch}"
touch f2mod.yml
mkdir -p mods
mkdir -p -- -payload
touch -- "mods/file with spaces.dat" "mods/literal[1].dat" "-payload/option.dat"

PATHS=$'mods/file with spaces.dat\nmods/literal[1].dat\n-payload' \
  DIRECTORY=. \
  NAME=test \
  GITHUB_REF_TYPE=tag \
  GITHUB_REF_NAME=v1.2.3 \
  GITHUB_REPOSITORY=example/test \
  GITHUB_WORKSPACE="${scratch}" \
  GITHUB_OUTPUT="${scratch}/output" \
  "${ROOT}/actions/pack-mod/scripts/pack.sh"

entries=$(unzip -Z1 test_v1.2.3.zip)
grep -Fxq 'mods/file with spaces.dat' <<<"${entries}"
grep -Fxq 'mods/literal[1].dat' <<<"${entries}"
grep -Fxq -- '-payload/option.dat' <<<"${entries}"
grep -Fxq 'archive=test_v1.2.3.zip' output
grep -Fxq 'version=1.2.3' output

echo "Pack path checks passed."

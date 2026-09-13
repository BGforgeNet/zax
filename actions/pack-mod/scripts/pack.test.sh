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

# A name Windows cannot create is refused before anything is packed: the run that produced it is the only
# place an author hears about it, since the archive would install everywhere else and fail only there.
mkdir -p refused/mods
touch refused/mods/aux.dat
if PATHS=mods \
  DIRECTORY=refused \
  NAME=refused \
  GITHUB_REF_TYPE=tag \
  GITHUB_REF_NAME=v1.2.3 \
  GITHUB_REPOSITORY=example/test \
  GITHUB_WORKSPACE="${scratch}" \
  GITHUB_OUTPUT="${scratch}/output" \
  "${ROOT}/actions/pack-mod/scripts/pack.sh" 2>refused.err; then
  echo "pack.sh packed a payload naming a device Windows reserves." >&2
  exit 1
fi
grep -Fq 'mods/aux.dat' refused.err

# check-ini runs the mod-ini bundle before anything is packed, so an ini that disagrees with the manifest stops
# the release rather than shipping controls for values the mod never had.
mkdir -p "${scratch}/checked/mods"
cd "${scratch}/checked"
printf 'spec: 1\nid: checked\nname: Checked\ngame: fallout2\nsettings:\n  main.on: { kind: bool, label: On, default: 1 }\n' >f2mod.yml
printf '[main]\r\non=0\r\n' >mods/checked.ini
pack_checked() {
  PATHS=mods \
    DIRECTORY=. \
    NAME=checked \
    CHECK_INI="$1" \
    ACTION_PATH="${ROOT}/actions/pack-mod" \
    GITHUB_REF_TYPE=tag \
    GITHUB_REF_NAME=v1.2.3 \
    GITHUB_REPOSITORY=example/checked \
    GITHUB_WORKSPACE="${scratch}/checked" \
    GITHUB_OUTPUT="${scratch}/checked/output" \
    "${ROOT}/actions/pack-mod/scripts/pack.sh"
}
if pack_checked soft 2>mismatch.err; then
  echo "pack.sh packed a payload whose ini disagrees with its manifest." >&2
  exit 1
fi
grep -Fq 'mods/checked.ini [main] on: the file ships "0", the manifest'"'"'s default is "1"' mismatch.err
[ ! -e checked_v1.2.3.zip ]
if pack_checked maybe 2>value.err; then
  echo "pack.sh accepted a check-ini value that is neither soft nor hard." >&2
  exit 1
fi
grep -Fq 'check-ini is "maybe"' value.err
printf '[main]\r\non=1\r\n' >mods/checked.ini
pack_checked hard
grep -Fxq 'mods/checked.ini' <<<"$(unzip -Z1 checked_v1.2.3.zip)"

echo "Pack path checks passed."

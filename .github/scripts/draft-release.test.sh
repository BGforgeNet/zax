#!/bin/bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
readonly ROOT
readonly SCRIPT="${ROOT}/.github/scripts/draft-release.sh"
scratch=$(mktemp -d)
trap 'rm -rf "${scratch}"' EXIT

make_artifacts() {
  mkdir -p artifacts
  touch artifacts/ZAX-0.8.0-linux-x64.AppImage
  touch artifacts/ZAX-0.8.0-linux-x64.tar.gz
  touch artifacts/ZAX-0.8.0-win-x64.exe
  touch artifacts/ZAX-0.8.0-win-x64.zip
  touch artifacts/ZAX-0.8.0-mac-x64.zip
}

gh() {
  printf '%s\n' "$*" >>"${GH_CALLS}"
  if [[ "$1 $2" == "release view" ]]; then
    if [[ "${GH_RELEASE_EXISTS}" != "true" ]]; then
      return 1
    fi
    printf '%s\n' "${GH_RELEASE_DRAFT}"
  fi
}
export -f gh

run_case() {
  local name=$1
  local exists=$2
  local draft=$3
  local directory="${scratch}/${name}"
  mkdir -p "${directory}"
  (
    cd "${directory}"
    make_artifacts
    GH_CALLS="${directory}/calls" GH_RELEASE_EXISTS="${exists}" GH_RELEASE_DRAFT="${draft}" TAG=v0.8.0 \
      bash "${SCRIPT}"
  )
}

run_case new false false
grep -qx 'release create v0.8.0 --draft --title v0.8.0 --generate-notes artifacts/ZAX-0.8.0-linux-x64.AppImage artifacts/ZAX-0.8.0-linux-x64.tar.gz artifacts/ZAX-0.8.0-mac-x64.zip artifacts/ZAX-0.8.0-win-x64.exe artifacts/ZAX-0.8.0-win-x64.zip' \
  "${scratch}/new/calls"

run_case draft true true
grep -qx 'release delete v0.8.0 --yes' "${scratch}/draft/calls"
grep -q '^release create v0.8.0 ' "${scratch}/draft/calls"

mkdir -p "${scratch}/published"
if run_case published true false >"${scratch}/published/output" 2>&1; then
  echo "A published release was replaced." >&2
  exit 1
fi
if grep -Eq '^release (delete|create) ' "${scratch}/published/calls"; then
  echo "A published release was changed." >&2
  exit 1
fi

echo "Release rerun checks passed."

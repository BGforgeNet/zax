#!/bin/bash
# Creates the release for a tag and attaches everything built for it. It is created as a draft and published once
# every file is attached, so nobody can download a release that is still missing platforms.
set -euo pipefail

# What a complete release carries, as a count per extension: one file each. Counted by extension rather than by
# filename so this does not depend on the version in each name - only on a target having produced something.
#
# The upload steps cannot answer this on their own. `if-no-files-found` asks whether a step found anything, and
# a step that never runs - a matrix entry removed, an `if:` that no longer matches its runner - is not a
# failure at all. Either way the files simply do not arrive, and without this a release goes out quietly short
# of a platform.
readonly EXPECTED=(
  "1 *.AppImage"
  "1 *.tar.gz"
  "1 *.exe"
  "1 *.zip"
)

shopt -s nullglob
files=(artifacts/*)
if [[ ${#files[@]} -eq 0 ]]; then
  echo "No artifacts to attach - the build jobs produced nothing." >&2
  exit 1
fi

missing=()
for entry in "${EXPECTED[@]}"; do
  want=${entry%% *}
  pattern=${entry#* }
  # Unquoted on purpose: the pattern is this script's own, and globbing it is the whole point.
  # shellcheck disable=SC2206
  matches=(artifacts/$pattern)
  if [[ ${#matches[@]} -ne ${want} ]]; then
    missing+=("${pattern}: expected ${want}, found ${#matches[@]}")
  fi
done

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "The build did not produce a complete set of distributables:" >&2
  printf '  %s\n' "${missing[@]}" >&2
  echo "A target stopped building, or its upload step did not run. Nothing was released." >&2
  exit 1
fi

echo "Attaching ${#files[@]} files:"
printf '  %s\n' "${files[@]}"

# Re-running a release must not fail on the draft a failed run left behind, so an existing draft is replaced rather
# than added to - otherwise a second run attaches a second copy of every file. A published release is immutable
# here: deleting one turns a routine workflow rerun into the disappearance of a release users already have.
if draft=$(gh release view "${TAG}" --json isDraft --jq .isDraft 2>/dev/null); then
  if [[ "${draft}" != "true" ]]; then
    echo "Release ${TAG} is already published; refusing to replace it." >&2
    exit 1
  fi
  echo "Draft ${TAG} already exists; deleting it before creating it again."
  gh release delete "${TAG}" --yes
fi

gh release create "${TAG}" \
  --draft \
  --title "${TAG}" \
  --generate-notes \
  "${files[@]}"

gh release edit "${TAG}" --draft=false

echo "Published ${TAG}."

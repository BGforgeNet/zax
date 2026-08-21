#!/bin/bash
# Creates the draft release and attaches everything built for it. Draft rather than published: a person looks at
# the artifacts before they become what users download.
set -euo pipefail

# What a complete release carries, as a count per extension. Two zips because Windows and macOS each produce
# one; everything else is a single file. Counted by extension rather than by filename so this does not depend
# on electron-builder's name macros - only on a target having produced something.
#
# The upload steps cannot answer this on their own. `if-no-files-found` asks whether a step found anything, and
# a step that never runs - a matrix entry removed, an `if:` that no longer matches its runner - is not a
# failure at all. Either way the files simply do not arrive, and without this a release goes out quietly short
# of a platform.
readonly EXPECTED=(
  "1 *.AppImage"
  "1 *.tar.gz"
  "1 *.exe"
  "2 *.zip"
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
  echo "A target stopped building, or its upload step did not run. Nothing was drafted." >&2
  exit 1
fi

echo "Attaching ${#files[@]} files:"
printf '  %s\n' "${files[@]}"

# Re-running a release must not fail on the draft that already exists, so an existing one is replaced rather
# than added to - otherwise a second run attaches a second copy of every file.
if gh release view "${TAG}" >/dev/null 2>&1; then
  echo "Release ${TAG} already exists; deleting it before drafting again."
  gh release delete "${TAG}" --yes
fi

gh release create "${TAG}" \
  --draft \
  --title "${TAG}" \
  --generate-notes \
  "${files[@]}"

echo "Drafted ${TAG}. Publish it with: gh release edit ${TAG} --draft=false"

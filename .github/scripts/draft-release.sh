#!/bin/bash
# Creates the draft release and attaches everything built for it. Draft rather than published: a person looks at
# the artifacts before they become what users download.
set -euo pipefail

shopt -s nullglob
files=(artifacts/*)
if [[ ${#files[@]} -eq 0 ]]; then
  echo "No artifacts to attach - the build jobs produced nothing." >&2
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

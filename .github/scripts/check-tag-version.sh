#!/bin/bash
# Fails when the tag being released does not name the version in the manifest. The version lives once, in the
# root package.json, and the interface reads it from there - so a mismatch ships binaries that report a version
# no release has, and the update check then offers an upgrade to something already installed.
set -euo pipefail

version=$(node -p 'require("./package.json").version')
expected="v${version}"

if [[ "${TAG}" != "${expected}" ]]; then
  echo "Tag ${TAG} does not match the manifest version (${expected})." >&2
  echo "Set the version in package.json and tag that, or tag ${expected}." >&2
  exit 1
fi

echo "Tag ${TAG} matches the manifest version."

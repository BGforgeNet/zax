#!/bin/bash
# Packs a mod's payload into the release archive, and refuses before packing anything when the run could only
# produce a release ZAX passes over silently.
set -euo pipefail

if [ "${GITHUB_REF_TYPE:-}" != "tag" ]; then
  echo "This action packs a tag's release; it ran on ${GITHUB_REF_TYPE:-nothing}." >&2
  exit 1
fi
version="${GITHUB_REF_NAME#v}"
# ZAX passes over a tag whose version does not start with a digit, so a release built from one would be
# published and never offered. Refusing here is the difference between a red run and a silent miss.
case "$version" in
  [0-9]*) ;;
  *)
    echo "The tag \"$GITHUB_REF_NAME\" names no version - ZAX reads v14.7 as 14.7 and ignores the rest." >&2
    exit 1
    ;;
esac

if [ ! -f f2mod.yml ]; then
  echo "No f2mod.yml at the repository root, which is where ZAX reads it for the tag." >&2
  exit 1
fi

cd "$DIRECTORY"
if [ ! -d mods ] || [ -z "$(find mods -type f -print -quit)" ]; then
  echo "Nothing under mods/ in \"$DIRECTORY\" - a payload with no mods/ installs nothing." >&2
  exit 1
fi

# `<name>_<tag>.zip`, the tag whole rather than the version - the naming Fallout 2 mod releases already use,
# and what a person scanning a releases page expects to see.
name="${NAME:-${GITHUB_REPOSITORY##*/}}"
archive="${name}_${GITHUB_REF_NAME}.zip"
# Removed first: zip ADDS to an archive that already exists, so a build that packed one under this name - or a
# re-run - would ship its entries merged with these rather than replaced.
rm -f -- "$archive"
# Split only at line boundaries. Ordinary shell expansion also splits at spaces and treats wildcard characters
# as patterns, turning a path list into a different set of files before zip ever sees it.
paths=()
while IFS= read -r path; do
  # A multiline action input uses LF, but accepting CRLF here costs nothing and avoids making the CR a filename.
  path=${path%$'\r'}
  if [ -n "$path" ]; then paths+=("$path"); fi
done <<<"${PATHS:-}"
if [ ${#paths[@]} -eq 0 ]; then
  echo "No paths were given to pack." >&2
  exit 1
fi
# -X drops per-machine file attributes. The archive's ./ prefix makes its own leading hyphen inert, while the
# later -- does the same for every input path; Info-ZIP requires its archive name to come before that marker.
zip -rXq "./$archive" -- "${paths[@]}"

# Only when it was built somewhere else: with the default directory the archive is already there, and moving a
# file onto itself is an error rather than a no-op.
if [ "$(pwd -P)" != "$(cd "$GITHUB_WORKSPACE" && pwd -P)" ]; then
  mv "$archive" "$GITHUB_WORKSPACE/$archive"
fi
echo "archive=$archive" >>"$GITHUB_OUTPUT"
echo "version=$version" >>"$GITHUB_OUTPUT"

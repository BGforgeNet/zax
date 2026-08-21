#!/bin/bash
# Static analysis of the surface eslint cannot see: the shell scripts, the workflows, and the composite action.
#
# CI-only rather than part of `pnpm lint`, because none of these tools is a Node dependency and requiring three
# more binaries on every contributor's PATH costs more than the checks are worth locally. The runner already
# carries shellcheck; the other two are pinned and fetched here.
set -euo pipefail

ACTIONLINT_VERSION=1.7.12
# The digest the release publishes for this exact archive. Checked because the download is the one step here
# that reaches outside the runner, and a tag can be moved.
ACTIONLINT_SHA256=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8
ZIZMOR_VERSION=1.29.0

tools=$(mktemp -d)
trap 'rm -rf "$tools"' EXIT

archive="actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz"
curl -fsSL -o "$tools/$archive" \
  "https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/${archive}"
echo "${ACTIONLINT_SHA256}  $tools/$archive" | sha256sum -c -
tar -xzf "$tools/$archive" -C "$tools" actionlint

pipx install "zizmor==${ZIZMOR_VERSION}"

echo "== shellcheck =="
# Found rather than listed: a script added without a line here would otherwise be the one nothing checks.
# Default severity rather than -S warning: SC2086 - the unquoted expansion these scripts actually contend
# with - is reported at info, so raising the floor would silence the one class worth a per-site decision.
find .github/scripts actions -name '*.sh' -print0 | xargs -0 shellcheck

echo "== actionlint =="
# It shells out to shellcheck for every inline `run:` block, which is what keeps a short one honest.
"$tools/actionlint" -color

echo "== zizmor =="
zizmor --persona=regular .github/workflows actions

#!/bin/bash
# Static analysis of the surface eslint cannot see: the shell scripts, the workflows, and the composite action.
#
# CI-only rather than part of `pnpm lint`, because none of these tools is a Node dependency and requiring three
# more binaries on every contributor's PATH costs more than the checks are worth locally. The runner already
# carries shellcheck; the other two are pinned and fetched here.
set -euo pipefail

ACTIONLINT_VERSION=1.7.12
# The digest each project publishes for the exact file fetched below. Both tools reach outside the runner, so
# both are checked: a tag can be moved, and an index entry can be replaced.
ACTIONLINT_SHA256=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8
ZIZMOR_VERSION=1.29.0
# PyPI addresses a file by its own hash, so this URL changes with every release rather than following the
# version: on a bump, take both from https://pypi.org/pypi/zizmor/<version>/json.
ZIZMOR_WHEEL=zizmor-${ZIZMOR_VERSION}-py3-none-manylinux_2_28_x86_64.whl
ZIZMOR_URL=https://files.pythonhosted.org/packages/b4/f0/dfa67018b76bc4f2f50e265e8cbd1293833d1b1de5f3f02fbbb7487ae9c6/${ZIZMOR_WHEEL}
ZIZMOR_SHA256=587b99c2e1b34575c6c8565c2bfde415ca8bc0310f5589f19bc948c8dea10a20

tools=$(mktemp -d)
trap 'rm -rf "$tools"' EXIT

archive="actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz"
curl -fsSL -o "$tools/$archive" \
  "https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/${archive}"
echo "${ACTIONLINT_SHA256}  $tools/$archive" | sha256sum -c -
# --no-same-owner: the archive carries its builder's uid, and restoring it needs a privilege the runner does
# not have. Only the one binary is wanted; the rest of the archive is a README and a licence.
tar -xzf "$tools/$archive" -C "$tools" --no-same-owner actionlint

# The wheel is fetched and checked before it is installed, rather than `pipx install zizmor==<version>`, which
# resolves and installs in one step with nothing to verify against. zizmor declares no dependencies, so the one
# file is the whole install.
curl -fsSL -o "$tools/$ZIZMOR_WHEEL" "$ZIZMOR_URL"
echo "${ZIZMOR_SHA256}  $tools/$ZIZMOR_WHEEL" | sha256sum -c -
pipx install "$tools/$ZIZMOR_WHEEL"

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

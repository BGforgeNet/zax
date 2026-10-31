#!/bin/bash
# Commits the index the build job wrote into the `index` branch's checkout, and pushes it.
#
# The token reaches git for the push alone, through the environment rather than .git/config or the command line.
# A source file pushed to the branch since the checkout makes the push fail, and the next run builds from it.
set -euo pipefail

cd "$INDEX_DIR"
git add v1/index.json
# The index states when it was built, so every run has a change to commit.
git -c user.name="github-actions[bot]" \
  -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
  commit -q -m "Rebuild the index"

auth=$(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 | tr -d '\n')
echo "::add-mask::$auth"
GIT_CONFIG_COUNT=1 \
  GIT_CONFIG_KEY_0=http.https://github.com/.extraheader \
  GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $auth" \
  git push origin HEAD:index

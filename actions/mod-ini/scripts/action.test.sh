#!/bin/bash
# Runs the committed bundle the way the runner does - inputs as INPUT_* variables, a checkout as the working
# directory - so what is tested is the file callers get, not the sources it was built from.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
readonly ROOT
readonly BUNDLE="${ROOT}/actions/mod-ini/dist/action.mjs"
scratch=$(mktemp -d)
trap 'rm -rf "${scratch}"' EXIT

git init --quiet --bare "${scratch}/remote.git"
git init --quiet --initial-branch=main "${scratch}/mod"
cd "${scratch}/mod"
git remote add origin "${scratch}/remote.git"
printf 'spec: 1\nid: demo\nname: Demo\ngame: fallout2\nsettings:\n  main.on: { kind: bool, label: On, help: Turns it on., default: 1 }\n' >f2mod.yml
mkdir mods
printf '[main]\r\non=1\r\nextra=5\r\n' >mods/demo.ini
git add .
git -c user.name=test -c user.email=test@example.invalid commit --quiet -m init
git push --quiet origin main

run() {
  GITHUB_OUTPUT="${scratch}/output" node "${BUNDLE}"
}

# Soft passes over the undescribed key; hard names it and fails.
INPUT_MATCH=soft run
if INPUT_MATCH=hard run 2>hard.err; then
  echo "hard passed over a key the manifest does not describe." >&2
  exit 1
fi
grep -Fq 'mods/demo.ini [main] extra: in the file, not described by the manifest' hard.err

# Generate refuses anywhere a push cannot land, before writing anything.
for refused in "pull_request branch" "push tag"; do
  read -r event ref <<<"${refused}"
  if GITHUB_EVENT_NAME="${event}" GITHUB_REF_TYPE="${ref}" INPUT_MODE=generate run 2>generate.err; then
    echo "generate ran on a ${event} to a ${ref}." >&2
    exit 1
  fi
  grep -Fq "this run's event is ${event} and its ref a ${ref}" generate.err
done
git diff --quiet

# On a branch push it rewrites the file from the manifest, commits only that, and pushes it.
export GITHUB_EVENT_NAME=push GITHUB_REF_TYPE=branch GITHUB_REF_NAME=main
touch unrelated.txt
git add unrelated.txt
INPUT_MODE=generate run
grep -Fxq 'changed=true' "${scratch}/output"
pushed=$(git --git-dir="${scratch}/remote.git" show main:mods/demo.ini)
[ "${pushed}" = "$(printf '[main]\r\n; Turns it on.\r\non=1\r')" ]
[ "$(git --git-dir="${scratch}/remote.git" log --format=%s -1 main)" = "Regenerate mods/demo.ini from f2mod.yml" ]
# Staged by the caller's job before the action ran, and still only staged.
grep -Fxq unrelated.txt <<<"$(git diff --cached --name-only)"
INPUT_MATCH=hard run

# A second run has nothing to add, and says so rather than pushing an empty commit.
: >"${scratch}/output"
INPUT_MODE=generate run
grep -Fxq 'changed=false' "${scratch}/output"
[ "$(git --git-dir="${scratch}/remote.git" rev-list --count main)" = 2 ]

echo "mod-ini action checks passed."

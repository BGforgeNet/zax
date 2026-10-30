#!/bin/bash
# Starts the packaged application on macOS and gives it long enough to fail. Nothing else runs the macOS
# build at all, so a bundle that cannot start - an executable for the wrong architecture, a library the
# machine does not have, a panic before the window - reaches a release looking exactly like a good one.
#
# It drives nothing: this webview has no WebDriver, so what this establishes is that the program stays up
# and writes no panic. Gatekeeper is not exercised either, since a bundle built here carries no quarantine
# attribute and a downloaded one does.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

# Long enough to cover a cold start and the webview coming up, which is when a missing library shows.
readonly ALIVE_SECONDS=15
readonly LOG_FILE="$HOME/Library/Caches/zax/zax.log"

archives=(release/*.zip)
if [ "${#archives[@]}" -ne 1 ] || [ ! -e "${archives[0]}" ]; then
  echo "Expected one macOS archive in release/, found: ${archives[*]}" >&2
  exit 1
fi

unpacked=$(mktemp -d "${RUNNER_TEMP:-/tmp}/zax-launch.XXXXXX")
# ditto rather than unzip, to match how the archive was written and keep the bundle's attributes.
ditto -x -k "${archives[0]}" "$unpacked"
app="$unpacked/ZAX.app"
executable="$app/Contents/MacOS/$(plutil -extract CFBundleExecutable raw "$app/Contents/Info.plist")"

# A bundle built for the other architecture dies with "Bad CPU type", which reads as a crash rather than
# as a build aimed at a machine nobody ran it on.
built_for=$(lipo -archs "$executable")
machine=$(uname -m)
echo "built for: $built_for, running on $machine"
if ! grep -qw "$machine" <<<"$built_for"; then
  echo "The bundle carries no build for this machine, so what follows would say nothing." >&2
  exit 1
fi

# A log left by an earlier launch would make the panic check below answer about that one instead.
rm -f "$LOG_FILE"

output="$unpacked/launch.log"
"$executable" >"$output" 2>&1 &
program=$!

for second in $(seq "$ALIVE_SECONDS"); do
  sleep 1
  if ! ps -p "$program" >/dev/null; then
    status=0
    wait "$program" || status=$?
    echo "The program exited after ${second}s with status $status. Its output:" >&2
    cat "$output" >&2
    exit 1
  fi
done

kill "$program"
# Terminating it ourselves is the intended end, so its status says nothing about the run.
wait "$program" || true

# The window is gone by now, so a panic reaches nobody but the log: the hook in crates/shell/src/lib.rs
# writes it there, and the file exists at all only if something was worth recording.
if [ -f "$LOG_FILE" ] && grep -q "ERROR panic:" "$LOG_FILE"; then
  echo "The program panicked while it was up:" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi

echo "It stayed up for ${ALIVE_SECONDS}s. Its own output:"
cat "$output"

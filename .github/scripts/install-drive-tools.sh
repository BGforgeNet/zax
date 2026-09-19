#!/bin/bash
# What `pnpm drive` needs beside the release build: tauri-driver, and the native WebDriver it fronts. Linux gets
# WebKitGTK's driver and a virtual display; Windows gets the Edge driver whose version matches the WebView2 runtime
# the application will run in, since the driver refuses a webview of any other version. macOS has no driver.
set -euo pipefail

readonly TAURI_DRIVER_VERSION=2.0.6

case "$RUNNER_OS" in
  Linux)
    # The package index is the one install-linux-deps.sh refreshed earlier in the same job.
    sudo apt-get install -y --no-install-recommends webkit2gtk-driver xvfb
    ;;
  Windows)
    # MSYS would otherwise rewrite `/v` as a path. The key is where an evergreen WebView2 records its version.
    version=$(MSYS_NO_PATHCONV=1 reg query \
      'HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' /v pv |
      tr -d '\r' | awk '$1 == "pv" { print $3 }')
    if [ -z "$version" ]; then
      echo "No WebView2 version is recorded in the registry, so there is no driver version to match." >&2
      exit 1
    fi
    echo "WebView2 $version"
    dir="$(cygpath -u "$RUNNER_TEMP")/edgedriver"
    mkdir -p "$dir"
    curl -fsSL --retry 3 -o "$dir/driver.zip" "https://msedgedriver.microsoft.com/$version/edgedriver_win64.zip"
    7z x -y -bso0 -o"$(cygpath -w "$dir")" "$(cygpath -w "$dir/driver.zip")"
    cygpath -w "$dir" >>"$GITHUB_PATH"
    ;;
  *)
    echo "No WebView driver exists for $RUNNER_OS." >&2
    exit 1
    ;;
esac

cargo install tauri-driver --locked --version "$TAURI_DRIVER_VERSION"

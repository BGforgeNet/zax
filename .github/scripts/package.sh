#!/bin/bash
# Builds the distributables for the platform it runs on into release/, named ZAX-<version>-<os>-<arch>.<ext>.
#
# The names are a contract: ZAX's own update check picks this machine's build out of a release by the
# `-<os>-<arch>.<ext>` ending (crates/core/src/updates.rs), and draft-release.sh counts them by extension.
#
# Every target is portable: there is no installer, because there is nothing to install. ZAX has no file
# associations, no protocol handler and nothing needing administrator rights, and an installer would cost a
# privileged step and a copy the user cannot carry on a stick.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

version=$(node -p 'require("./package.json").version')
arch=$(node -p 'process.arch')
platform=$(node -p 'process.platform')
readonly OUT=release

rm -rf "$OUT"
mkdir -p "$OUT"

case "$platform" in
  linux)
    # An AppImage is a single file the kernel mounts rather than unpacks. The tarball is the bare program for
    # anyone who would rather run the system's own WebKit than the one the image carries.
    pnpm exec tauri build --ci --bundles appimage
    images=(target/release/bundle/appimage/*.AppImage)
    if [ "${#images[@]}" -ne 1 ]; then
      echo "Expected one AppImage, found ${#images[@]}: ${images[*]}" >&2
      exit 1
    fi
    cp "${images[0]}" "$OUT/ZAX-$version-linux-$arch.AppImage"
    staging=$(mktemp -d)
    mkdir "$staging/ZAX-$version"
    cp target/release/zax "$staging/ZAX-$version/zax"
    tar -C "$staging" -czf "$OUT/ZAX-$version-linux-$arch.tar.gz" "ZAX-$version"
    rm -rf "$staging"
    ;;
  win32)
    # The program is one file with the interface inside it and runs where it lies. The zip is the same file for
    # a user who wants a folder to put a portable copy's `data` directory in.
    pnpm exec tauri build --ci --no-bundle
    cp target/release/zax.exe "$OUT/ZAX-$version-win-$arch.exe"
    staging=$(mktemp -d)
    mkdir "$staging/ZAX-$version"
    cp target/release/zax.exe "$staging/ZAX-$version/zax.exe"
    (cd "$staging" && 7z a -tzip -bso0 "ZAX.zip" "ZAX-$version")
    mv "$staging/ZAX.zip" "$OUT/ZAX-$version-win-$arch.zip"
    rm -rf "$staging"
    ;;
  darwin)
    pnpm exec tauri build --ci --bundles app
    # ditto rather than zip: it keeps the bundle's extended attributes and symlinks, which zip drops.
    ditto -c -k --keepParent target/release/bundle/macos/ZAX.app "$OUT/ZAX-$version-mac-$arch.zip"
    ;;
  *)
    echo "No distributable is defined for $platform." >&2
    exit 1
    ;;
esac

ls -l "$OUT"

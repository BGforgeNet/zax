#!/bin/bash
# The Rust dependencies against the RustSec advisory database, as `pnpm audit` checks the interface's.
#
# CI-only rather than part of rust-gate.sh: an advisory published overnight fails this with nothing changed in the
# repository, which the local gate should not, and contributors need no extra binary for it. cargo-deny is pinned
# and fetched here, checked against the digest its release publishes.
set -euo pipefail

CARGO_DENY_VERSION=0.20.2
CARGO_DENY_SHA256=9f12ed4c49936e09b48bf862b595cde2fe64fcbd9d74dfacac6131ca824c8d5f

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

tools=$(mktemp -d)
trap 'rm -rf "$tools"' EXIT

name="cargo-deny-${CARGO_DENY_VERSION}-x86_64-unknown-linux-musl"
curl -fsSL -o "$tools/$name.tar.gz" \
  "https://github.com/EmbarkStudios/cargo-deny/releases/download/${CARGO_DENY_VERSION}/$name.tar.gz"
echo "${CARGO_DENY_SHA256}  $tools/$name.tar.gz" | sha256sum -c -
tar -xzf "$tools/$name.tar.gz" -C "$tools" --no-same-owner "$name/cargo-deny"

"$tools/$name/cargo-deny" --locked check advisories

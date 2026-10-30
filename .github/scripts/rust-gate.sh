#!/bin/bash
# The whole gate for the Rust workspace: formatting, lints, tests, and the bindings the tests write.
#
# One script rather than several workflow steps so the same command runs locally and in CI, and so the
# lint table in Cargo.toml is enforced somewhere rather than only declared. Warnings are errors here:
# several entries in that table are `warn` precisely because they want a human's judgment at the
# writing desk, and a gate that let them through would never get one.
#
# Needs the GTK and WebKit development files on Linux (`install-linux-deps.sh` installs them), and the
# wasm32-unknown-unknown target, which rust-toolchain.toml brings along under rustup.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

echo "==> cargo fmt"
cargo fmt --all --check

echo "==> cargo clippy"
cargo clippy --workspace --all-targets --locked -- -D warnings

# The WebAssembly exports compile only for that target, so the native pass above never reads them.
echo "==> cargo clippy (wasm32)"
cargo clippy --locked --target wasm32-unknown-unknown --package zax-preview --package zax-mod-tools -- -D warnings

echo "==> cargo test"
cargo test --workspace --locked

# ts-rs writes the interface's types while the tests run, so a Rust type changed without its binding committed
# shows up here as a difference - or as a file nobody added.
echo "==> bindings"
git diff --exit-code packages/ui/src/lib/bindings/
untracked=$(git ls-files --others --exclude-standard packages/ui/src/lib/bindings/)
if [ -n "$untracked" ]; then
  echo "Bindings the Rust generates but nobody committed:" >&2
  echo "$untracked" >&2
  exit 1
fi

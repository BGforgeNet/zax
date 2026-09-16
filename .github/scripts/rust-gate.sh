#!/bin/bash
# The whole gate for the Rust workspace: formatting, lints, tests.
#
# One script rather than three workflow steps so the same command runs locally and in CI, and so the
# lint table in Cargo.toml is enforced somewhere rather than only declared. Warnings are errors here:
# several entries in that table are `warn` precisely because they want a human's judgment at the
# writing desk, and a gate that let them through would never get one.
#
# Needs the GTK and WebKit development files on Linux; `docs/building.md` says which packages.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

echo "==> cargo fmt"
cargo fmt --all --check

echo "==> cargo clippy"
cargo clippy --workspace --all-targets --locked -- -D warnings

echo "==> cargo test"
cargo test --workspace --locked

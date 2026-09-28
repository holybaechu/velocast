#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd -- "$REPO_ROOT"

output="$(mktemp -d "/tmp/velocast-webcodecs-regression.XXXXXX")"
output="$(realpath "$output")"
case "$output" in
  "$(realpath "$REPO_ROOT")"/*) echo "temporary output must be outside repository" >&2; exit 1 ;;
  /tmp/velocast-webcodecs-regression.*) ;;
  *) echo "unexpected temporary output path" >&2; exit 1 ;;
esac
trap 'rm -rf -- "$output"' EXIT
export CARGO_TARGET_DIR="$output/cargo"
cargo test -p velocast-protocol
cargo test -p velocast-renderer
cargo build -p velocast-renderer
pnpm --filter ./packages/cli test -- --run
xvfb-run -a node scripts/verify-electron-portable.mjs --renderer "$CARGO_TARGET_DIR/debug/velocast-renderer" --output "$output/results" --repeats 2

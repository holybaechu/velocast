#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd -- "$REPO_ROOT"

cargo test -p velocast-protocol
cargo test -p velocast-renderer
cargo build -p velocast-renderer
pnpm --filter ./packages/cli test -- --run

xvfb-run -a node scripts/verify-electron-portable.mjs --renderer target/debug/velocast-renderer --output renders/electron-portable --repeats 2

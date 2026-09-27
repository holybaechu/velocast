$ErrorActionPreference = "Stop"

cargo test -p velocast-protocol
cargo test -p velocast-renderer
pnpm --filter ./packages/cli test
.\scripts\verify-windows-gpu-pipeline.ps1 -RunSegments

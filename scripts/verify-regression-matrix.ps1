$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$output = Join-Path $env:TEMP ('velocast-webcodecs-regression-' + [guid]::NewGuid().ToString('N'))
$previousCargoTarget = $env:CARGO_TARGET_DIR
try {
    $env:CARGO_TARGET_DIR = Join-Path $output 'cargo'
    cargo test -p velocast-protocol
    cargo test -p velocast-renderer
    cargo build -p velocast-renderer
    pnpm --filter ./packages/cli test
    $renderer = Join-Path $env:CARGO_TARGET_DIR 'debug/velocast-renderer.exe'
    node scripts/verify-electron-portable.mjs --renderer $renderer --output (Join-Path $output 'results') --repeats 2
    if ($LASTEXITCODE -ne 0) { throw 'WebCodecs regression gate failed.' }
} finally {
    $env:CARGO_TARGET_DIR = $previousCargoTarget
    if (([IO.Path]::GetFullPath($output)).StartsWith([IO.Path]::GetFullPath($env:TEMP) + [IO.Path]::DirectorySeparatorChar) -and
        ([IO.Path]::GetFileName($output)).StartsWith('velocast-webcodecs-regression-')) {
        Remove-Item -LiteralPath $output -Recurse -Force -ErrorAction SilentlyContinue
    }
}

#Requires -Version 7.0
[CmdletBinding()]
param(
    [string]$TargetDirectory,
    [switch]$Test
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
    throw 'This helper prepares the Windows x64 build. On macOS/Linux use the standard cargo build.'
}
$repo = Split-Path -Parent $PSScriptRoot
if (-not $TargetDirectory) {
    $TargetDirectory = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $env:TEMP ('velocast-renderer-target-' + [guid]::NewGuid().ToString('N')) }
}
$env:CARGO_TARGET_DIR = [IO.Path]::GetFullPath($TargetDirectory)
Write-Host "Renderer Cargo target directory: $env:CARGO_TARGET_DIR"
Push-Location $repo
try {
    & cargo build -p velocast-renderer --release
    if ($LASTEXITCODE -ne 0) { throw 'Electron renderer release build failed.' }
    if ($Test) {
        & cargo test -p velocast-renderer
        if ($LASTEXITCODE -ne 0) { throw 'Electron renderer tests failed.' }
    }
    & (Join-Path $env:CARGO_TARGET_DIR 'release/velocast-renderer.exe') --capabilities-json
    if ($LASTEXITCODE -ne 0) { throw 'Renderer capability check failed.' }
} finally {
    Pop-Location
}

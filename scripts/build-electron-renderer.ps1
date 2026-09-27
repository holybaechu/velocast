#Requires -Version 7.0
[CmdletBinding()]
param(
    [string]$VcpkgRoot = $env:VCPKG_ROOT,
    [string]$LibClangPath = $env:LIBCLANG_PATH,
    [string]$TargetDirectory,
    [switch]$Test
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
    throw 'This helper prepares the Windows x64 build. On macOS/Linux use the standard cargo build.'
}
$repo = Split-Path -Parent $PSScriptRoot
if (-not $VcpkgRoot) { $VcpkgRoot = Join-Path $repo '.tools/vcpkg' }
if (-not $LibClangPath) { $LibClangPath = Join-Path $env:ProgramFiles 'LLVM/bin' }
if (-not $TargetDirectory) { $TargetDirectory = Join-Path $repo 'target/electron' }
$VcpkgRoot = (Resolve-Path -LiteralPath $VcpkgRoot).Path
$LibClangPath = (Resolve-Path -LiteralPath $LibClangPath).Path
$mediaBin = Join-Path $VcpkgRoot 'installed/x64-windows/bin'
if (-not (Test-Path -LiteralPath $mediaBin -PathType Container)) { throw 'Install the FFmpeg x64-windows vcpkg dependencies first.' }
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or -not $vs) { throw 'Visual Studio C++ build tools are required.' }
& (Join-Path $vs 'Common7/Tools/Launch-VsDevShell.ps1') -Arch amd64 -HostArch amd64 -SkipAutomaticLocation | Out-Null
$env:VCPKG_ROOT = $VcpkgRoot
$env:VCPKG_DEFAULT_TRIPLET = 'x64-windows'
$env:VCPKGRS_DYNAMIC = '1'
$env:LIBCLANG_PATH = $LibClangPath
$env:CARGO_TARGET_DIR = [IO.Path]::GetFullPath($TargetDirectory)
$env:CARGO_BUILD_JOBS = '4'
$env:PATH = "$mediaBin;$LibClangPath;$env:PATH"
Push-Location $repo
try {
    & cargo build -p velocast-renderer --release
    if ($LASTEXITCODE -ne 0) { throw 'Electron-only release build failed.' }
    if ($Test) {
        & cargo test -p velocast-renderer
        if ($LASTEXITCODE -ne 0) { throw 'Electron-only native tests failed.' }
    }
    & (Join-Path $env:CARGO_TARGET_DIR 'release/velocast-renderer.exe') --capabilities-json
    if ($LASTEXITCODE -ne 0) { throw 'Electron-only capability check failed.' }
} finally {
    Pop-Location
}

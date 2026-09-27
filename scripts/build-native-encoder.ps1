#Requires -Version 7.0
[CmdletBinding()]
param(
    [string]$VcpkgRoot = $env:VCPKG_ROOT,
    [string]$LibClangPath = $env:LIBCLANG_PATH,
    [string]$TargetDirectory,
    [string]$OutputDirectory,
    [switch]$Test
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
    throw 'The native encoder requires Windows x64.'
}
$repo = Split-Path -Parent $PSScriptRoot
if (-not $VcpkgRoot) { $VcpkgRoot = Join-Path $repo '.tools/vcpkg' }
if (-not $LibClangPath) { $LibClangPath = Join-Path $env:ProgramFiles 'LLVM/bin' }
if (-not $TargetDirectory -or -not $OutputDirectory) {
    throw 'Supply -TargetDirectory and -OutputDirectory outside the repository for build outputs and the addon package.'
}
$repoFull = [IO.Path]::GetFullPath($repo).TrimEnd('\', '/')
foreach ($destination in @($TargetDirectory, $OutputDirectory)) {
    $absolute = [IO.Path]::GetFullPath($destination)
    if ($absolute -eq $repoFull -or $absolute.StartsWith($repoFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Build and package outputs must be outside the repository.'
    }
}
$VcpkgRoot = (Resolve-Path -LiteralPath $VcpkgRoot).Path
$LibClangPath = (Resolve-Path -LiteralPath $LibClangPath).Path
$mediaBin = Join-Path $VcpkgRoot 'installed/x64-windows/bin'
if (-not (Test-Path -LiteralPath $mediaBin -PathType Container)) { throw 'Install FFmpeg x64-windows vcpkg dependencies first.' }
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
    & cargo build -p velocast-native-encoder --release
    if ($LASTEXITCODE -ne 0) { throw 'Native NV12 addon build failed.' }
    if ($Test) {
        & cargo test -p velocast-native-encoder
        if ($LASTEXITCODE -ne 0) { throw 'Native NV12 addon tests failed.' }
    }
    New-Item -ItemType Directory -Force $OutputDirectory | Out-Null
    $addon = Join-Path ([IO.Path]::GetFullPath($OutputDirectory)) 'velocast-native-encoder.node'
    Copy-Item -LiteralPath (Join-Path $env:CARGO_TARGET_DIR 'release/velocast_native_encoder.dll') -Destination $addon -Force
    # Ship dynamic codec dependencies next to the addon for a normal require().
    Get-ChildItem -LiteralPath $mediaBin -Filter '*.dll' -File | Copy-Item -Destination $OutputDirectory -Force
    Write-Output "Native addon: $addon"
    Write-Output 'Set VELOCAST_NATIVE_ENCODER_ADDON to this absolute .node path.'
} finally {
    Pop-Location
}

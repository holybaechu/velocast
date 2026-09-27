param(
    [string]$VcpkgRoot,
    [string]$VcpkgTriplet = "x64-windows",
    [string]$VcpkgPackage = "ffmpeg[avcodec,avformat,amf,qsv,nvcodec]",
    [switch]$NoBootstrapVcpkg
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "accelerated-rendering-common.ps1")

# The default bootstrap location is .tools\vcpkg when no existing vcpkg root is found.
# The reusable environment file is written to .velocast\accelerated-env.ps1.
$repoRoot = Get-RepoRoot
$environment = Initialize-AcceleratedRenderingEnvironment `
    -RepoRoot $repoRoot `
    -VcpkgRoot $VcpkgRoot `
    -VcpkgTriplet $VcpkgTriplet `
    -VcpkgPackage $VcpkgPackage `
    -NoBootstrapVcpkg:$NoBootstrapVcpkg

$envFile = Write-AcceleratedRenderingEnvFile -RepoRoot $repoRoot -Environment $environment

Write-Host "Accelerated rendering dependencies are ready."
Write-Host "Load this environment in future shells with:"
Write-Host ".\$((Resolve-Path -Relative $envFile))"

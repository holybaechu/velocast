param(
    [switch]$SkipTests,
    [switch]$RunSmoke,
    [switch]$NoBootstrapVcpkg,
    [string]$VcpkgRoot,
    [string]$VcpkgTriplet = "x64-windows",
    [string]$VcpkgPackage = "ffmpeg[avcodec,avformat,amf,qsv,nvcodec]",
    [string]$SmokeEntry = "apps/playground/index.html",
    [string]$SmokeCompositionId = "product-hero",
    [string]$SmokeUrl,
    [string]$SmokeSelector = "#product-hero",
    [string]$SmokeOutput = "renders/d3d11-smoke.mp4"
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "accelerated-rendering-common.ps1")

$repoRoot = Get-RepoRoot
$null = Initialize-AcceleratedRenderingEnvironment `
    -RepoRoot $repoRoot `
    -VcpkgRoot $VcpkgRoot `
    -VcpkgTriplet $VcpkgTriplet `
    -VcpkgPackage $VcpkgPackage `
    -NoBootstrapVcpkg:$NoBootstrapVcpkg

Invoke-Native `
    -FilePath "cargo" `
    -Arguments @("check", "-p", "velocast-renderer") `
    -WorkingDirectory $repoRoot

if (-not $SkipTests) {
    Invoke-Native `
        -FilePath "cargo" `
        -Arguments @("test", "-p", "velocast-renderer", "d3d11", "--", "--nocapture") `
        -WorkingDirectory $repoRoot
}

if ($RunSmoke) {
    $smokeOutputPath = Resolve-SmokeOutputPath -RepoRoot $repoRoot -Output $SmokeOutput
    $report = Join-Path $repoRoot "renders/d3d11-smoke-report.json"
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $report) | Out-Null

    if ([string]::IsNullOrWhiteSpace($SmokeUrl)) {
        $smokeEntryPath = $SmokeEntry
        if (-not [System.IO.Path]::IsPathRooted($smokeEntryPath)) {
            $smokeEntryPath = Join-Path $repoRoot $smokeEntryPath
        }
        $smokeEntryPath = (Resolve-Path -LiteralPath $smokeEntryPath).Path
        $smokeServeUrl = ([System.Uri]$smokeEntryPath).AbsoluteUri
        $smokeMode = "composition"
        $smokeCompositionId = $SmokeCompositionId
        $smokeSelector = $null
    } else {
        $smokeServeUrl = $SmokeUrl
        $smokeMode = "url"
        $smokeCompositionId = $null
        $smokeSelector = $SmokeSelector
    }

    $jobJson = @{
        mode = $smokeMode
        composition_id = $smokeCompositionId
        serve_url = $smokeServeUrl
        selector = $smokeSelector
        output = $smokeOutputPath
        codec = "h264"
        pixel_format = "nv12"
        concurrency = 1
        assembly_mode = "reference"
        report_path = $report
    } | ConvertTo-Json -Compress

    $rendererOutput = Invoke-NativeCapture `
        -FilePath "cargo" `
        -Arguments @(
            "run",
            "-p",
            "velocast-renderer",
            "--",
            "--job-json",
            $jobJson
        ) `
        -WorkingDirectory $repoRoot

    $log = $rendererOutput.Output
    if ($rendererOutput.ExitCode -ne 0) {
        throw "D3D11 smoke render failed with exit code $($rendererOutput.ExitCode):`n$log"
    }

    if ($log -notmatch "using D3D11 FFmpeg hardware encoder") {
        throw "D3D11 smoke render did not use the hardware encoder path:`n$log"
    }

    if (-not (Test-Path -LiteralPath $smokeOutputPath)) {
        throw "D3D11 smoke output was not created: $smokeOutputPath"
    }

    if ((Get-Item -LiteralPath $smokeOutputPath).Length -le 0) {
        throw "D3D11 smoke output is empty: $smokeOutputPath"
    }

    $telemetry = Get-Content -LiteralPath $report -Raw | ConvertFrom-Json
    if ($telemetry.cpu_readback_frames -ne 0) {
        throw "D3D11 smoke used CPU readback frames: $($telemetry.cpu_readback_frames)"
    }
    if ($telemetry.fallback_used) {
        throw "D3D11 smoke fell back: $($telemetry.fallback_reason)"
    }

    if (Get-Command ffprobe -ErrorAction SilentlyContinue) {
        ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height,nb_frames -of default=nw=1 $smokeOutputPath
        if ($LASTEXITCODE -ne 0) {
            throw "ffprobe failed for D3D11 smoke output: $smokeOutputPath"
        }
    } else {
        Write-Warning "ffprobe not found; skipped D3D11 smoke output metadata validation"
    }
}

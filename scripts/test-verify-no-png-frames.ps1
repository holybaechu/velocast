$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "verify-no-png-frames.ps1"
$powershellExe = (Get-Process -Id $PID).Path

function New-TestFile {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$RelativePath
    )

    $path = Join-Path $Root $RelativePath
    $directory = Split-Path -Parent $path
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    New-Item -ItemType File -Force -Path $path | Out-Null
}

function Invoke-NoPngVerifier {
    param([Parameter(Mandatory = $true)][string]$Root)

    $output = & $powershellExe -NoProfile -ExecutionPolicy Bypass -File $scriptPath -Root $Root 2>&1
    [pscustomobject]@{
        ExitCode = $LASTEXITCODE
        Output = ($output | ForEach-Object { $_.ToString() }) -join "`n"
    }
}

function Assert-Passes {
    param(
        [Parameter(Mandatory = $true)]$Result,
        [Parameter(Mandatory = $true)][string]$Context
    )

    if ($Result.ExitCode -ne 0) {
        throw "$Context expected exit 0, got $($Result.ExitCode):`n$($Result.Output)"
    }
}

function Assert-FailsWith {
    param(
        [Parameter(Mandatory = $true)]$Result,
        [Parameter(Mandatory = $true)][string]$Expected,
        [Parameter(Mandatory = $true)][string]$Context
    )

    if ($Result.ExitCode -eq 0) {
        throw "$Context expected non-zero exit, got 0"
    }
    if ($Result.Output -notmatch [regex]::Escape($Expected)) {
        throw "$Context expected output to contain '$Expected':`n$($Result.Output)"
    }
}

$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("velocast-no-png-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $testRoot | Out-Null

try {
    $allowedRoot = Join-Path $testRoot "allowed"
    New-TestFile -Root $allowedRoot -RelativePath "renders\bugfix-css-dupe-frame0.png"
    New-TestFile -Root $allowedRoot -RelativePath "renders\benchmarks\run\inspect\perf-run-1-frames-0-168-176.png"
    New-TestFile -Root $allowedRoot -RelativePath "renders\benchmarks\run\inspect\run1\frame-000.png"
    New-TestFile -Root $allowedRoot -RelativePath "renders\benchmarks\run\semantic-run-1\frame-0172.png"
    New-TestFile -Root $allowedRoot -RelativePath "renders\benchmarks\run\semantic-run-1\montage.png"
    New-TestFile -Root $allowedRoot -RelativePath "node_modules\dependency\out\frame-0001.png"
    New-TestFile -Root $allowedRoot -RelativePath "target\debug\renders\frame-0002.png"

    Assert-Passes `
        -Result (Invoke-NoPngVerifier -Root $allowedRoot) `
        -Context "inspection artifacts"

    $rawFrameRoot = Join-Path $testRoot "raw-frame"
    New-TestFile -Root $rawFrameRoot -RelativePath "renders\frame-0001.png"

    Assert-FailsWith `
        -Result (Invoke-NoPngVerifier -Root $rawFrameRoot) `
        -Expected "PNG render frame found: renders\frame-0001.png" `
        -Context "raw frame sequence"

    $packageFrameRoot = Join-Path $testRoot "package-frame"
    New-TestFile -Root $packageFrameRoot -RelativePath "packages\cli\renders\frame-0002.png"

    Assert-FailsWith `
        -Result (Invoke-NoPngVerifier -Root $packageFrameRoot) `
        -Expected "PNG render frame found: packages\cli\renders\frame-0002.png" `
        -Context "package render frame sequence"

    $workspaceRenderFrameRoot = Join-Path $testRoot "workspace-render-frame"
    New-TestFile -Root $workspaceRenderFrameRoot -RelativePath "apps\playground\renders\frame-0003.png"

    Assert-FailsWith `
        -Result (Invoke-NoPngVerifier -Root $workspaceRenderFrameRoot) `
        -Expected "PNG render frame found: apps\playground\renders\frame-0003.png" `
        -Context "app render frame sequence"

    $crateRenderFrameRoot = Join-Path $testRoot "crate-render-frame"
    New-TestFile -Root $crateRenderFrameRoot -RelativePath "crates\renderer\renders\frame-0004.png"

    Assert-FailsWith `
        -Result (Invoke-NoPngVerifier -Root $crateRenderFrameRoot) `
        -Expected "PNG render frame found: crates\renderer\renders\frame-0004.png" `
        -Context "crate render frame sequence"

    $workspaceOutFrameRoot = Join-Path $testRoot "workspace-out-frame"
    New-TestFile -Root $workspaceOutFrameRoot -RelativePath "apps\playground\out\frame-0005.png"

    Assert-FailsWith `
        -Result (Invoke-NoPngVerifier -Root $workspaceOutFrameRoot) `
        -Expected "PNG render frame found: apps\playground\out\frame-0005.png" `
        -Context "app out frame sequence"

    $workspaceTempFrameRoot = Join-Path $testRoot "workspace-temp-frame"
    New-TestFile -Root $workspaceTempFrameRoot -RelativePath "apps\playground\.velocast\tmp\scratch.png"

    Assert-FailsWith `
        -Result (Invoke-NoPngVerifier -Root $workspaceTempFrameRoot) `
        -Expected "PNG render frame found: apps\playground\.velocast\tmp\scratch.png" `
        -Context "app .velocast temp PNG"

    $tempFrameRoot = Join-Path $testRoot "temp-frame"
    New-TestFile -Root $tempFrameRoot -RelativePath "renders\.velocast\tmp\product-hero-42\scratch.png"

    Assert-FailsWith `
        -Result (Invoke-NoPngVerifier -Root $tempFrameRoot) `
        -Expected "PNG render frame found: renders\.velocast\tmp\product-hero-42\scratch.png" `
        -Context ".velocast temp PNG"

    $rootTempFrameRoot = Join-Path $testRoot "root-temp-frame"
    New-TestFile -Root $rootTempFrameRoot -RelativePath ".velocast\tmp\product-hero-42\scratch.png"

    Assert-FailsWith `
        -Result (Invoke-NoPngVerifier -Root $rootTempFrameRoot) `
        -Expected "PNG render frame found: .velocast\tmp\product-hero-42\scratch.png" `
        -Context "root .velocast temp PNG"

    Write-Host "verify-no-png-frames tests passed."
} finally {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}

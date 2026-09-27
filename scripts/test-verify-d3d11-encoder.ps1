$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "verify-d3d11-encoder.ps1"
$source = Get-Content -LiteralPath $scriptPath -Raw

function Assert-Contains {
    param(
        [Parameter(Mandatory = $true)][string]$Expected,
        [Parameter(Mandatory = $true)][string]$Context
    )

    if (-not $source.Contains($Expected)) {
        throw "$Context expected verify-d3d11-encoder.ps1 to contain: $Expected"
    }
}

function Assert-NotContains {
    param(
        [Parameter(Mandatory = $true)][string]$Unexpected,
        [Parameter(Mandatory = $true)][string]$Context
    )

    if ($source.Contains($Unexpected)) {
        throw "$Context expected verify-d3d11-encoder.ps1 not to contain: $Unexpected"
    }
}

Assert-Contains `
    -Expected '[string]$SmokeEntry = "apps/playground/index.html"' `
    -Context "static smoke entry default"

Assert-Contains `
    -Expected '[string]$SmokeCompositionId = "product-hero"' `
    -Context "composition smoke default"

Assert-Contains `
    -Expected '$smokeServeUrl = ([System.Uri]$smokeEntryPath).AbsoluteUri' `
    -Context "static entry file URL resolution"

Assert-Contains `
    -Expected '$smokeMode = "composition"' `
    -Context "default smoke composition mode"

Assert-Contains `
    -Expected '$smokeMode = "url"' `
    -Context "SmokeUrl override URL mode"

Assert-Contains `
    -Expected 'selector = $smokeSelector' `
    -Context "SmokeUrl selector preservation"

Assert-NotContains `
    -Unexpected '[string]$SmokeUrl = "http://127.0.0.1:4545"' `
    -Context "default smoke URL server requirement"

Write-Host "verify-d3d11-encoder smoke job tests passed."

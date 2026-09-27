param(
    [string]$Root = (Join-Path $PSScriptRoot '..')
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path -LiteralPath $Root).Path
$repoRootPrefix = $repoRoot.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar

function Test-IsRenderArtifactScope {
    param([Parameter(Mandatory = $true)][string[]]$Segments)

    return $Segments -contains 'renders' -or $Segments -contains 'out' -or $Segments -contains '.velocast'
}

function Test-IsBenchmarkInspectionArtifact {
    param([Parameter(Mandatory = $true)][string[]]$Segments)

    if ($Segments -notcontains 'benchmarks') {
        return $false
    }
    if ($Segments -contains 'inspect') {
        return $true
    }

    foreach ($segment in $Segments) {
        if ($segment -like 'semantic-run-*') {
            return $true
        }
    }

    return $false
}

function Test-IsRawFrameFileName {
    param([Parameter(Mandatory = $true)][string]$FileName)

    $baseName = [System.IO.Path]::GetFileNameWithoutExtension($FileName)
    return $baseName -match '^(?:frame[-_]?)?\d{1,8}$'
}

function Test-IsProhibitedPngFrame {
    param([Parameter(Mandatory = $true)]$FileInfo)

    $relativePath = $FileInfo.FullName.Substring($repoRootPrefix.Length)
    $segments = $relativePath -split '[\\/]'
    if (-not (Test-IsRenderArtifactScope -Segments $segments)) {
        return $false
    }
    if (Test-IsBenchmarkInspectionArtifact -Segments $segments) {
        return $false
    }
    if ($segments -contains '.velocast') {
        return $true
    }
    if ($segments -contains 'frames') {
        return $true
    }

    return Test-IsRawFrameFileName -FileName $FileInfo.Name
}

function Get-ExistingPngFrameScanRoots {
    $roots = @(
        (Join-Path $repoRoot 'renders'),
        (Join-Path $repoRoot 'out'),
        (Join-Path $repoRoot '.velocast')
    )

    foreach ($workspaceScope in @('packages', 'apps', 'crates')) {
        $scopeRoot = Join-Path $repoRoot $workspaceScope
        if (Test-Path -LiteralPath $scopeRoot -PathType Container) {
            $roots += Get-ChildItem -LiteralPath $scopeRoot -Directory -ErrorAction SilentlyContinue |
                ForEach-Object {
                    foreach ($artifactRoot in @('renders', 'out', '.velocast')) {
                        Join-Path $_.FullName $artifactRoot
                    }
                }
        }
    }

    $roots | Where-Object { Test-Path -LiteralPath $_ -PathType Container }
}

$violations = Get-ExistingPngFrameScanRoots |
    ForEach-Object {
        Get-ChildItem -LiteralPath $_ -Recurse -File -Filter '*.png' -ErrorAction SilentlyContinue
    } |
    Where-Object { Test-IsProhibitedPngFrame -FileInfo $_ }

if ($violations) {
    $violations | ForEach-Object {
        $relativePath = $_.FullName.Substring($repoRootPrefix.Length)
        Write-Host "PNG render frame found: $relativePath"
    }
    exit 1
}

Write-Host 'No PNG render frames found.'

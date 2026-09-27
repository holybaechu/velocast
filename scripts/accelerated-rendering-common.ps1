function Get-RepoRoot {
    return (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

function Test-VcpkgRoot {
    param([string]$Root)

    if (-not $Root) {
        return $false
    }

    return (Test-Path (Join-Path $Root ".vcpkg-root")) -and (Test-Path (Join-Path $Root "vcpkg.exe"))
}

function Find-VcpkgRoot {
    param(
        [string]$ExplicitRoot,
        [string]$RepoRoot
    )

    $candidates = @(
        $ExplicitRoot,
        $env:VCPKG_ROOT,
        $env:VCPKG_INSTALLATION_ROOT,
        (Join-Path $RepoRoot ".tools\vcpkg"),
        "C:\vcpkg",
        (Join-Path $env:USERPROFILE "vcpkg")
    ) | Where-Object { $_ }

    foreach ($candidate in $candidates) {
        if (Test-VcpkgRoot $candidate) {
            return (Resolve-Path $candidate).Path
        }
    }

    $vcpkgCommand = Get-Command vcpkg -ErrorAction SilentlyContinue
    if ($vcpkgCommand) {
        $commandRoot = Split-Path -Parent $vcpkgCommand.Source
        if (Test-VcpkgRoot $commandRoot) {
            return (Resolve-Path $commandRoot).Path
        }
    }

    return $null
}

function Invoke-Native {
    param(
        [string]$FilePath,
        [string[]]$Arguments,
        [string]$WorkingDirectory = (Get-Location).Path
    )

    $resolvedWorkingDirectory = (Resolve-Path -LiteralPath $WorkingDirectory).Path
    Push-Location -LiteralPath $resolvedWorkingDirectory
    try {
        & $FilePath @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "$FilePath $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
}

function ConvertTo-NativeArgument {
    param([string]$Argument)

    if ($Argument -eq "") {
        return '""'
    }

    if ($Argument -notmatch '[\s"]') {
        return $Argument
    }

    $result = '"'
    $backslashes = 0
    foreach ($character in $Argument.ToCharArray()) {
        if ($character -eq '\') {
            $backslashes += 1
            continue
        }

        if ($character -eq '"') {
            $result += ('\' * (($backslashes * 2) + 1))
            $result += '"'
            $backslashes = 0
            continue
        }

        if ($backslashes -gt 0) {
            $result += ('\' * $backslashes)
            $backslashes = 0
        }
        $result += $character
    }

    if ($backslashes -gt 0) {
        $result += ('\' * ($backslashes * 2))
    }
    $result += '"'
    return $result
}

function Join-NativeArgumentString {
    param([string[]]$Arguments)

    return (($Arguments | ForEach-Object { ConvertTo-NativeArgument $_ }) -join " ")
}

function Invoke-NativeCapture {
    param(
        [string]$FilePath,
        [string[]]$Arguments,
        [string]$WorkingDirectory = (Get-Location).Path
    )

    $resolvedWorkingDirectory = (Resolve-Path -LiteralPath $WorkingDirectory).Path
    $stdoutPath = [System.IO.Path]::GetTempFileName()
    $stderrPath = [System.IO.Path]::GetTempFileName()
    $locationPushed = $false

    try {
        Push-Location -LiteralPath $resolvedWorkingDirectory
        $locationPushed = $true

        $process = Start-Process `
            -FilePath $FilePath `
            -ArgumentList (Join-NativeArgumentString $Arguments) `
            -WorkingDirectory $resolvedWorkingDirectory `
            -NoNewWindow `
            -Wait `
            -PassThru `
            -RedirectStandardOutput $stdoutPath `
            -RedirectStandardError $stderrPath

        $output = @()
        if (Test-Path $stdoutPath) {
            $output += Get-Content $stdoutPath
        }
        if (Test-Path $stderrPath) {
            $output += Get-Content $stderrPath
        }

        return [pscustomobject]@{
            ExitCode = $process.ExitCode
            Output = ($output -join [Environment]::NewLine)
        }
    }
    finally {
        if ($locationPushed) {
            Pop-Location
        }
        Remove-Item -Force -ErrorAction SilentlyContinue $stdoutPath, $stderrPath
    }
}

function Resolve-SmokeOutputPath {
    param(
        [string]$RepoRoot,
        [string]$Output
    )

    if ([System.IO.Path]::IsPathRooted($Output)) {
        return [System.IO.Path]::GetFullPath($Output)
    }

    return [System.IO.Path]::GetFullPath((Join-Path $RepoRoot $Output))
}

function InstallVcpkg {
    param([string]$Root)

    $parent = Split-Path -Parent $Root
    New-Item -ItemType Directory -Force -Path $parent | Out-Null

    if (-not (Test-Path $Root)) {
        Invoke-Native -FilePath "git" -Arguments @("clone", "https://github.com/microsoft/vcpkg", $Root)
    }

    if (-not (Test-Path (Join-Path $Root ".vcpkg-root"))) {
        throw "Downloaded vcpkg tree is missing .vcpkg-root: $Root"
    }

    $vcpkgExe = Join-Path $Root "vcpkg.exe"
    if (-not (Test-Path $vcpkgExe)) {
        Invoke-Native -FilePath (Join-Path $Root "bootstrap-vcpkg.bat") -Arguments @("-disableMetrics") -WorkingDirectory $Root
    }
}

function Test-FfmpegVcpkgPackage {
    param(
        [string]$Root,
        [string]$Triplet
    )

    $installed = Join-Path $Root "installed\$Triplet"
    $hasLibraries = (Test-Path (Join-Path $installed "include\libavcodec\avcodec.h")) -and
        (Test-Path (Join-Path $installed "include\libavformat\avformat.h")) -and
        (Test-Path (Join-Path $installed "include\libavutil\avutil.h")) -and
        (Test-Path (Join-Path $installed "lib\avcodec.lib")) -and
        (Test-Path (Join-Path $installed "lib\avformat.lib")) -and
        (Test-Path (Join-Path $installed "lib\avutil.lib"))
    if (-not $hasLibraries) {
        return $false
    }

    # ffmpeg-sys-next 9 generates bindings for the FFmpeg 9 library ABI.
    foreach ($library in @(
        @{ Name = "avcodec"; Macro = "LIBAVCODEC_VERSION_MAJOR"; Major = 63 },
        @{ Name = "avformat"; Macro = "LIBAVFORMAT_VERSION_MAJOR"; Major = 63 },
        @{ Name = "avutil"; Macro = "LIBAVUTIL_VERSION_MAJOR"; Major = 61 }
    )) {
        $header = Join-Path $installed "include\lib$($library.Name)\version_major.h"
        if (-not (Test-Path -LiteralPath $header)) {
            $header = Join-Path $installed "include\lib$($library.Name)\version.h"
        }
        if (-not (Test-Path -LiteralPath $header)) {
            return $false
        }
        $pattern = "(?m)^\s*#define\s+$($library.Macro)\s+$($library.Major)\s*$"
        if ((Get-Content -Raw -LiteralPath $header) -notmatch $pattern) {
            return $false
        }
    }
    return $true
}

function Install-VcpkgFfmpegPackage {
    param(
        [string]$Root,
        [string]$Package,
        [string]$Triplet
    )

    $vcpkgExe = Join-Path $Root "vcpkg.exe"
    $packageSpec = if ($Package -match ":") { $Package } else { "${Package}:${Triplet}" }

    Write-Host "vcpkg.exe install $packageSpec"
    Invoke-Native -FilePath $vcpkgExe -Arguments @("install", $packageSpec) -WorkingDirectory $Root
}

function Find-LibclangPath {
    param(
        [string]$RepoRoot,
        [string]$ResolvedVcpkgRoot,
        [string]$Triplet
    )

    $candidates = @(
        $env:LIBCLANG_PATH,
        (Join-Path $RepoRoot ".tools\llvm\bin"),
        "C:\Program Files\LLVM\bin",
        "C:\Program Files (x86)\LLVM\bin",
        (Join-Path $ResolvedVcpkgRoot "installed\$Triplet\bin"),
        (Join-Path $ResolvedVcpkgRoot "tools\llvm\bin"),
        "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Tools\Llvm\x64\bin",
        "C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Tools\Llvm\x64\bin"
    ) | Where-Object { $_ }

    foreach ($candidate in $candidates) {
        if ((Test-Path $candidate) -and -not (Test-Path -LiteralPath $candidate -PathType Container)) {
            $candidate = Split-Path -Parent $candidate
        }

        if ($candidate -and (Test-Path (Join-Path $candidate "libclang.dll"))) {
            return (Resolve-Path $candidate).Path
        }
    }

    return $null
}

function Add-AcceleratedRenderingPathEntry {
    param([string]$PathEntry)

    if (-not $PathEntry -or -not (Test-Path $PathEntry)) {
        return
    }

    $resolved = (Resolve-Path $PathEntry).Path
    $parts = @($env:PATH -split ';' | Where-Object { $_ })
    if ($parts -notcontains $resolved) {
        $env:PATH = "$resolved;$env:PATH"
    }
}

function Initialize-AcceleratedRenderingEnvironment {
    param(
        [string]$RepoRoot,
        [string]$VcpkgRoot,
        [string]$VcpkgTriplet = "x64-windows",
        [string]$VcpkgPackage = "ffmpeg[avcodec,avformat,amf,qsv,nvcodec]",
        [switch]$NoBootstrapVcpkg
    )

    if (-not $env:VCPKGRS_DYNAMIC) {
        $env:VCPKGRS_DYNAMIC = "1"
    }

    $resolvedVcpkgRoot = Find-VcpkgRoot $VcpkgRoot $RepoRoot

    if (-not $resolvedVcpkgRoot) {
        if ($NoBootstrapVcpkg) {
            throw "No vcpkg root found. Set VCPKG_ROOT, pass -VcpkgRoot, or rerun without -NoBootstrapVcpkg so the verifier can create .tools\vcpkg."
        }

        $resolvedVcpkgRoot = Join-Path $RepoRoot ".tools\vcpkg"
        InstallVcpkg $resolvedVcpkgRoot
    }

    if (-not (Test-VcpkgRoot $resolvedVcpkgRoot)) {
        if ($NoBootstrapVcpkg) {
            throw "VCPKG_ROOT is not a usable vcpkg tree: $resolvedVcpkgRoot"
        }

        InstallVcpkg $resolvedVcpkgRoot
    }

    $env:VCPKG_ROOT = (Resolve-Path $resolvedVcpkgRoot).Path
    $env:VCPKG_DEFAULT_TRIPLET = $VcpkgTriplet

    if (-not (Test-FfmpegVcpkgPackage $env:VCPKG_ROOT $VcpkgTriplet)) {
        if ($NoBootstrapVcpkg) {
            throw "FFmpeg 9 development libraries are required in $env:VCPKG_ROOT for $VcpkgTriplet. Update the vcpkg ffmpeg port and run vcpkg upgrade ffmpeg --no-dry-run, or rerun without -NoBootstrapVcpkg for a fresh installation of $VcpkgPackage."
        }

        Install-VcpkgFfmpegPackage $env:VCPKG_ROOT $VcpkgPackage $VcpkgTriplet
        if (-not (Test-FfmpegVcpkgPackage $env:VCPKG_ROOT $VcpkgTriplet)) {
            throw "The installed FFmpeg libraries do not match the required FFmpeg 9 ABI. Update the vcpkg ffmpeg port and run vcpkg upgrade ffmpeg --no-dry-run in $env:VCPKG_ROOT."
        }
    }

    $pathAdditions = @()
    $vcpkgBin = Join-Path $env:VCPKG_ROOT "installed\$VcpkgTriplet\bin"
    if (Test-Path $vcpkgBin) {
        $vcpkgBin = (Resolve-Path $vcpkgBin).Path
        Add-AcceleratedRenderingPathEntry $vcpkgBin
        $pathAdditions += $vcpkgBin
    }

    $libclangPath = Find-LibclangPath $RepoRoot $env:VCPKG_ROOT $VcpkgTriplet
    if (-not $libclangPath) {
        throw "libclang.dll is required by bindgen for ffmpeg-sys-next. Install LLVM, or set LIBCLANG_PATH to a directory containing libclang.dll."
    }

    $env:LIBCLANG_PATH = $libclangPath
    Add-AcceleratedRenderingPathEntry $libclangPath
    $pathAdditions += $libclangPath

    return [pscustomobject]@{
        VcpkgRoot = $env:VCPKG_ROOT
        VcpkgTriplet = $VcpkgTriplet
        VcpkgPackage = $VcpkgPackage
        VcpkgBin = $vcpkgBin
        LibclangPath = $libclangPath
        VcpkgrsDynamic = $env:VCPKGRS_DYNAMIC
        PathAdditions = @($pathAdditions | Select-Object -Unique)
    }
}

function ConvertTo-PowerShellSingleQuotedString {
    param([string]$Value)

    return "'$($Value -replace "'", "''")'"
}

function Write-AcceleratedRenderingEnvFile {
    param(
        [string]$RepoRoot,
        [Parameter(Mandatory = $true)]$Environment
    )

    $velocastDir = Join-Path $RepoRoot ".velocast"
    New-Item -ItemType Directory -Force -Path $velocastDir | Out-Null

    $envFile = Join-Path $velocastDir "accelerated-env.ps1"
    $lines = @(
        '$ErrorActionPreference = "Stop"',
        ('$env:VCPKG_ROOT = ' + (ConvertTo-PowerShellSingleQuotedString $Environment.VcpkgRoot)),
        ('$env:VCPKG_DEFAULT_TRIPLET = ' + (ConvertTo-PowerShellSingleQuotedString $Environment.VcpkgTriplet)),
        ('$env:VCPKGRS_DYNAMIC = ' + (ConvertTo-PowerShellSingleQuotedString $Environment.VcpkgrsDynamic)),
        ('$env:LIBCLANG_PATH = ' + (ConvertTo-PowerShellSingleQuotedString $Environment.LibclangPath)),
        '$pathAdditions = @('
    )

    foreach ($pathEntry in @($Environment.PathAdditions | Where-Object { $_ })) {
        $lines += '    ' + (ConvertTo-PowerShellSingleQuotedString $pathEntry)
    }

    $lines += @(
        ')',
        'foreach ($pathEntry in $pathAdditions) {',
        '    if ($pathEntry -and (Test-Path $pathEntry) -and (($env:PATH -split '';'') -notcontains $pathEntry)) {',
        '        $env:PATH = "$pathEntry;$env:PATH"',
        '    }',
        '}'
    )

    Set-Content -Path $envFile -Value $lines -Encoding utf8
    return $envFile
}

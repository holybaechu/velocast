param(
    [string]$Output = "renders/product-hero-windows-gpu.mp4",
    [string]$SegmentOutput = "renders/product-hero-windows-gpu-segments.mp4",
    [string]$Codec = "h264",
    [switch]$RunSegments,
    [string[]]$ExpectedDifferentFrames = @(),
    [ValidateSet("debug", "release")][string]$BuildProfile = "release",
    [switch]$NoBootstrapVcpkg,
    [string]$VcpkgRoot,
    [string]$VcpkgTriplet = "x64-windows",
    [string]$VcpkgPackage = "ffmpeg[avcodec,avformat,amf,qsv,nvcodec]",
    [string]$CargoTargetDir = "C:\vc-target"
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "accelerated-rendering-common.ps1")

$repoRoot = Get-RepoRoot
$env:CARGO_TARGET_DIR = $CargoTargetDir
if (-not $env:CARGO_BUILD_JOBS) {
    $env:CARGO_BUILD_JOBS = "1"
}

$null = Initialize-AcceleratedRenderingEnvironment `
    -RepoRoot $repoRoot `
    -VcpkgRoot $VcpkgRoot `
    -VcpkgTriplet $VcpkgTriplet `
    -VcpkgPackage $VcpkgPackage `
    -NoBootstrapVcpkg:$NoBootstrapVcpkg

$rendersDir = Join-Path $repoRoot "renders"
New-Item -ItemType Directory -Force -Path $rendersDir | Out-Null

$report = Join-Path $rendersDir "windows-gpu-report.json"
$segmentReport = Join-Path $rendersDir "windows-gpu-segments-report.json"
$rendererBinary = Join-Path $env:CARGO_TARGET_DIR "$BuildProfile\velocast-renderer.exe"

function Assert-OptionalTelemetryValue {
    param(
        [Parameter(Mandatory = $true)]$Telemetry,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][object]$Expected,
        [Parameter(Mandatory = $true)][string]$Context
    )

    $property = $Telemetry.PSObject.Properties[$Name]
    if (-not $property -or $null -eq $property.Value) {
        return
    }
    if ($property.Value -ne $Expected) {
        throw "$Context telemetry field $Name mismatch: expected $Expected, got $($property.Value)"
    }
}

function Assert-WindowsHardwareEncoderBackend {
    param(
        [Parameter(Mandatory = $true)][string]$EncoderBackend,
        [Parameter(Mandatory = $true)][string]$Context
    )

    $supported = @(
        "h264_amf", "h264_nvenc", "h264_qsv", "h264_mf",
        "hevc_amf", "hevc_nvenc", "hevc_qsv", "hevc_mf",
        "av1_amf", "av1_nvenc", "av1_qsv", "av1_mf"
    )
    if ($supported -notcontains $EncoderBackend) {
        throw "$Context telemetry field encoder_backend mismatch: expected one of $($supported -join ', '), got $EncoderBackend"
    }
}

function Assert-OptionalRequiredGpuTelemetry {
    param(
        [Parameter(Mandatory = $true)]$Telemetry,
        [Parameter(Mandatory = $true)][string]$Context
    )

    Assert-OptionalTelemetryValue -Telemetry $Telemetry -Name "capture_backend" -Expected "electron_d3d11_shared_texture" -Context $Context
    $conversionProperty = $Telemetry.PSObject.Properties["conversion_backend"]
    if ($conversionProperty -and $null -ne $conversionProperty.Value) {
        if (@("d3d11_video_processor", "d3d11_shader_nv12") -notcontains $conversionProperty.Value) {
            throw "$Context telemetry field conversion_backend is not a supported GPU converter: $($conversionProperty.Value)"
        }
    }
    $encoderProperty = $Telemetry.PSObject.Properties["encoder_backend"]
    if ($encoderProperty -and $null -ne $encoderProperty.Value) {
        Assert-WindowsHardwareEncoderBackend -EncoderBackend $encoderProperty.Value -Context $Context
        if ($conversionProperty -and $conversionProperty.Value -eq "d3d11_shader_nv12" -and -not $encoderProperty.Value.StartsWith("h264_")) {
            throw "$Context shader conversion is validated for H264 hardware encoders only"
        }
    }
    Assert-OptionalTelemetryValue -Telemetry $Telemetry -Name "surface_format_encoder" -Expected "nv12" -Context $Context
}

function Assert-ReferenceGpuTelemetryReport {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [switch]$CheckFrameCounts
    )

    $telemetry = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    Assert-OptionalRequiredGpuTelemetry -Telemetry $telemetry -Context "Reference GPU path"
    if ($telemetry.cpu_readback_frames -ne 0) {
        throw "Reference GPU path used CPU readback frames: $($telemetry.cpu_readback_frames)"
    }
    if ($telemetry.fallback_used) {
        throw "Reference GPU path fell back: $($telemetry.fallback_reason)"
    }
    if ($CheckFrameCounts) {
        if ($telemetry.frames_rendered -ne $telemetry.frames_expected) {
            throw "Reference rendered frame count mismatch: $($telemetry.frames_rendered) / $($telemetry.frames_expected)"
        }
        if ($telemetry.frames_encoded -ne $telemetry.frames_expected) {
            throw "Reference encoded frame count mismatch: $($telemetry.frames_encoded) / $($telemetry.frames_expected)"
        }
    }

    return $telemetry
}

function Assert-SegmentCoordinatorReport {
    param([Parameter(Mandatory = $true)][string]$Path)

    $telemetry = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    if ($telemetry.mode -ne "parallel_segments") {
        throw "Segment report mode mismatch: $($telemetry.mode)"
    }
    Assert-OptionalRequiredGpuTelemetry -Telemetry $telemetry -Context "Segment GPU path"
    Assert-OptionalTelemetryValue -Telemetry $telemetry -Name "worker_backend_compatibility" -Expected "compatible" -Context "Segment GPU path"
    if ($telemetry.cpu_readback_frames -ne 0) {
        throw "Segment GPU path used CPU readback frames: $($telemetry.cpu_readback_frames)"
    }
    if ($telemetry.fallback_used) {
        throw "Segment GPU path fell back: $($telemetry.fallback_reason)"
    }
    if ($telemetry.frames_expected) {
        if ($telemetry.frames_rendered -ne $telemetry.frames_expected) {
            throw "Segment rendered frame count mismatch: $($telemetry.frames_rendered) / $($telemetry.frames_expected)"
        }
        if ($telemetry.frames_encoded -ne $telemetry.frames_expected) {
            throw "Segment encoded frame count mismatch: $($telemetry.frames_encoded) / $($telemetry.frames_expected)"
        }
    }

    return $telemetry
}

function Resolve-MediaToolAvailability {
    [pscustomobject]@{
        Ffprobe = $null -ne (Get-Command ffprobe -ErrorAction SilentlyContinue)
        Ffmpeg = $null -ne (Get-Command ffmpeg -ErrorAction SilentlyContinue)
    }
}

function Assert-MediaToolsAvailable {
    param([Parameter(Mandatory = $true)]$MediaTools)

    if (-not $MediaTools.Ffprobe) {
        throw "ffprobe is required for Windows GPU output metadata validation"
    }
    if (-not $MediaTools.Ffmpeg) {
        throw "ffmpeg is required for Windows GPU decoded frame hash validation"
    }
}

function Invoke-Ffprobe {
    param([Parameter(Mandatory = $true)][string]$Path)

    Invoke-Native `
        -FilePath "ffprobe" `
        -Arguments @(
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_name,width,height,avg_frame_rate,duration,bit_rate,nb_frames,pix_fmt,color_range,color_space,color_transfer,color_primaries",
            "-of",
            "default=nw=1",
            $Path
        ) `
        -WorkingDirectory $repoRoot
}

function Invoke-FfmpegFrameMd5 {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][scriptblock]$OnFrameLine,
        [object]$Context
    )

    $arguments = @(
        "-v",
        "error",
        "-i",
        $Path,
        "-map",
        "0:v:0",
        "-f",
        "framemd5",
        "-"
    )
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo.FileName = "ffmpeg"
    $process.StartInfo.Arguments = Join-NativeArgumentString $arguments
    $process.StartInfo.WorkingDirectory = $repoRoot
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.RedirectStandardOutput = $true
    $process.StartInfo.RedirectStandardError = $true
    $process.StartInfo.CreateNoWindow = $true

    $started = $false
    $exitCode = $null
    $stderrTask = $null
    $stderr = ""

    try {
        if (-not $process.Start()) {
            throw "failed to start ffmpeg framemd5 for $Path"
        }
        $started = $true
        $stderrTask = $process.StandardError.ReadToEndAsync()

        while ($null -ne ($line = $process.StandardOutput.ReadLine())) {
            & $OnFrameLine $line $Context
        }

        $process.WaitForExit()
        $exitCode = $process.ExitCode
        if ($null -ne $stderrTask) {
            $stderr = $stderrTask.GetAwaiter().GetResult()
        }
    } catch {
        if ($started -and -not $process.HasExited) {
            $process.Kill()
            $process.WaitForExit()
        }
        throw
    } finally {
        $process.Dispose()
    }

    if ($exitCode -ne 0) {
        $detail = $stderr.Trim()
        if (-not $detail) {
            $detail = "no stderr output"
        }
        throw "ffmpeg framemd5 failed for $Path with code ${exitCode}: $detail"
    }
}

. (Join-Path $PSScriptRoot "windows-frame-validation.ps1")

$mediaTools = Resolve-MediaToolAvailability
Assert-MediaToolsAvailable -MediaTools $mediaTools

Invoke-Native `
    -FilePath "cargo" `
    -Arguments @("test", "-p", "velocast-renderer") `
    -WorkingDirectory $repoRoot

Invoke-Native `
    -FilePath "cargo" `
    -Arguments (@("build", "-p", "velocast-renderer") + $(if ($BuildProfile -eq "release") { @("--release") } else { @() })) `
    -WorkingDirectory $repoRoot

if (-not (Test-Path -LiteralPath $rendererBinary)) {
    throw "Feature-enabled renderer binary was not created: $rendererBinary"
}

$env:VELOCAST_RENDERER_BINARY = $rendererBinary

Invoke-Native `
    -FilePath "pnpm" `
    -Arguments @(
        "velocast",
        "render",
        "product-hero",
        "--config",
        "apps/playground/velocast.config.ts",
        "--output",
        $Output,
        "--acceleration",
        "required",
        "--concurrency",
        "1",
        "--codec",
        $Codec,
        "--pixel-format",
        "nv12",
        "--assembly",
        "reference",
        "--report",
        $report
    ) `
    -WorkingDirectory $repoRoot

$referenceTelemetry = Assert-ReferenceGpuTelemetryReport -Path $report -CheckFrameCounts
Invoke-Ffprobe -Path $Output
Assert-DecodedFrames -Path $Output -ExpectedFrameCount $referenceTelemetry.frames_expected -ExpectedDifferentFrames $ExpectedDifferentFrames

if ($RunSegments) {
    Invoke-Native `
        -FilePath "pnpm" `
        -Arguments @(
            "velocast",
            "render",
            "product-hero",
            "--config",
            "apps/playground/velocast.config.ts",
            "--output",
            $SegmentOutput,
            "--acceleration",
            "required",
            "--concurrency",
            "2",
            "--codec",
            $Codec,
            "--pixel-format",
            "nv12",
            "--assembly",
            "segments",
            "--verify-segments",
            "--report",
            $segmentReport
        ) `
        -WorkingDirectory $repoRoot
    $segmentTelemetry = Assert-SegmentCoordinatorReport -Path $segmentReport
    Invoke-Ffprobe -Path $SegmentOutput
    Assert-DecodedFrames -Path $SegmentOutput -ExpectedFrameCount $segmentTelemetry.frames_expected -ExpectedDifferentFrames $ExpectedDifferentFrames
}

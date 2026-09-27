$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-frame-validation.ps1')

function Invoke-FfmpegFrameMd5 {
    param($Path, $Context, $OnFrameLine)
    foreach ($line in $script:Lines) { & $OnFrameLine $line $Context }
}
function Assert-Failure {
    param([scriptblock]$Action, [string]$Message)
    try { & $Action } catch {
        if ($_.Exception.Message -like "*$Message*") { return }
        throw
    }
    throw "Expected failure: $Message"
}

$script:Lines = @('#format: frame checksums', '0, 0, 0, 1, 24, same', '0, 1, 1, 1, 24, same')
Assert-DecodedFrames -Path static.mp4 -ExpectedFrameCount 2
Assert-Failure { Assert-DecodedFrames -Path truncated.mp4 -ExpectedFrameCount 3 } 'decoded frame count mismatch'
Assert-Failure { Assert-DecodedFrames -Path stale.mp4 -ExpectedFrameCount 2 -ExpectedDifferentFrames '0:1' } 'fixture motion mismatch'
$script:Lines += '0, 2, 2, 1, 24, different'
Assert-DecodedFrames -Path moving-and-static.mp4 -ExpectedFrameCount 3 -ExpectedDifferentFrames '0:2'
Assert-Failure { Assert-DecodedFrames -Path missing.mp4 -ExpectedDifferentFrames '0:3' } 'missing expected decoded frame 3'
Assert-Failure { Assert-DecodedFrames -Path invalid.mp4 -ExpectedDifferentFrames '0-1' } 'invalid expected-different frame pair'
$script:Lines = @('malformed')
Assert-Failure { Assert-DecodedFrames -Path invalid.mp4 } 'invalid framemd5 frame line'
$script:Lines = @('# empty')
Assert-Failure { Assert-DecodedFrames -Path empty.mp4 } 'no decoded frames'
Write-Output 'WINDOWS_FRAME_VALIDATION: 8 checks passed (static accepted; oracle-detected stale rejected)'

# Decoding/count checks are content-independent. Motion checks require a fixture
# oracle: equal pixels alone never establish that a capture is stale.
function Assert-ExpectedFrameDifferences {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][hashtable]$FrameHashes,
        [string[]]$ExpectedDifferentFrames = @()
    )

    foreach ($pair in $ExpectedDifferentFrames) {
        if ($pair -notmatch '^(\d+):(\d+)$') {
            throw "invalid expected-different frame pair: $pair (expected FIRST:SECOND)"
        }
        $first = [int]$Matches[1]
        $second = [int]$Matches[2]
        foreach ($frame in @($first, $second)) {
            if (-not $FrameHashes.ContainsKey($frame)) {
                throw "missing expected decoded frame $frame in $Path"
            }
        }
        if ($FrameHashes[$first] -eq $FrameHashes[$second]) {
            throw "fixture motion mismatch: frames $first and $second must differ in $Path"
        }
    }
}

function Assert-DecodedFrames {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [int]$ExpectedFrameCount = 0,
        [string[]]$ExpectedDifferentFrames = @()
    )

    $watched = @{}
    foreach ($pair in $ExpectedDifferentFrames) {
        if ($pair -notmatch '^(\d+):(\d+)$') {
            throw "invalid expected-different frame pair: $pair (expected FIRST:SECOND)"
        }
        $watched[[int]$Matches[1]] = $true
        $watched[[int]$Matches[2]] = $true
    }
    $state = @{ Path = $Path; FrameIndex = 0; FrameHashes = @{}; Watched = $watched }
    Invoke-FfmpegFrameMd5 -Path $Path -Context $state -OnFrameLine {
        param([string]$line, [hashtable]$state)
        if (-not $line -or $line.Trim().StartsWith('#')) { return }
        if ($line -notmatch ',\s*([^,\s]+)\s*$') {
            throw "invalid framemd5 frame line: $line"
        }
        $frame = [int]$state.FrameIndex
        if ($state.Watched.ContainsKey($frame)) { $state.FrameHashes[$frame] = $Matches[1] }
        $state.FrameIndex = $frame + 1
    }
    if ($state.FrameIndex -eq 0) { throw "no decoded frames in $Path" }
    if ($ExpectedFrameCount -gt 0 -and $state.FrameIndex -ne $ExpectedFrameCount) {
        throw "decoded frame count mismatch for ${Path}: decoded=$($state.FrameIndex) expected=$ExpectedFrameCount"
    }
    Assert-ExpectedFrameDifferences -Path $Path -FrameHashes $state.FrameHashes -ExpectedDifferentFrames $ExpectedDifferentFrames
}

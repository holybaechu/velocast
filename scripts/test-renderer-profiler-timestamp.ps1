#Requires -Version 7.0
[CmdletBinding()]
param([string]$EnergyInstance = 'RAPL_Package0_PKG')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not ('Velocast.Profiling.PackageEnergy' -as [type])) {
    Add-Type -Path (Join-Path $PSScriptRoot 'renderer-resource-profiler.cs')
}
# One read only: no workload is launched and no measured energy window is created.
$meter = [Velocast.Profiling.PackageEnergy]::new($EnergyInstance)
try {
    $before = [DateTime]::UtcNow
    $reading = $meter.Read()
    $after = [DateTime]::UtcNow
    if ($reading.CounterTimestampUtc.Kind -ne [DateTimeKind]::Utc -or
        $reading.CounterTimestampUtc -lt $before.AddSeconds(-1) -or
        $reading.CounterTimestampUtc -gt $after.AddSeconds(1)) {
        throw "PDH UTC timestamp $($reading.CounterTimestampUtc.ToString('o')) lies outside read boundaries $($before.ToString('o')) to $($after.ToString('o'))."
    }
    Write-Output "PDH timestamp check passed: UTC $($reading.CounterTimestampUtc.ToString('o')), local FILETIME $($reading.CounterTimestampLocalFileTime), skew $([Math]::Round(($reading.CounterTimestampUtc - $after).TotalMilliseconds, 3)) ms."
} finally { $meter.Dispose() }

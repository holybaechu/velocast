#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$CommandFile,
    [Parameter(Mandatory)][string]$OutputPath,
    [ValidateRange(20, 10000)][int]$SampleIntervalMs = 100,
    [ValidateRange(1, 120)][double]$IdleBaselineSeconds = 3,
    [ValidateRange(1, 86400)][double]$TimeoutSeconds = 600,
    [string]$EnergyInstance = 'RAPL_Package0_PKG'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'This profiler requires Windows and PowerShell 7.' }
$command = Get-Content -LiteralPath $CommandFile -Raw | ConvertFrom-Json -AsHashtable
if (-not $command.executable) { throw 'Command JSON requires executable.' }
if (-not $command.workingDirectory) { throw 'Command JSON requires workingDirectory.' }
$arguments = [string[]]@($command.arguments)
$environment = [System.Collections.Generic.Dictionary[string,string]]::new()
if ($command.environment) {
    foreach ($key in $command.environment.Keys) { $environment.Add($key, [string]$command.environment[$key]) }
}
$outputFullPath = [IO.Path]::GetFullPath($OutputPath)
$null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($outputFullPath))
$stdoutPath = [IO.Path]::ChangeExtension($outputFullPath, '.stdout.log')
$stderrPath = [IO.Path]::ChangeExtension($outputFullPath, '.stderr.log')
if (-not ('Velocast.Profiling.Runner' -as [type])) {
    Add-Type -Path (Join-Path $PSScriptRoot 'renderer-resource-profiler.cs')
}
[Velocast.Profiling.Runner]::Warmup()
$energyPaths = @(
    "\Energy Meter($EnergyInstance)\Energy",
    "\Energy Meter($EnergyInstance)\Time",
    "\Energy Meter($EnergyInstance)\Power"
)
$powerErrors = [System.Collections.Generic.List[string]]::new()
$packageMeter = $null
try { $packageMeter = [Velocast.Profiling.PackageEnergy]::new($EnergyInstance) }
catch { $powerErrors.Add($_.Exception.Message) }
function Read-PackageEnergy {
    $before = [DateTime]::UtcNow
    if ($null -eq $packageMeter) { return $null }
    try {
        $counter = $packageMeter.Read()
        [pscustomobject]@{
            ReadStartedUtc = $before.ToString('o')
            ReadFinishedUtc = [DateTime]::UtcNow.ToString('o')
            CounterTimestampUtc = $counter.CounterTimestampUtc.ToString('o')
            CounterTimestampLocalFileTime = $counter.CounterTimestampLocalFileTime
            EnergyPicoWattHours = [decimal]$counter.EnergyPicoWattHours
            MeterTimeMilliseconds = [decimal]$counter.MeterTimeMilliseconds
            CookedPowerMilliWatts = $counter.CookedPowerMilliWatts
        }
    } catch {
        $powerErrors.Add($_.Exception.Message)
        return $null
    }
}
function Summarize-EnergyWindow($Samples) {
    if ($Samples.Count -lt 2) { return [pscustomobject]@{ Available = $false; Reason = 'Fewer than two valid boundary samples.' } }
    for ($i = 1; $i -lt $Samples.Count; $i++) {
        if ($Samples[$i].MeterTimeMilliseconds -lt $Samples[$i - 1].MeterTimeMilliseconds -or
            $Samples[$i].EnergyPicoWattHours -lt $Samples[$i - 1].EnergyPicoWattHours) {
            return [pscustomobject]@{ Available = $false; Reason = 'Energy meter reset or wrapped during the window.' }
        }
    }
    $first = $Samples[0]
    $last = $Samples[$Samples.Count - 1]
    $deltaTime = [double]($last.MeterTimeMilliseconds - $first.MeterTimeMilliseconds)
    $deltaEnergy = [double]($last.EnergyPicoWattHours - $first.EnergyPicoWattHours)
    if ($deltaTime -le 0 -or $deltaEnergy -le 0) {
        return [pscustomobject]@{ Available = $false; Reason = 'Energy counter did not advance monotonically; zero/stale/reset counters are unusable.' }
    }
    $joules = $deltaEnergy * 3.6e-9
    [pscustomobject]@{
        Available = $true
        Joules = $joules
        AverageWatts = $joules / ($deltaTime / 1000)
        MeterCoverageSeconds = $deltaTime / 1000
        BoundaryReadCoverageSeconds = ([DateTime]$last.ReadFinishedUtc - [DateTime]$first.ReadFinishedUtc).TotalSeconds
        FirstBoundaryUtc = $first.ReadFinishedUtc
        LastBoundaryUtc = $last.ReadFinishedUtc
        Samples = $Samples.Count
    }
}

# Compilation, counter setup, output directory creation and sampler warmup precede baseline.
$null = Read-PackageEnergy
$baselineSamples = [System.Collections.Generic.List[object]]::new()
$renderSamples = [System.Collections.Generic.List[object]]::new()
$baselineClock = [Diagnostics.Stopwatch]::StartNew()
$sample = Read-PackageEnergy
if ($null -ne $sample) { $baselineSamples.Add($sample) }
while ($baselineClock.Elapsed.TotalSeconds -lt $IdleBaselineSeconds) {
    $remainingMs = [Math]::Min(1000, ($IdleBaselineSeconds - $baselineClock.Elapsed.TotalSeconds) * 1000)
    if ($remainingMs -gt 0) { Start-Sleep -Milliseconds ([int][Math]::Ceiling($remainingMs)) }
    $sample = Read-PackageEnergy
    if ($null -ne $sample) { $baselineSamples.Add($sample) }
}
# Reuse the final idle boundary as the launch boundary; no extra polling burst.
if ($baselineSamples.Count -gt 0) { $renderSamples.Add($baselineSamples[$baselineSamples.Count - 1]) }
$runner = [Velocast.Profiling.Runner]::new()
$run = $null
$started = $false
try {
    $runner.Start([string]$command.executable, $arguments, [string]$command.workingDirectory,
        $environment, $stdoutPath, $stderrPath, $SampleIntervalMs, $TimeoutSeconds)
    $started = $true
    $powerClock = [Diagnostics.Stopwatch]::StartNew()
    $nextPowerMs = 1000.0
    while (-not $runner.IsCompleted) {
        if ($powerClock.Elapsed.TotalMilliseconds -ge $nextPowerMs) {
            $sample = Read-PackageEnergy
            if ($null -ne $sample) { $renderSamples.Add($sample) }
            $nextPowerMs = $powerClock.Elapsed.TotalMilliseconds + 1000
        }
        Start-Sleep -Milliseconds 25
    }
    $sample = Read-PackageEnergy
    if ($null -ne $sample) { $renderSamples.Add($sample) }
    $run = $runner.Finish()
} finally {
    if ($started -and -not $runner.IsCompleted) { $runner.Cancel(); $run = $runner.Finish() }
    if ($null -ne $packageMeter) { $packageMeter.Dispose() }
}
$baseline = Summarize-EnergyWindow $baselineSamples
$renderEnergy = Summarize-EnergyWindow $renderSamples
$incremental = $null
if ($baseline.Available -and $renderEnergy.Available) {
    $incremental = [pscustomobject]@{
        Joules = $renderEnergy.Joules - $baseline.AverageWatts * $renderEnergy.MeterCoverageSeconds
        AverageWatts = $renderEnergy.AverageWatts - $baseline.AverageWatts
        Interpretation = 'Estimate above preceding idle package power; includes profiler and unrelated activity, may be negative, not application-attributed energy.'
    }
}
$report = [ordered]@{
    SchemaVersion = 1
    Platform = [Runtime.InteropServices.RuntimeInformation]::OSDescription
    Command = [ordered]@{
        Executable = $command.executable
        Arguments = $arguments
        WorkingDirectory = $command.workingDirectory
        EnvironmentOverrideNames = @($environment.Keys) # Do not serialize possible secret values.
    }
    StdoutPath = $stdoutPath
    StderrPath = $stderrPath
    ProcessTree = $run
    ProcessorPackageEnergy = [ordered]@{
        Instance = $EnergyInstance
        CounterPaths = $energyPaths
        Units = 'Energy raw pWh; Time raw ms; Power cooked mW; joules = delta pWh * 3.6e-9.'
        IdleBaseline = $baseline
        RenderWindow = $renderEnergy
        BaselineSubtractedEstimate = $incremental
        IdleSamples = @($baselineSamples.ToArray())
        RenderSamples = @($renderSamples.ToArray())
        ReadErrors = @($powerErrors.ToArray())
    }
    Caveats = @(
        'Memory is sampled simultaneous sums over observed live descendants; the profiler process itself is excluded.'
        'PrivateResidentBytes is private resident RAM from PROCESS_MEMORY_COUNTERS_EX2.PrivateWorkingSetSize. Null means unavailable/incomplete; committed memory is never substituted.'
        'PrivateCommittedBytes is private commit, which can include nonresident pages; it is not resident RAM.'
        'WorkingSetBytes sums resident working sets and can double-count shared pages across processes.'
        'Sampled tree peaks are maxima of simultaneous totals, not sums of per-process historical peaks.'
        'Process snapshots can miss children that start and exit between samples, or descendants whose entire ancestry exits before observation. Unreadable processes make coverage incomplete.'
        'ExitedBeforeObservation counts snapshot PIDs whose OpenProcess failed with process-not-found errors (87/1168). These transient exits remain sampling blind spots but do not indicate unreadable live processes; ProcessReadFailures preserves each PID, operation, error and classification. Other open/read failures retain incomplete coverage.'
        'Processor-package energy includes all package activity, other programs and profiler overhead. It is neither application-specific nor whole-system/wall-socket energy.'
        'Energy-meter update cadence can differ from read cadence. Reported meter coverage and boundary timestamps describe the measured energy window, which slightly brackets command execution.'
        'No overlapping RAPL domains are added. GPU memory/power, discrete GPU energy, display, battery and wall-socket power are not measured.'
    )
}
$report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $outputFullPath -Encoding utf8
Write-Output $outputFullPath
if ($run.TimedOut) { exit 124 }
if ($run.Error -or $run.OutputDrainTimedOut) { exit 1 }
exit $run.ExitCode

#Requires -Version 7.0
[CmdletBinding()]
param([string]$NodePath = (Get-Command node -ErrorAction Stop).Source)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = Split-Path $PSScriptRoot -Parent
$output = Join-Path $repo '.tmp-resource-profiler-tests'
$null = New-Item -ItemType Directory -Path $output -Force
$pwsh = (Get-Process -Id $PID).Path
function Assert($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }

# Reproduce the snapshot/open race deterministically: obtain a real child PID,
# wait for its bounded exit, release its last handle, then exercise the same
# production AddProcess path used for a PID retained in a Toolhelp snapshot.
Add-Type -Path (Join-Path $PSScriptRoot 'renderer-resource-profiler.cs')
$shortStart = [Diagnostics.ProcessStartInfo]::new($NodePath)
$shortStart.UseShellExecute = $false
$shortStart.CreateNoWindow = $true
$shortStart.ArgumentList.Add('-e')
$shortStart.ArgumentList.Add('process.exit(0)')
$shortChild = [Diagnostics.Process]::Start($shortStart)
$shortPid = $shortChild.Id
if (-not $shortChild.WaitForExit(5000)) { $shortChild.Kill($true); throw 'Short-lived fixture did not exit.' }
$shortChild.Dispose()
$raceRunner = [Velocast.Profiling.Runner]::new()
$privateMembers = [Reflection.BindingFlags]'Instance,NonPublic'
$null = $raceRunner.GetType().GetMethod('AddProcess', $privateMembers).Invoke($raceRunner, @([uint32]$shortPid, [int]0, 'node.exe'))
$raceResult = $raceRunner.GetType().GetField('result', $privateMembers).GetValue($raceRunner)
Assert ($raceResult.UnreadableCandidateProcesses -eq 0) "Exited PID counted as unreadable: $($raceResult.UnreadableCandidateProcesses)"
Assert ($raceResult.ExitedBeforeObservation -eq 1) 'Vanished PID was not reported separately.'
Assert ($raceResult.ProcessReadFailures.Count -eq 1) 'Transient-exit evidence was not retained.'
Assert ($raceResult.ProcessReadFailures[0].Win32Error -in @(87, 1168)) 'Transient-exit classification lacks a process-not-found error.'
Assert ($raceResult.ProcessReadFailures[0].Classification -eq 'ExitedBeforeObservation') 'Transient exit classification missing.'
$raceResult.ProcessReadFailures | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $output 'exited-before-observation.json')
Write-Output "Exited-child race: native error $($raceResult.ProcessReadFailures[0].Win32Error), transient exits $($raceResult.ExitedBeforeObservation), unreadable processes $($raceResult.UnreadableCandidateProcesses)."

function Run-Case([string]$Name, [string]$Source, [double]$Timeout = 15) {
    $commandFile = Join-Path $output "$Name.command.json"
    $reportFile = Join-Path $output "$Name.json"
    @{
        executable = $NodePath
        arguments = @('-e', $Source)
        workingDirectory = $repo
        environment = @{ PROFILER_TEST_VALUE = 'space and "quotes"' }
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $commandFile
    & $pwsh -NoProfile -File (Join-Path $PSScriptRoot 'measure-renderer-resources.ps1') `
        -CommandFile $commandFile -OutputPath $reportFile -IdleBaselineSeconds 1 -TimeoutSeconds $Timeout | Out-Null
    $exitCode = $LASTEXITCODE
    [pscustomobject]@{ ExitCode = $exitCode; Report = (Get-Content $reportFile -Raw | ConvertFrom-Json) }
}

$memory = Run-Case 'memory-tree' @'
const {spawn}=require('node:child_process');
global.touched=Buffer.alloc(64*1024*1024,7);
global.untouched=Buffer.alloc(128*1024*1024);
spawn(process.execPath,['-e','global.b=Buffer.alloc(96*1024*1024,9);console.log("child-ready");setTimeout(()=>{},2200)'],{stdio:'inherit',detached:true,windowsHide:true});
console.log(process.env.PROFILER_TEST_VALUE);
console.error('stderr-ready');
setTimeout(()=>process.exit(0),600);
'@
Assert ($memory.ExitCode -eq 0) 'Memory workload failed.'
$tree = $memory.Report.ProcessTree
Assert ($tree.ObservedProcessCount -ge 2) 'Child process was not discovered.'
Assert (@($tree.Processes | Where-Object ParentPid -eq $tree.RootPid).Count -ge 1) 'No descendant linked to root.'
Assert ($tree.DurationSeconds -ge 2) 'Profiler stopped before the child outlived its parent.'
Assert ($tree.SampledPeakPrivateResidentBytes -gt 150MB) 'Touched allocation is missing from private resident RAM.'
Assert ($tree.SampledPeakPrivateCommittedBytes -gt $tree.SampledPeakPrivateResidentBytes + 64MB) 'Untouched commit was not distinguished from resident RAM.'
Assert ($tree.SampledPeakPrivateResidentBytes -eq ($tree.Samples | Measure-Object PrivateResidentBytes -Maximum).Maximum) 'Tree peak is not a maximum of simultaneous samples.'
Assert ($tree.SnapshotFailures -eq 0) 'Toolhelp snapshots failed.'
Assert ($tree.UnreadableCandidateProcesses -eq 0) 'Known child processes were unreadable.'
Assert ((Get-Content $memory.Report.StdoutPath -Raw).Contains('child-ready')) 'Child stdout missing.'
Assert ((Get-Content $memory.Report.StdoutPath -Raw).Contains('space and "quotes"')) 'Environment override altered.'
Assert ((Get-Content $memory.Report.StderrPath -Raw).Contains('stderr-ready')) 'Stderr capture missing.'
if ($memory.Report.ProcessorPackageEnergy.RenderWindow.Available) {
    $energy = $memory.Report.ProcessorPackageEnergy.RenderWindow
    Assert ($energy.Joules -gt 0 -and $energy.AverageWatts -gt 0) 'Invalid package energy.'
    Assert ([Math]::Abs($energy.MeterCoverageSeconds - $tree.DurationSeconds) -lt 0.75) 'Package energy boundary coverage differs excessively from process duration.'
}
$failure = Run-Case 'exit-code' 'console.error("expected-failure");process.exit(7)'
Assert ($failure.ExitCode -eq 7 -and $failure.Report.ProcessTree.ExitCode -eq 7) 'Command exit code not propagated.'
$timeout = Run-Case 'timeout' 'setInterval(()=>{},1000)' 1
Assert ($timeout.ExitCode -eq 124 -and $timeout.Report.ProcessTree.TimedOut) 'Timeout was not bounded/reported.'
foreach ($process in $timeout.Report.ProcessTree.Processes) {
    Assert ($null -eq (Get-Process -Id $process.Pid -ErrorAction SilentlyContinue)) 'Timed-out child remains alive.'
}
Write-Output "Profiler checks passed; reports: $output"

# Windows renderer resource measurements

Run with PowerShell 7 on Windows. No elevation, service, driver, or power-setting
change is required. Compilation and sampler warmup happen before the idle baseline.
Only one workload should run at a time when comparing processor-package energy.

Create a command JSON file (environment contains overrides only):

```json
{
  "executable": "C:\\Program Files\\nodejs\\node.exe",
  "arguments": [
    "packages/cli/dist/bin.js",
    "render",
    "product-hero",
    "--config",
    "apps/playground/velocast.config.ts",
    "--concurrency",
    "1",
    "--assembly",
    "reference",
    "--output",
    "renders/profile.mp4"
  ],
  "workingDirectory": "D:\\Code\\velocast",
  "environment": {
    "VELOCAST_RENDERER_BINARY": "C:\\vc-target\\release\\velocast-renderer.exe"
  }
}
```

Use the actual renderer command and environment appropriate to your checkout.
Arguments are passed directly with `ProcessStartInfo.ArgumentList`; no command
shell is involved. Commands must name an executable, not a `.cmd` shell script.

```powershell
pwsh -NoProfile -File scripts/measure-renderer-resources.ps1 `
  -CommandFile .tmp-benchmark/command.json `
  -OutputPath .tmp-benchmark/resources.json `
  -SampleIntervalMs 100 -IdleBaselineSeconds 3 -TimeoutSeconds 600
```

The JSON report includes sibling `.stdout.log` and `.stderr.log` paths. Output is
streamed to files, not retained in memory. The script propagates the command exit
code, returns 124 on timeout, and returns 1 on profiler/output-capture errors.
Execution ends after the root and all observed descendants exit; timeout cleanup
is bounded and uses identity-pinned handles. Environment values are not copied
into the report, but command arguments and captured output may contain secrets.

## Memory interpretation

`ProcessTree.SampledPeakPrivateResidentBytes` is the highest simultaneous sum of
private resident RAM across observed live descendants. It reads
`PROCESS_MEMORY_COUNTERS_EX2.PrivateWorkingSetSize`. If EX2 is unavailable or a
live process cannot be read, private resident peak is null. `PrivateCommittedBytes`
is separate private commit; it must not be described as resident RAM.
`WorkingSetBytes` includes shared pages and can double-count them across processes.

Every memory sample includes live/readable counts and collection duration. The
report also includes actual mean/maximum sample spacing, snapshot/read failures,
process identities (PID plus creation time), and each process's sampled peaks.
`ExitedBeforeObservation` counts failed opens with native process-not-found errors
87/1168, separately from `UnreadableCandidateProcesses`. These exited processes
remain sampling blind spots; they do not mark live-process reads incomplete.
`ProcessReadFailures` preserves PID, parent, name, operation, native error and
classification for both transient exits and genuine failures. Metadata failures
increment `FailedProcessMetadataReads` and retain `IncompleteMemoryCoverage`.
Earlier reports without native errors cannot be retrospectively reclassified.
Per-process peaks happen at different times; do not sum them to claim a tree peak.
Toolhelp discovery can miss processes shorter than the sampling interval and
descendants whose full ancestry exits before observation. The sampler is excluded
from the measured process tree. `TotalCollectionMilliseconds` measures sampler
wall time, not CPU time or energy.

## Energy interpretation

A persistent PDH query reads the `Energy Meter(RAPL_Package0_PKG)` Energy, Time and
Power counters once per second, with extra boundary reads. It does not use the
blocking `Get-Counter` sampling loop. Override `-EnergyInstance` only to select a
known nonoverlapping package domain on another machine.

Energy raw values are cumulative picowatt-hours, Time raw values are milliseconds,
and cooked Power is milliwatts. The authoritative window calculation is:

```text
joules = (last energy - first energy) * 3.6e-9
average watts = joules / ((last meter time - first meter time) / 1000)
```

`ProcessorPackageEnergy.RenderWindow` reports measured package joules, average
watts, meter coverage and read boundaries. Compare that coverage with
`ProcessTree.DurationSeconds`; boundary polling and meter updates can make the
energy window slightly wider. Failed/stale/reset counters report unavailable.
Cooked Power is diagnostic; it is not integrated to obtain window energy.
PDH collection timestamps encode local time in FILETIME format. The diagnostic
`CounterTimestampUtc` converts that local time to UTC; the original value remains
in `CounterTimestampLocalFileTime`. Energy and coverage use meter deltas, not
these diagnostic timestamps. Earlier reports could incorrectly label local PDH
time as UTC; their energy calculations are unaffected. Check the conversion
without launching a workload using `scripts/test-renderer-profiler-timestamp.ps1`.

This is total processor-package energy, including other software and profiler
overhead. It is neither application-attributed nor wall-socket/system power.
`BaselineSubtractedEstimate` is a separately labeled estimate above the preceding
idle package baseline and can be negative. Never add overlapping RAPL domains.
This profiler does not measure discrete GPU energy, GPU allocations, display,
battery discharge, or wall-socket power.

Run the bounded parent/child memory, exit propagation and timeout checks with:

```powershell
pwsh -NoProfile -File scripts/test-measure-renderer-resources.ps1
```

References: [PROCESS_MEMORY_COUNTERS_EX2](https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-process_memory_counters_ex2),
[Energy Meter Interface](https://learn.microsoft.com/en-us/windows-hardware/drivers/powermeter/energy-meter-interface),
[PDH raw-counter local timestamps](https://learn.microsoft.com/en-us/windows/win32/api/pdh/ns-pdh-pdh_raw_counter).

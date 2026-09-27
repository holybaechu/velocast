using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;

namespace Velocast.Profiling
{
    public sealed class EnergyReading
    {
        public DateTime CounterTimestampUtc { get; set; }
        public long CounterTimestampLocalFileTime { get; set; }
        public long EnergyPicoWattHours { get; set; }
        public long MeterTimeMilliseconds { get; set; }
        public double? CookedPowerMilliWatts { get; set; }
    }

    public sealed class PackageEnergy : IDisposable
    {
        [StructLayout(LayoutKind.Sequential)]
        struct RawCounter
        {
            public uint Status;
            public System.Runtime.InteropServices.ComTypes.FILETIME Timestamp;
            public long FirstValue, SecondValue;
            public uint MultiCount;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct FormattedCounter { public uint Status; public double Value; }
        [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhOpenQueryW(string source, UIntPtr userData, out IntPtr query);
        [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhAddEnglishCounterW(IntPtr query, string path, UIntPtr userData, out IntPtr counter);
        [DllImport("pdh.dll")] static extern uint PdhCollectQueryDataWithTime(IntPtr query, out long timestamp);
        [DllImport("pdh.dll")] static extern uint PdhGetRawCounterValue(IntPtr counter, out uint type, out RawCounter value);
        [DllImport("pdh.dll")] static extern uint PdhGetFormattedCounterValue(IntPtr counter, uint format, out uint type, out FormattedCounter value);
        [DllImport("pdh.dll")] static extern uint PdhCloseQuery(IntPtr query);
        IntPtr query, energy, time, power;
        static void Check(uint status) { if (status != 0) throw new InvalidOperationException("PDH failure: 0x" + status.ToString("X8")); }
        public PackageEnergy(string instance)
        {
            Check(PdhOpenQueryW(null, UIntPtr.Zero, out query));
            try
            {
                string prefix = "\\Energy Meter(" + instance + ")\\";
                Check(PdhAddEnglishCounterW(query, prefix + "Energy", UIntPtr.Zero, out energy));
                Check(PdhAddEnglishCounterW(query, prefix + "Time", UIntPtr.Zero, out time));
                Check(PdhAddEnglishCounterW(query, prefix + "Power", UIntPtr.Zero, out power));
            }
            catch { Dispose(); throw; }
        }
        static long Raw(IntPtr counter)
        {
            uint type; RawCounter value;
            Check(PdhGetRawCounterValue(counter, out type, out value));
            if (value.Status > 1) Check(value.Status);
            return value.FirstValue;
        }
        public EnergyReading Read()
        {
            long timestamp;
            Check(PdhCollectQueryDataWithTime(query, out timestamp));
            // PDH collection timestamps encode local wall time as FILETIME, unlike
            // ordinary UTC FILETIME values. PDH_RAW_COUNTER.TimeStamp documents
            // this convention: https://learn.microsoft.com/windows/win32/api/pdh/ns-pdh-pdh_raw_counter
            var localTimestamp = DateTime.SpecifyKind(DateTime.FromFileTimeUtc(timestamp), DateTimeKind.Unspecified);
            var result = new EnergyReading {
                CounterTimestampUtc = TimeZoneInfo.ConvertTimeToUtc(localTimestamp, TimeZoneInfo.Local),
                CounterTimestampLocalFileTime = timestamp,
                EnergyPicoWattHours = Raw(energy), MeterTimeMilliseconds = Raw(time)
            };
            uint type; FormattedCounter value;
            uint status = PdhGetFormattedCounterValue(power, 0x200, out type, out value);
            if (status == 0 && value.Status <= 1 && !Double.IsNaN(value.Value) && !Double.IsInfinity(value.Value))
                result.CookedPowerMilliWatts = value.Value;
            return result;
        }
        public void Dispose() { if (query != IntPtr.Zero) { PdhCloseQuery(query); query = IntPtr.Zero; } }
    }

    public sealed class MemorySample
    {
        public double ElapsedSeconds { get; set; }
        public int LiveProcesses { get; set; }
        public int ReadableProcesses { get; set; }
        public ulong? PrivateResidentBytes { get; set; }
        public ulong PrivateCommittedBytes { get; set; }
        public ulong WorkingSetBytes { get; set; }
        public double CollectionMilliseconds { get; set; }
    }

    public sealed class ProcessMeasurement
    {
        public int Pid { get; set; }
        public int ParentPid { get; set; }
        public long CreationFileTime { get; set; }
        public string Name { get; set; }
        public double FirstObservedSeconds { get; set; }
        public double LastObservedSeconds { get; set; }
        public int MemorySamples { get; set; }
        public int FailedMemoryReads { get; set; }
        public ulong? SampledPeakPrivateResidentBytes { get; set; }
        public ulong SampledPeakPrivateCommittedBytes { get; set; }
        public ulong SampledPeakWorkingSetBytes { get; set; }
        internal IntPtr Handle;
        internal long ExitObservedFileTime;
    }

    public sealed class ProcessReadFailure
    {
        public int Pid { get; set; }
        public int ParentPid { get; set; }
        public string Name { get; set; }
        public string Operation { get; set; }
        public int Win32Error { get; set; }
        public string Classification { get; set; }
        public double ElapsedSeconds { get; set; }
    }

    public sealed class RunResult
    {
        public int RootPid { get; set; }
        public int ExitCode { get; set; }
        public bool TimedOut { get; set; }
        public bool OutputDrainTimedOut { get; set; }
        public string Error { get; set; }
        public DateTime StartedUtc { get; set; }
        public DateTime FinishedUtc { get; set; }
        public double DurationSeconds { get; set; }
        public int RequestedSampleIntervalMs { get; set; }
        public int SnapshotFailures { get; set; }
        public int UnreadableCandidateProcesses { get; set; }
        public int ExitedBeforeObservation { get; set; }
        public int FailedProcessMetadataReads { get; set; }
        public List<ProcessReadFailure> ProcessReadFailures { get; set; } = new List<ProcessReadFailure>();
        public bool IncompleteMemoryCoverage { get; set; }
        public int ObservedProcessCount { get; set; }
        public int SampleCount { get; set; }
        public double MeanSampleIntervalMs { get; set; }
        public double MaximumSampleIntervalMs { get; set; }
        public double TotalCollectionMilliseconds { get; set; }
        public ulong? SampledPeakPrivateResidentBytes { get; set; }
        public ulong SampledPeakPrivateCommittedBytes { get; set; }
        public ulong SampledPeakWorkingSetBytes { get; set; }
        public MemorySample[] Samples { get; set; }
        public ProcessMeasurement[] Processes { get; set; }
    }

    public sealed class Runner
    {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct ProcessEntry
        {
            public uint Size, Usage, Pid;
            public UIntPtr DefaultHeap;
            public uint ModuleId, Threads, ParentPid;
            public int BasePriority;
            public uint Flags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Name;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct MemoryCounters
        {
            public uint Size, PageFaultCount;
            public UIntPtr PeakWorkingSet, WorkingSet, QuotaPeakPaged, QuotaPaged;
            public UIntPtr QuotaPeakNonPaged, QuotaNonPaged, Pagefile, PeakPagefile;
            public UIntPtr PrivateUsage, PrivateWorkingSet;
            public ulong SharedCommit;
        }
        [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);
        [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr handle, out long creation, out long exit, out long kernel, out long user);
        [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr handle, uint code);
        [DllImport("psapi.dll", SetLastError = true)] static extern bool GetProcessMemoryInfo(IntPtr handle, ref MemoryCounters counters, uint size);

        readonly Dictionary<int, ProcessMeasurement> latest = new Dictionary<int, ProcessMeasurement>();
        readonly List<ProcessMeasurement> processes = new List<ProcessMeasurement>();
        readonly List<MemorySample> samples = new List<MemorySample>();
        readonly RunResult result = new RunResult();
        readonly Stopwatch clock = new Stopwatch();
        Task task;
        volatile bool cancel;
        public bool IsCompleted { get { return task != null && task.IsCompleted; } }

        public static void Warmup()
        {
            var runner = new Runner();
            runner.Snapshot();
            using (var self = Process.GetCurrentProcess())
            {
                var m = new MemoryCounters();
                m.Size = (uint)Marshal.SizeOf<MemoryCounters>();
                GetProcessMemoryInfo(self.Handle, ref m, m.Size);
            }
        }

        public void Start(string executable, string[] arguments, string directory,
            Dictionary<string, string> environment, string stdoutPath, string stderrPath,
            int intervalMs, double timeoutSeconds)
        {
            if (task != null) throw new InvalidOperationException("Runner already started.");
            var start = new ProcessStartInfo(executable) {
                WorkingDirectory = directory, UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true
            };
            foreach (var argument in arguments) start.ArgumentList.Add(argument);
            foreach (var pair in environment) start.Environment[pair.Key] = pair.Value;
            var stdout = new FileStream(stdoutPath, FileMode.Create, FileAccess.Write, FileShare.Read);
            FileStream stderr = null;
            Process root = null;
            try
            {
                stderr = new FileStream(stderrPath, FileMode.Create, FileAccess.Write, FileShare.Read);
                root = new Process { StartInfo = start };
                result.RequestedSampleIntervalMs = intervalMs;
                result.StartedUtc = DateTime.UtcNow;
                clock.Start();
                if (!root.Start()) throw new InvalidOperationException("Process did not start.");
                result.RootPid = root.Id;
                if (AddProcess((uint)root.Id, 0, Path.GetFileName(executable)) == null)
                    throw new InvalidOperationException("Cannot open the launched root process for memory measurement.");
                var outputTask = root.StandardOutput.BaseStream.CopyToAsync(stdout);
                var errorTask = root.StandardError.BaseStream.CopyToAsync(stderr);
                task = Task.Run(() => Run(root, stdout, stderr, outputTask, errorTask, intervalMs, timeoutSeconds));
            }
            catch
            {
                if (root != null) { try { if (!root.HasExited) root.Kill(true); } catch {} root.Dispose(); }
                stdout.Dispose();
                if (stderr != null) stderr.Dispose();
                foreach (var p in processes) CloseHandle(p.Handle);
                throw;
            }
        }

        public void Cancel() { cancel = true; }
        public RunResult Finish() { task.GetAwaiter().GetResult(); return result; }

        Dictionary<uint, ProcessEntry> Snapshot()
        {
            var snapshot = CreateToolhelp32Snapshot(2, 0);
            var entries = new Dictionary<uint, ProcessEntry>();
            if (snapshot == new IntPtr(-1)) { result.SnapshotFailures++; return entries; }
            try
            {
                var entry = new ProcessEntry { Size = (uint)Marshal.SizeOf<ProcessEntry>() };
                if (Process32FirstW(snapshot, ref entry))
                    do { entries[entry.Pid] = entry; } while (Process32NextW(snapshot, ref entry));
                else result.SnapshotFailures++;
            }
            finally { CloseHandle(snapshot); }
            return entries;
        }

        void RecordReadFailure(uint pid, int parentPid, string name, string operation, int error)
        {
            // A PID from a prior snapshot can cease to exist before OpenProcess.
            // Access denied and metadata/read errors remain coverage failures. PID 0
            // also returns ERROR_INVALID_PARAMETER, but is not an exited process.
            bool exited = operation.StartsWith("OpenProcess", StringComparison.Ordinal) && pid != 0 && (error == 87 || error == 1168);
            if (exited) result.ExitedBeforeObservation++;
            else if (operation.StartsWith("GetProcessTimes", StringComparison.Ordinal)) result.FailedProcessMetadataReads++;
            else if (operation.StartsWith("OpenProcess", StringComparison.Ordinal)) result.UnreadableCandidateProcesses++;
            result.ProcessReadFailures.Add(new ProcessReadFailure {
                Pid = (int)pid, ParentPid = parentPid, Name = name, Operation = operation,
                Win32Error = error, Classification = exited ? "ExitedBeforeObservation" : "UnreadableProcess",
                ElapsedSeconds = clock.Elapsed.TotalSeconds
            });
        }

        ProcessMeasurement AddProcess(uint pid, int parentPid, string name)
        {
            // Hold a handle to the original process object, including after exit, so PID reuse
            // cannot make an unrelated process contribute memory or become a termination target.
            var handle = OpenProcess(0x100000 | 0x400 | 0x10 | 0x1, false, pid);
            if (handle == IntPtr.Zero) { RecordReadFailure(pid, parentPid, name, "OpenProcess.Measurement", Marshal.GetLastWin32Error()); return null; }
            long creation, exit, kernel, user;
            if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user))
            {
                RecordReadFailure(pid, parentPid, name, "GetProcessTimes.Identity", Marshal.GetLastWin32Error());
                CloseHandle(handle); return null;
            }
            ProcessMeasurement previous;
            if (latest.TryGetValue((int)pid, out previous) && previous.CreationFileTime == creation)
            { CloseHandle(handle); return previous; }
            var p = new ProcessMeasurement {
                Pid = (int)pid, ParentPid = parentPid, Name = name, CreationFileTime = creation,
                FirstObservedSeconds = clock.Elapsed.TotalSeconds, Handle = handle
            };
            latest[p.Pid] = p;
            processes.Add(p);
            return p;
        }

        void Sample()
        {
            var collectionStart = clock.Elapsed.TotalMilliseconds;
            var nowFileTime = DateTime.UtcNow.ToFileTimeUtc();
            foreach (var p in processes)
                if (p.ExitObservedFileTime == 0 && WaitForSingleObject(p.Handle, 0) == 0)
                {
                    long creation, exit, kernel, user;
                    bool timesAvailable = GetProcessTimes(p.Handle, out creation, out exit, out kernel, out user);
                    if (!timesAvailable) RecordReadFailure((uint)p.Pid, p.ParentPid, p.Name, "GetProcessTimes.Exit", Marshal.GetLastWin32Error());
                    p.ExitObservedFileTime = timesAvailable && exit > 0 ? exit : nowFileTime;
                }
            var entries = Snapshot();
            var pending = entries.Values.Where(e => !latest.ContainsKey((int)e.Pid) || latest[(int)e.Pid].ExitObservedFileTime != 0).ToList();
            bool added;
            do
            {
                added = false;
                for (int i = pending.Count - 1; i >= 0; i--)
                {
                    var entry = pending[i];
                    ProcessMeasurement parent;
                    if (!latest.TryGetValue((int)entry.ParentPid, out parent)) continue;
                    // Validate creation time before attaching a candidate to a historic parent.
                    var h = OpenProcess(0x1000, false, entry.Pid);
                    if (h == IntPtr.Zero)
                    {
                        RecordReadFailure(entry.Pid, (int)entry.ParentPid, entry.Name, "OpenProcess.Discovery", Marshal.GetLastWin32Error());
                        pending.RemoveAt(i); continue;
                    }
                    long creation, exit, kernel, user;
                    bool valid = GetProcessTimes(h, out creation, out exit, out kernel, out user);
                    if (!valid) RecordReadFailure(entry.Pid, (int)entry.ParentPid, entry.Name, "GetProcessTimes.Discovery", Marshal.GetLastWin32Error());
                    CloseHandle(h);
                    if (!valid || creation < parent.CreationFileTime ||
                        (parent.ExitObservedFileTime != 0 && creation > parent.ExitObservedFileTime))
                    { pending.RemoveAt(i); continue; }
                    var child = AddProcess(entry.Pid, (int)entry.ParentPid, entry.Name);
                    pending.RemoveAt(i);
                    if (child != null) added = true;
                }
            } while (added);

            var sample = new MemorySample { ElapsedSeconds = clock.Elapsed.TotalSeconds, PrivateResidentBytes = 0 };
            foreach (var p in processes)
            {
                if (WaitForSingleObject(p.Handle, 0) == 0) continue;
                sample.LiveProcesses++;
                p.LastObservedSeconds = sample.ElapsedSeconds;
                var memory = new MemoryCounters { Size = (uint)Marshal.SizeOf<MemoryCounters>() };
                bool privateResidentAvailable = GetProcessMemoryInfo(p.Handle, ref memory, memory.Size);
                if (!privateResidentAvailable)
                {
                    // EX compatibility retains commit and working set, never substitutes either
                    // for unavailable private resident RAM.
                    memory.Size = (uint)Marshal.OffsetOf<MemoryCounters>(nameof(MemoryCounters.PrivateWorkingSet));
                    if (!GetProcessMemoryInfo(p.Handle, ref memory, memory.Size))
                    {
                        int error = Marshal.GetLastWin32Error();
                        // An ordinary exit racing this sample does not make other samples' RSS unavailable.
                        if (WaitForSingleObject(p.Handle, 0) == 0) { sample.LiveProcesses--; continue; }
                        p.FailedMemoryReads++;
                        RecordReadFailure((uint)p.Pid, p.ParentPid, p.Name, "GetProcessMemoryInfo", error);
                        sample.PrivateResidentBytes = null; continue;
                    }
                }
                p.MemorySamples++;
                sample.ReadableProcesses++;
                ulong resident = memory.PrivateWorkingSet.ToUInt64();
                ulong committed = memory.PrivateUsage.ToUInt64();
                ulong workingSet = memory.WorkingSet.ToUInt64();
                if (privateResidentAvailable)
                {
                    sample.PrivateResidentBytes += resident;
                    p.SampledPeakPrivateResidentBytes = Math.Max(p.SampledPeakPrivateResidentBytes ?? 0, resident);
                }
                else sample.PrivateResidentBytes = null;
                sample.PrivateCommittedBytes += committed;
                sample.WorkingSetBytes += workingSet;
                p.SampledPeakPrivateCommittedBytes = Math.Max(p.SampledPeakPrivateCommittedBytes, committed);
                p.SampledPeakWorkingSetBytes = Math.Max(p.SampledPeakWorkingSetBytes, workingSet);
            }
            sample.CollectionMilliseconds = clock.Elapsed.TotalMilliseconds - collectionStart;
            samples.Add(sample);
        }

        void Run(Process root, FileStream stdout, FileStream stderr, Task output, Task error, int intervalMs, double timeoutSeconds)
        {
            try
            {
                double next = 0;
                while (true)
                {
                    Sample();
                    if (root.HasExited && samples[samples.Count - 1].LiveProcesses == 0) break;
                    if (cancel || clock.Elapsed.TotalSeconds >= timeoutSeconds)
                    {
                        result.TimedOut = !cancel;
                        if (cancel) result.Error = "Measurement cancelled.";
                        break;
                    }
                    next += intervalMs;
                    double delay = next - clock.Elapsed.TotalMilliseconds;
                    if (delay <= 0) next = clock.Elapsed.TotalMilliseconds;
                    else Thread.Sleep((int)Math.Ceiling(delay));
                }
            }
            catch (Exception exception) { result.Error = exception.ToString(); }
            finally
            {
                result.FinishedUtc = DateTime.UtcNow;
                result.DurationSeconds = clock.Elapsed.TotalSeconds;
                // Bound cleanup; terminate only the launched tree and identity-pinned descendants.
                if (!root.HasExited) { try { root.Kill(true); } catch {} }
                foreach (var p in processes)
                    if (WaitForSingleObject(p.Handle, 0) != 0) TerminateProcess(p.Handle, 124);
                root.WaitForExit(3000);
                result.ExitCode = root.HasExited ? root.ExitCode : 124;
                try { result.OutputDrainTimedOut = !Task.WhenAll(output, error).Wait(3000); }
                catch (Exception exception) { result.Error = (result.Error ?? "") + " Output capture: " + exception.Message; }
                stdout.Dispose(); stderr.Dispose(); root.Dispose();
                foreach (var p in processes) CloseHandle(p.Handle);
                result.ObservedProcessCount = processes.Count;
                result.IncompleteMemoryCoverage = result.SnapshotFailures > 0 || result.UnreadableCandidateProcesses > 0 || result.FailedProcessMetadataReads > 0 || processes.Any(p => p.FailedMemoryReads > 0);
                result.SampleCount = samples.Count;
                result.Samples = samples.ToArray();
                result.Processes = processes.ToArray();
                var gaps = samples.Skip(1).Select((s, i) => (s.ElapsedSeconds - samples[i].ElapsedSeconds) * 1000).ToArray();
                result.MeanSampleIntervalMs = gaps.Length == 0 ? 0 : gaps.Average();
                result.MaximumSampleIntervalMs = gaps.Length == 0 ? 0 : gaps.Max();
                result.TotalCollectionMilliseconds = samples.Sum(s => s.CollectionMilliseconds);
                if (samples.Count > 0)
                {
                    result.SampledPeakPrivateResidentBytes = samples.Any(s => !s.PrivateResidentBytes.HasValue) ? null : samples.Max(s => s.PrivateResidentBytes);
                    result.SampledPeakPrivateCommittedBytes = samples.Max(s => s.PrivateCommittedBytes);
                    result.SampledPeakWorkingSetBytes = samples.Max(s => s.WorkingSetBytes);
                }
            }
        }
    }
}

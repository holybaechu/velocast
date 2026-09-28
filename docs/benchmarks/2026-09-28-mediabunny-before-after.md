# Mediabunny native backend: before/after benchmark

Measured on 2026-09-28 for [PR #4](https://github.com/holybaechu/velocast/pull/4). This is a Windows x64 end-to-end H.264/MP4 comparison, not a pure encoder benchmark or a benchmark of every new format.

The native default improves these 1080p canvas and single-worker footage cases, but takes longer for 4K DOM and four-worker footage. The native 4K path also fails frame identity in four of six timed renders. Fix that capture regression before treating the native default as a frame-accurate replacement.

## Revisions and settings

- **Before:** [c488c67165a2973bafc9f17e6c34f18328bd486b](https://github.com/holybaechu/velocast/commit/c488c67165a2973bafc9f17e6c34f18328bd486b), Chromium WebCodecs video and audio, with Mediabunny already used for media handling/muxing.
- **After:** [be9671bdbd233d78e34e337be8439eac881fe454](https://github.com/holybaechu/velocast/commit/be9671bdbd233d78e34e337be8439eac881fe454), tested with both the native default (`--media-backend auto`) and explicit `--media-backend webcodecs`. The latter still uses the new native source-media/audio implementation.
- Fresh optimized Rust release builds, matching CLI and host code for each revision, and the same Electron 44.4.5 executable. Mediabunny 1.60.0 in both revisions; the new backend adds @mediabunny/server 1.60.0 and node-av 6.1.1.
- All outputs: H.264, MP4, yuv420p, target 64,000,000 bits/s, acceleration auto, 240 frames at 60 fps (4 seconds). One worker uses reference assembly; four workers use segment assembly. Both audio workloads use 48 kHz stereo AAC.
- Native reports compositor bitmap capture, software encoding, and 240 CPU-readback frames. Both WebCodecs variants report shared-texture capture and zero CPU-readback frames. Chromium requests hardware preference, but the telemetry does **not** verify the physical encoder used.

## Execution time

Seconds from fresh CLI process spawn to exit, including preparation, browser/utility startup, rendering, audio, muxing, publication, and cleanup. Each cell is **median (minimum–maximum)** of three unprofiled runs. Percentage changes compare median times; negative means less time.

| Workload                     | Workers | Power   |              Before |         After: native | Change |    After: WebCodecs | Change |
| ---------------------------- | ------: | ------- | ------------------: | --------------------: | -----: | ------------------: | -----: |
| 1080p canvas + audio         |       1 | Battery | 13.57 (13.32–16.75) |   12.50 (12.47–12.83) |  -7.9% | 13.79 (13.64–13.80) |  +1.6% |
| 1080p canvas + audio         |       4 | Battery |    7.87 (7.39–8.06) |      5.44 (5.32–6.26) | -30.8% |    8.10 (7.93–8.72) |  +3.0% |
| 4K DOM                       |       1 | Battery | 22.43 (22.27–23.49) | 31.95 (31.71–32.21) † | +42.5% | 22.08 (22.05–22.25) |  -1.5% |
| 4K DOM                       |       4 | Battery | 11.68 (11.43–12.22) | 12.67 (12.67–13.67) † |  +8.5% | 11.76 (11.69–12.40) |  +0.7% |
| 1080p source footage + audio |       1 | Battery | 24.09 (24.01–30.21) |   21.36 (21.35–21.56) | -11.4% | 23.31 (23.27–23.46) |  -3.2% |
| 1080p source footage + audio |       4 | AC      | 25.99 (24.20–26.75) |   40.21 (39.62–43.60) | +54.7% | 42.14 (42.08–42.54) | +62.2% |

† Native 4K is not a consistently correct result: one of three reference renders and all three segment renders contain stale initial-preview content. These numbers retain every measured latency and are not successful-render speed claims.

The two footage worker counts use different power conditions, so do not use their ratio as a controlled worker-scaling measurement. Every before/after comparison within a row uses one power condition. Three repetitions are descriptive observations, not confidence intervals; small differences should not be generalized.

## Peak private resident RAM

MiB, from one separate instrumented run per configuration on AC power. The value is the highest sampled simultaneous sum over the observed process tree, not a sum of each process’s separate historical peak. GPU allocations and shared resident pages are excluded, so this is not total CPU+GPU memory.

| Workload                     | Workers | Before | After: native | Change | After: WebCodecs |
| ---------------------------- | ------: | -----: | ------------: | -----: | ---------------: |
| 1080p canvas + audio         |       1 |  538.3 |         561.2 |  +4.3% |            542.8 |
| 1080p canvas + audio         |       4 | 1918.0 |        1833.1 |  -4.4% |           1949.0 |
| 4K DOM                       |       1 |  760.9 |        1121.0 | +47.3% |            754.0 |
| 4K DOM                       |       4 | 2750.9 |        3939.1 | +43.2% |           2767.9 |
| 1080p source footage + audio |       1 | 1109.5 |         937.0 | -15.5% |           1024.9 |
| 1080p source footage + audio |       4 | 2819.7 |        2282.4 | -19.1% |           2480.8 |

Used [the repository profiler](../../scripts/measure-renderer-resources.md) at a requested 100 ms interval with a 3-second preceding idle window. No profile reported incomplete live-process memory coverage. There were 2 transient processes that exited before they could be opened; short-lived processes remain a sampling blind spot. Mean sample intervals ranged from 99.7 to 100.0 ms; the largest observed interval was 149.2 ms. Profiled durations are excluded from the timing table.

## Output and correctness

All 54 reported renders exited successfully and independently decoded to 240 H.264 Constrained Baseline, yuv420p frames with the requested dimensions, 60 fps, 4-second video duration, and presentation timestamps within 10 microseconds of frame/60. A barcode embedded in each composition identified every decoded output frame. Footage also carried a separate 30 fps source barcode, checked against floor(outputFrame/2).

**Frame identity passed in 50 of 54 outputs.** All 18 baseline outputs, all 18 updated WebCodecs outputs, and all 12 native canvas/footage outputs passed. The native 4K failures were:

| Workers | Repetition | Incorrect output frames | Observed content         |
| ------: | ---------: | ----------------------- | ------------------------ |
|       1 |          1 | 0                       | Initial preview frame 72 |
|       4 |          1 | 120, 180                | Initial preview frame 72 |
|       4 |          2 | 0, 60, 120, 180         | Initial preview frame 72 |
|       4 |          3 | 0, 60, 120, 180         | Initial preview frame 72 |

A visual check of the failed reference output also showed the headline FRAME 0072 and time 1.20s at output frame 0, while the baseline showed FRAME 0000 and 0.00s. All failing reports still claimed 240 rendered/encoded frames and zero dropped/stale frames. The failures occur at reference or segment starts. The bitmap capture branch in [main.cjs](../../packages/electron-host/main.cjs) is the first place to investigate; this benchmark demonstrates the content error but does not isolate its precise cause. The 4K oracle should become a regression gate before the native default is considered ready.

All 36 audio outputs decoded to 192,512 mono verification samples at 48 kHz after averaging the two stereo channels, including 512 samples of AAC padding beyond the authored 192,000. RMS ranged from 0.01761631 to 0.01763896 against an expected approximately 0.01768. Canvas background color probes also passed within 18 RGB code values. These are signal/frame checks, not a perceptual quality benchmark.

Output sizes below are MiB for each median-time run. A shared bitrate target does not enforce equal achieved bitrate or visual quality. Native H.264 streams did not expose an explicit `color_space` tag to FFprobe; both WebCodecs variants reported `bt709`.

| Workload                     | Workers | Before | After: native | After: WebCodecs |
| ---------------------------- | ------: | -----: | ------------: | ---------------: |
| 1080p canvas + audio         |       1 |   4.15 |          5.78 |             4.14 |
| 1080p canvas + audio         |       4 |   4.08 |          5.74 |             4.08 |
| 4K DOM                       |       1 |   4.32 |          5.49 |             4.32 |
| 4K DOM                       |       4 |   4.75 |          5.77 |             4.75 |
| 1080p source footage + audio |       1 |  14.50 |         18.27 |            15.23 |
| 1080p source footage + audio |       4 |  14.02 |         18.08 |            14.67 |

The native software encoder uses the dependency’s realtime libx264 settings (ultrafast/zerolatency). The benchmark does not normalize internal encoder decisions or quality. It measures the shipped behavior of the requested settings.

## Workloads and method

1. **Canvas:** 1920×1080 canvas with four changing background colors, 60 moving colored rectangles, a frame label, an 8-bit frame barcode, and a 440 Hz PCM tone at gain 0.2.
2. **DOM:** the repository’s 3840×2160 `product-hero` GSAP scene, copied into a static snapshot with local dependencies and an added barcode from its rounded frame metric. It initializes its preview to frame 72. No audio.
3. **Footage:** 1920×1080 React `VideoClip` composition with a 1280×720, 30 fps, four-second H.264 test-pattern source, independent source/output barcodes, and the same audio plan. Source generation used FFmpeg testsrc2, libx264 fast, CRF 12, yuv420p, GOP 30.

Inputs were built once from the baseline’s unchanged authoring packages and shared byte-for-byte by every variant. The CLI snapshot hashes matched across revisions, backends, worker counts, and repetitions:

| Workload                     | Snapshot SHA-256                                                   |
| ---------------------------- | ------------------------------------------------------------------ |
| 1080p canvas + audio         | `773787e1e1ab75b93eb26e533fc1b490168a37d39972250c12af8d006fbc298a` |
| 4K DOM                       | `ffa9e89412897fb154a89369220183472ea3d86e5eb0e21e6eb69a908585abc6` |
| 1080p source footage + audio | `171847748cd4729c0644df1cd55d3218adc56771428915ef223f41a0af2b5dbe` |

One warmup per configuration preceded measured runs. Only one render ran at a time. Variant order rotated by repetition: before/native/WebCodecs, native/WebCodecs/before, then WebCodecs/before/native. Builds, fixture generation, FFprobe/FFmpeg verification, and memory profiling were outside the timing windows. External FFmpeg was only a fixture/oracle tool, not an executable used by either renderer.

Windows recorded AC connection at **08:21:07.983 UTC**, during the initial four-worker footage batch. That entire nine-run batch is excluded from the table and was repeated on AC after the resource passes, which also warmed that configuration. The other 45 timing runs completed on battery. Battery was 55% at the start of the original timing pass and 38% at its end. No power-plan setting was changed by the benchmark.

The common command shape was:

```text
node <revision>/packages/cli/dist/bin.js render <composition>
  --config <shared-fixture>.config.mjs --output <unique>.mp4
  --report <unique>.report.json --codec h264 --pixel-format yuv420p
  --bitrate 64M --acceleration auto --concurrency <1|4>
  --assembly <reference|segments> --json
  [--media-backend auto|webcodecs]  # after revision only
```

Each invocation selected its revision’s release renderer and host with `VELOCAST_RENDERER_BINARY` and `VELOCAST_ELECTRON_HOST_SCRIPT`, and shared `VELOCAST_ELECTRON_BINARY`. Temporary files, render outputs, and configurable caches stayed in a task-owned OS temporary directory. Raw media, logs, build targets, and scratch scripts were removed after recording these findings.

## Machine and limits

- Windows 11 Pro build 26200; Intel Core Ultra X7 358H, 16 cores/16 logical processors; 31.4 GiB visible RAM.
- Intel Arc B390 GPU, driver 32.0.101.8622; Windows Balanced power plan. Battery/AC conditions are labeled above.
- Node 24.21.0, pnpm 12.5.1, rustc 1.98.1, Electron 44.4.5; independent FFmpeg/FFprobe 9.0.1.
- One developer machine with background applications and uncontrolled thermals. Short four-second compositions include meaningful startup overhead; do not extrapolate directly to long exports.
- No macOS/Linux performance measurement, sustained-throughput study, quality-normalized encode comparison, GPU-memory measurement, or speed benchmark of HEVC/AV1/VP8/VP9/ProRes and the additional audio formats was performed.

# Shared-texture video with Mediabunny

Measured on 2026-10-19 on the Linux x64 development machine with Electron
44.4.5 and Mediabunny 1.60.0. The baseline is commit `4a51fb5`'s shared-texture
WebCodecs path, including its handwritten per-frame encoder flush. Both variants
used shared textures, H.264, 3840×2160, 60 fps, 16 Mbps, and the browser software
encoding preference. This measures transport/encoding behavior, not a verified
hardware encoder.

## Direct host comparison

Each run submitted 120 frames: 40 ascending barcode values, 40 descending values,
and 40 repetitions of one static value. The page used eight 100×100 binary
cells over a fixed background. Three alternating baseline/new repetitions used
fresh host/profile/output directories. Timing included frame updates, shared
texture capture and encoding, and finalization; it excluded browser load,
encoder open, and independent decoding. FFmpeg decoded the barcode strip from
completed outputs and verified all 720 frame identities.

| Implementation               |  Run 1 |  Run 2 |  Run 3 | Median |
| ---------------------------- | -----: | -----: | -----: | -----: |
| Previous per-frame flush     | 6.293s | 6.167s | 6.171s | 6.171s |
| Mediabunny VideoSampleSource | 4.006s | 3.606s | 3.695s | 3.695s |

Median time was 40.1% lower for this fixture. All new runs peaked at four live
texture leases and ended at zero. The enforced bound is 32 live leases; packet
identity tracking is bounded at 128 pending frames. These are application
ownership bounds, not measurements of total process RSS or Chromium/driver
memory. They do not establish that Chromium performs no internal copies.

This synthetic comparison does not predict the speedup for arbitrary DOM,
footage, codecs, hardware encoders, or other operating systems. Encoded bytes
are not claimed to be reproducible.

## 4K DOM scene

The maintained `verify-shared-texture-capture.mjs` gate rendered the playground
scene, including its pre-existing frame-72 preview, with an added frame barcode.
Three serial and three four-worker segmented renders each covered 24 frames.
All 144 decoded identities, frame counts, and timestamps passed. Every report
selected `electron_shared_texture` / `electron_webcodecs_h264`, with zero
application pixel readbacks and no fallback.

| Route                | Render times           | Median |
| -------------------- | ---------------------- | -----: |
| Serial reference     | 3.976s, 3.311s, 3.757s | 3.757s |
| Four-worker segments | 5.425s, 4.730s, 4.766s | 4.766s |

These times come from renderer telemetry and exclude independent frame decoding.
Short scenes pay worker startup/assembly costs. An earlier run made alongside
other browser suites had one shared-texture paint timeout in six attempts; all
six isolated repetitions passed. A texture timeout remains an explicit failure
and preserves previous output; it never switches to bitmap capture.

## Validation and limits

- All 18 portable gates passed: PNG diagnostics, changing/repeated frames,
  audio, ranges, segments, software encoding preference, cancellation, invalid
  requests, and unavailable capture/encoder failures preserving previous output.
- Real Electron integration passed H.264, AV1, VP8, VP9 and all eight retained
  audio codecs. HEVC encoding was unavailable in this Linux Chromium build and
  failed explicitly. Native decoder use before image-sequence encoding did not
  enable native video encoding in the isolated encoder renderer.
- Full CLI format checks passed for the available codecs, WebM ranges, MOV
  segments, audio signals, and invalid-request output preservation. Authored
  React footage passed its 16-frame source-identity and audio checks.
- All 102 Rust tests, 60 host unit tests, 16 renderer-oracle/packaging tests,
  type checks, lint, contract freshness, and release foundation checks passed.
  Eight opt-in host integration tests are skipped by the default host unit run;
  the four relevant GPU/capability/native-audio integration cases were run
  separately and passed.
- Unit coverage includes buffered and invalid packet output, asynchronous error
  propagation, bounded GPU leases, final drain ordering, transfer failure, and
  cancellation. The encoder is drained before waiting for its final leases.
- The full fast suite reaches a pre-existing upstream Remotion audio assertion:
  sample 9000 is zero where the test expects a positive value. The same assertion
  fails with the original `4a51fb5` host. CLI tests, browser audits, and the
  renderer/browser unit suites otherwise passed. This change does not repair
  the upstream Remotion audio timeline.
- Windows/macOS acceptance and hardware encoder verification were not run on
  this Linux machine. CI gates now require shared textures and explicitly record
  unavailable browser codecs rather than silently choosing native video.

See the [migration guide](../webcodecs.md). Bitmap/CpuBitmap video, native CPU
video output, ProRes output, and the stock Node video worker are removed. Native
audio, input decoding, and explicit diagnostic PNG output remain available.

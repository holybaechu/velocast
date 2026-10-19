# Snapshot capture synchronization

Historical bitmap/native-video measurements. Those render routes are now removed; see the [shared-texture migration measurements](2026-10-19-shared-texture-mediabunny.md).

## Change

Bitmap video, PNG output, and raw software capture already use Chromium's
surface screenshot to force a redraw. Their frame preparation now awaits the
composition, fonts, image decoding, and target layout without an additional
two-animation-frame wait. Shared-texture capture retains its existing page and
compositor waits. The authoring protocol and public options are unchanged.

Temporary snapshots also request `optimizeForSpeed` from
[`Page.captureScreenshot`](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-captureScreenshot).
The intermediate remains lossless PNG and is decoded immediately. Exported PNGs
are still written through Electron's normal PNG encoder.

## Local timing comparison

Measured on CachyOS Linux x64 with Node 24.22.0, Rust 1.99.1, and Electron 44.4.5.
Baseline: `2178d83`. Both revisions used the same debug Rust build profile,
dependencies, scene, codec settings, and display session.

The scene is the repository's 3840×2160 playground with frame-identity cells.
The adapter duration is shortened to 24 frames at 60 fps while retaining its
initial frame-72 preview. Each revision ran three fresh-process reference
exports with one worker, native H.264, a 16 Mbps target, and the default
compositor. The acceptance gate decoded every output frame after rendering.

| Median renderer telemetry                |  Baseline | Optimized |
| ---------------------------------------- | --------: | --------: |
| Total render wall time                   | 15,130 ms | 10,974 ms |
| Browser frame preparation                |     88 ms |     64 ms |
| Frame preparation and capture/submission | 12,665 ms |  9,049 ms |

Total renderer wall time decreased by 27.5%. Decode verification is excluded
from these timings. The result measures the two changes together; removing the
animation-frame wait alone accounts for little of this scene's total time.

This is a short, single-machine comparison with uncontrolled background load,
not a sustained-throughput or cross-platform benchmark. It does not measure a
shared-texture speedup, and it does not establish byte-identical video exports.

## Validation

- Browser runtime: 35 tests passed, including snapshot readiness, cancellation,
  and the existing default page-paint behavior.
- Rust workspace: 105 tests passed. Browser lint and generated-contract checks
  passed.
- Electron host: 76 tests passed and 10 opt-in tests skipped.
- Native capture acceptance: three reference and three four-worker exports with
  the default compositor, repeated with forced CPU compositor fallback. All 288
  decoded frame identities and presentation timestamps passed, including worker
  boundaries. The baseline's additional 72 frame identities also passed.
- Portable acceptance: all 16 cases passed, including shared textures, bitmap
  retry, CPU fallback, PNG and offset capture, static content, audio, ranges,
  segments, cancellation, and preservation of an existing output on failure.
- Same-session diagnostics compared decoded snapshot pixels with normal and
  fast PNG encoding at 640×360 and 3840×2160: exact matches. A separate 4K check
  compared page-paint waiting against snapshot-owned redraw at frames 0, 23,
  and 0 again: exact matches. Cross-run encoded-video hashes differed; no exact
  encoded-pixel or file-byte reproducibility claim is made.

Validation was performed on Linux. Windows and macOS acceptance runs remain
required in CI.

Raw logs, videos, and diagnostic scripts were temporary and are not repository
inputs. The maintained reproduction is `scripts/verify-native-capture.mjs`
with `--frames 24 --repeats 3 --mode both --all-frames true`; repeat it with
`--cpu-compositor true` for CPU fallback coverage.

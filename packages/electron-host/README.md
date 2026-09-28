# Electron media runtime

The Rust renderer starts `main.cjs`. Authored compositions remain sandboxed in
an offscreen window without Node or trusted media IPC. A separate trusted local
window owns browser media utilities and WebCodecs sessions. Native video encoding
runs in a regular Node child process. Rust receives metadata and completed media,
never operating-system GPU handles.

`media-session.cjs` selects a Mediabunny native software session or the explicit
Chromium WebCodecs session. `native-video-client.cjs` sends JSON control messages
and bounded BGRA/RGBA frames over a binary pipe to `native-video-worker.cjs`.
This avoids Electron's allocator restrictions and V8 serialization-version
coupling. The bitmap path sends pixels directly from Electron main to the worker.
Native submissions can buffer packets. Finalization drains the encoder before validating packet counts,
dimensions, timestamps, codec and container. Capture leases are released only
after the consumer has closed its frames. WebCodecs retains its conservative
per-frame flush and packet acknowledgment.

The CLI supplies its own Node executable through `VELOCAST_NODE_BINARY`.
Direct renderer integrations must supply an absolute stock Node executable;
embedded Electron callers of `createMediaSession` can pass `nodeBinary`.
Workers stay in the host's process group/job, exit on owner disconnect, and are
joined before successful finalization or cancellation completes.

The auto backend uses native codecs, except VP9 on Windows x64, where the pinned
NodeAV binding terminates with `STATUS_ILLEGAL_INSTRUCTION`. Auto uses WebCodecs
there; explicit native VP9 requests fail before entering the binding. All native
encoding currently uses software. See the [public media guide](../../docs/webcodecs.md)
for the codec/container matrix, timestamp precision, and output limits.

## Protocol and lifecycle

The JSONL handshake advertises **protocol 3**. Request IDs are safe integers;
responses carry the same ID and `ok`, with an error message on failure. Lines
are bounded to 4 MiB, the input queue holds four commands, and operations have
deadlines. After `close`, the controller closes stdin and reaps the process.

| Method             | Request                                   | Result                                               |
| ------------------ | ----------------------------------------- | ---------------------------------------------------- |
| `load`             | URL, width, height                        | Loaded composition                                   |
| `execute`          | Script and optional token                 | Exact-token title result                             |
| `resize`           | Width, height                             | Size-matched compositor fence                        |
| `png`              | Absolute output path, expected dimensions | Verified PNG metadata                                |
| `webcodecs-open`   | Settings and optional authored audio      | Actual backend and encoder configuration             |
| `webcodecs-frame`  | Sequential frame index                    | Submission acknowledgment and capture/readback facts |
| `webcodecs-finish` | None                                      | Final media metadata and frame count                 |
| `media-operation`  | Utility operation                         | Operation result                                     |
| `close`            | None                                      | Acknowledgment and shutdown                          |

The transport retains its historical `webcodecs-*` method names for both
backends. Settings include dimensions, fps, bitrate, logical video codec,
`container`, `audioCodec`, `mediaBackend`, `videoProfile`, pixel format,
and an absolute output path. Explicit requests are binding.

Rust supplies isolated frame and profile directories through
`VELOCAST_ELECTRON_FRAME_DIRECTORY` and `VELOCAST_ELECTRON_PROFILE_DIRECTORY`.
PNG uses a compositor fence and exclusive file creation. Bitmap video capture
keeps GPU composition enabled while transferring BGRA frames to the encoder;
it remains the fallback for unavailable shared-texture import. Native encoding
reports CPU readback even when the capture transport uses a shared texture.

Bitmap capture uses Chromium's `Page.captureScreenshot` surface snapshot, which
forces a redraw before copying pixels. The requested logical viewport is set
through device emulation, avoiding display-size and DPI-dependent window bounds.
This provider works with GPU and CPU composition. When Electron's
[reported compositor state](https://www.electronjs.org/docs/latest/api/structures/gpu-feature-status)
indicates unavailable GPU compositing, the coordinator starts a fresh host with
hardware acceleration disabled. This bounded retry is allowed only before any
frames are encoded and propagates to segment workers. The initial viewport is
observed before adapter initialization. Shared-texture capture retains its
startup and per-frame paint observations.

## Audio and codec adapters

The mixer preserves source trims, sample offsets, gain, and linear envelopes.
It uses 4096-sample blocks, file-backed PCM and filtered streaming resampling.
Mono duplicates at unity into stereo; stereo-to-mono averages channels. The
authored PCM digest remains in the source sample clock. Opus output uses 48 kHz.

`native-audio.cjs` uses Mediabunny's custom-encoder interface with NodeAV native
frame conversion. Electron copies external ArrayBuffers, so writing through
NodeAV's `Frame.data` does not update native PCM. The adapter submits copied
input buffers through `Frame.fromAudioBuffer`, preserves encoder priming, and
omits empty FLAC packets containing only metadata. Impulse tests cover AAC timing.

`native-prores.cjs` provides the native ProRes decoder through the server
extension's public AVFrame resource interface. The pinned server extension's
ESM ProRes dependency otherwise registers against a different Mediabunny
instance than this CommonJS host.

Matroska may omit the final audio packet duration. Media probing derives the end
from decoded samples in that case, with bounded sample ownership. This can add
an audio decode pass. Encoded AAC/Opus may be packet-copied when compatible;
an explicit audio codec prevents a different codec from being copied silently.

## Utility operations and packaging

`media-client.cjs` exports `runMediaOperation` and `createMediaSession`.
Sessions support cancellation, timeouts, and asynchronous close. Four cached
video inputs and bounded forward decoding remain available; reverse seeks
restart their iterator. The utility never loads authored pages.

Operations include probe, video frame extraction, image RGBA extraction, audio
decode/mix/encode, frame encoding, audio muxing, and segment concatenation.
Mux/concat operations accept `fps` for constant-frame-rate output so WebM/MKV
retain their final frame duration. Files use exclusive creation; failed jobs
preserve existing destinations. The mixer accepts mono/stereo inputs.

Prepared runtimes include the full installed production dependency closure and
licenses for Mediabunny, its server extension, and NodeAV's platform bindings.
No standalone FFmpeg executable is required. NodeAV download/build hooks stay
disabled. Each artifact inventories and verifies every dependency file.
Public native distributions still require their platform dependency/license audit.

## Validation

Set `VELOCAST_WEBCODECS_TEST_BINARY` to the pinned Electron executable and run
`node --test --test-concurrency=2 packages/electron-host/test/*.test.cjs`.
`VELOCAST_ELECTRON_TEST_BINARY` also enables software-capture stress tests.

The full CLI gates are `scripts/verify-media-formats.mjs`,
`scripts/verify-electron-portable.mjs`, and `scripts/verify-native-capture.mjs`.
They cover decoded frame identity,
audio signal, ranges, assembly, bitmap retry, cancellation, and failure
preservation. Use output directories outside the repository and clean them
after inspecting the results.

The native capture gate uses the 4K DOM scene with an initial frame-72 preview.
It verifies native bitmap capture and decoded identities at reference and
four-worker segment starts. Pass `--renderer <binary> --output <new-temp-dir>`;
`--frames 240 --all-frames true` expands verification to every frame of the full
scene. Windows, Linux, and macOS CI run the 24-frame, three-repeat gate with
`--all-frames true`, without requiring a standalone FFmpeg executable.
`--cpu-compositor true` verifies the explicit CPU fallback and worker propagation;
Windows CI also runs three reference repetitions of that mode.

# Electron media runtime

The Rust renderer starts `main.cjs`. Authored pages stay sandboxed without Node
or media IPC. Video requires shared-texture offscreen capture. A separate trusted
empty window imports GPU frames and uses Mediabunny `VideoSampleSource` for
WebCodecs encoding and muxing. Rust receives acknowledgments and completed media,
never OS GPU handles or raw video frames.

`media-session.cjs` closes local frame wrappers after each bounded submission.
It validates packet identities while allowing buffering/reordering, then drains
once at finalization. `webcodecs-host.cjs` bounds outstanding texture leases and
releases each original OSR texture only through `allReferencesReleased`. It waits
for final releases after draining, avoiding a per-frame encode/flush/release
barrier. There is no canvas, bitmap conversion, native video worker, or CPU video
fallback in the render path. See the [media guide](../../docs/webcodecs.md).

Native audio and decoder registrations live in a different utility renderer.
Explicit image-sequence encoding utilities also get an isolated WebCodecs
renderer so previous native decoder use cannot change video encoder selection.

## Protocol and lifecycle

The JSONL handshake advertises **protocol 4**. Request IDs are safe integers;
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

Settings include dimensions, fps, bitrate, logical codec, container, audio codec,
acceleration preference, and an absolute output path. `auto` and `webcodecs`
both require browser video encoding. Explicit requests remain binding.

Rust supplies task-owned frame/profile directories through
`VELOCAST_ELECTRON_FRAME_DIRECTORY` and `VELOCAST_ELECTRON_PROFILE_DIRECTORY`.
Diagnostic PNG/software observations use Chromium `Page.captureScreenshot`,
fast lossless PNG encoding, and an explicit logical viewport to avoid display
size/DPI clamping. They never serve as a video fallback. Shared-texture capture
retains startup and per-frame compositor observations.

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
`scripts/verify-electron-portable.mjs`, and `scripts/verify-shared-texture-capture.mjs`.
They cover decoded frame identity,
audio signal, ranges, assembly, strict capture failures, cancellation, and failure
preservation. Use output directories outside the repository and clean them
after inspecting the results.

The shared-texture capture gate uses the 4K DOM scene with an initial frame-72 preview.
It verifies shared-texture capture and decoded identities at reference and
four-worker segment starts. Pass `--renderer <binary> --output <new-temp-dir>`;
`--frames 240 --all-frames true` expands verification to every frame of the full
scene. Windows, Linux, and macOS CI run the 24-frame, three-repeat gate with
`--all-frames true`, without requiring a standalone FFmpeg executable.

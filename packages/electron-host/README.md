# Electron media runtime

The native renderer starts `main.cjs`. Authored compositions run in a hidden,
sandboxed offscreen window without Node, preload scripts, or media IPC access.
A separate trusted local window owns WebCodecs encoders and decoders. Captured
textures stay inside Electron; native code receives metadata and compressed
media files, never operating-system GPU handles.

WebCodecs is the default video backend. `auto` negotiates H.264, HEVC, then AV1
using the browser's codec support. Explicit codec selections fail when unavailable.
Mediabunny writes MP4 directly from encoded packets and their decoder configuration,
including color metadata. Its seekable `StreamTarget` writes bounded chunks to a
fresh caller-owned staging path. There are no external encoder, probe, or remux
executables.

Each capture holds one shared texture until its imported VideoFrame has closed,
the encoder has flushed, the compressed packet has been written, and all Electron
texture references have released. Frame timestamps derive from the integer frame
index. Duplicate, missing, reordered, oversized, and mismatched frames fail the
request. Finishing reopens the MP4 and counts actual packets, checks dimensions,
and reports the actual duration and first timestamp.

Native supplies an isolated temporary frame directory and profile directory in
`VELOCAST_ELECTRON_FRAME_DIRECTORY` and `VELOCAST_ELECTRON_PROFILE_DIRECTORY`.
The host sets both Chromium user data and session data to the profile before
startup. Native owns process containment and removes these directories after
termination. The software surface remains available for portable PNG capture.
PNG capture uses a compositor fence and `capturePage`, then exclusive file creation.
The `bitmap` video surface keeps Chromium GPU composition enabled while using
`capturePage` and bounded BGRA transfer to the same WebCodecs encoder. It provides
a portable fallback when shared texture import is unavailable. Frame results
identify `captureBackend: "electron_bitmap"` and `cpuReadback: true`; the shared
texture path reports `electron_shared_texture` and `false`.

The JSONL handshake advertises protocol version 2. Requests have safe integer IDs;
responses carry the same ID and `ok`, with an error message on failure. Request
and response lines are limited to 4 MiB, the input queue holds four commands,
and browser operations have deadlines. After `close`, the controller closes stdin
and reaps the process; this unblocks Windows' inherited pipe read during shutdown.

| Method             | Fields                                              | Result                                |
| ------------------ | --------------------------------------------------- | ------------------------------------- |
| `load`             | `url`, `width`, `height`                            | Loaded composition                    |
| `execute`          | `script`, optional `token`                          | Exact-token title result              |
| `resize`           | `width`, `height`                                   | Size-matched compositor fence         |
| `png`              | Absolute `outputPath`, optional expected dimensions | PNG path, dimensions, bytes           |
| `webcodecs-open`   | `settings`, optional `audio`                        | Negotiated encoder config             |
| `webcodecs-frame`  | Sequential `index`                                  | Frame timing, size, color metadata    |
| `webcodecs-finish` | None                                                | Verified MP4 metadata and frame count |
| `media-operation`  | `operation`                                         | Utility operation result              |
| `close`            | None                                                | ACK, then shutdown                    |

Encoder settings include `width`, `height`, `fps`, `bitrate`, `codec`, absolute
`outputPath`, and optional WebCodecs `hardwareAcceleration`. Optional audio is
`{plan, sources}`, where `sources` maps authored source identifiers to frozen
absolute files. The mixer applies trims, sample offsets, gain and linear volume
envelopes without normalization or limiting. It uses 4096-sample blocks and
file-backed source PCM. Mono duplicates at unity into stereo; stereo-to-mono
uses an equal-weight average. Resampling uses a bounded windowed-sinc filter across
decoded packet boundaries, suppressing aliasing when reducing sample rate.
Output PCM has a SHA-256 digest in the authored sample clock. Encoding prefers
native AAC when available, otherwise native Opus in MP4. Opus uses 48 kHz; the
filtered resampler converts other authored rates while preserving timeline
duration. The result records the actual audio codec and sample rate, source
sample rate, requested codec, and whether automatic fallback occurred.
Set `audioCodec: "aac"` or `"opus"` on a utility operation, or `codec` on the
native audio object, to require that codec; unavailable explicit requests fail.
No external or WebAssembly encoder fallback is loaded. A platform with neither
native AAC nor Opus encoding reports `media.audio_encoder_unavailable`.
Consumers of automatic audio output must accept Opus in MP4, or explicitly
require AAC and handle platforms where its native encoder is unavailable.

`media-client.cjs` exports `runMediaOperation(operation, options)`. It starts
`media-main.cjs`, creates isolated temporary storage, and supports abort signals,
timeouts, explicit Electron binaries, runtime paths, and environment overrides.
Cancellation terminates the owned process tree and removes incomplete output and
scratch files. The utility never loads authored pages.
`createMediaSession(options)` retains a utility process and exposes
`runMediaOperation` (also `run`) and asynchronous `close`. Source providers reuse
these sessions, with four cached inputs per session and bounded forward decoders;
reverse seeks release and recreate their decode iterator.

| Operation kind   | Main fields                                                          | Output                                                                              |
| ---------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `probe`          | `path`, optional `frames`                                            | Duration, track metadata, actual packet count, optional original-timebase PTS index |
| `frame`          | `path`, seconds `timestamp`, `outputPath`, `format`                  | Rotation-correct PNG or raw RGBA                                                    |
| `image-rgba`     | PNG `path`, `outputPath`                                             | Raw RGBA                                                                            |
| `decode-audio`   | `path`, `sampleRate`, `channels`, `duration`, `outputPath`, `format` | Interleaved float32 PCM or float WAV                                                |
| `mix-audio`      | `plan`, optional `sources`, `channels`, `outputPath`, `format`       | Mixed float WAV or PCM                                                              |
| `encode-audio`   | `path`, `outputPath`                                                 | AAC or Opus MP4                                                                     |
| `encode-frames`  | `framePaths`, encoder settings, optional `audioPath`                 | MP4                                                                                 |
| `mux-audio`      | `videoPath`, `audioPath`, `outputPath`                               | Packet-copied video and negotiated AAC/Opus audio; existing AAC is copied           |
| `mux-audio-plan` | `videoPath`, `audio`, `outputPath`                                   | Video with authored audio                                                           |
| `concat`         | `paths`, `outputPath`                                                | Compatible video segments with rebased timestamps                                   |

Inputs are read lazily with an 8 MiB cache. Decoded samples are closed as soon as
consumed. Output files use exclusive creation, so failed operations preserve
pre-existing destinations. Concatenation validates codec configuration, dimensions,
and color metadata and requires each segment to begin with a keyframe. Metadata
indexing is limited to two million frames. Browser codec and device availability
still determine which compressed source formats can be decoded. Audio source
conversion currently supports mono and stereo layouts. HDR extraction reads
10/12-bit planar BT.2020 NCL PQ/HLG data directly, applies the BT.2100 transfer
functions, converts to Rec.709, and uses an explicit luminance-preserving extended
Reinhard SDR mapping (203-nit diffuse reference, 1000-nit white). This replaces
the prior normalization curve and can change HDR appearance. Decoder outputs
without readable supported high-bit-depth planes fail with a precise diagnostic.
For example, the tested Windows HEVC Main10 decoder exposes an opaque GPU frame
with `format: null`, and that installation has no software HEVC decoder. Such HDR
HEVC sources currently fail explicitly. Ordinary float16 Canvas readback already
applies browser tone mapping and is therefore not used as raw HDR luminance.

Run `node --test packages/electron-host/test/*.test.cjs` for protocol and lifetime
tests. Set `VELOCAST_WEBCODECS_TEST_BINARY` to the pinned Electron executable to
exercise actual texture transfer, color fidelity, MP4 mux/decode, authored audio,
and segment concatenation. `VELOCAST_ELECTRON_TEST_BINARY` enables the software
capture stress test. Runtime tests create and remove their own OS temporary files.

API references: [Electron shared textures](https://www.electronjs.org/docs/latest/api/shared-texture),
[Mediabunny output targets](https://mediabunny.dev/guide/writing-media-files#output-targets),
and [Mediabunny media sinks](https://mediabunny.dev/guide/media-sinks).

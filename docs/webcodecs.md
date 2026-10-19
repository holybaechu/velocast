# Shared-texture video and media formats

Electron renders compositions into shared GPU textures. A dedicated trusted
renderer imports each texture as a `VideoFrame`, wraps it in a Mediabunny
`VideoSample`, and submits it to `VideoSampleSource`. Mediabunny manages WebCodecs
encoding, backpressure, and muxing. Rust owns frame scheduling, cancellation,
validation, and transactional publication.

Video requires working shared-texture capture and a browser encoder for the
requested configuration. Missing support fails explicitly and preserves previous
output. There is no bitmap capture or native CPU video encoding fallback.
Diagnostic `frame` PNG exports remain available through software screenshots.
Native audio encoding and input decoding remain available in separate utility
renderers; their codec registrations never enter the GPU video renderer.

## Output formats

The output extension selects `.mp4`, `.mov`, `.webm`, or `.mkv`. An explicit
`--container` must match it. Defaults are VP9 for WebM and H.264 otherwise.

```sh
velocast render scene --output render.mp4 --codec h264 --audio-codec aac
velocast render scene --output render.webm --codec vp9 --audio-codec opus
velocast render scene --output edit.mov --codec h264 --audio-codec pcm-s16
velocast render scene --output archive.mkv --codec hevc --audio-codec flac
```

| Setting       | Values                                                                          |
| ------------- | ------------------------------------------------------------------------------- |
| Video codec   | `h264`, `hevc`/`h265`, `av1`, `vp8`, `vp9`                                      |
| Audio codec   | `auto`, `aac`, `opus`, `mp3`, `flac`, `vorbis`, `pcm-s16`, `pcm-s24`, `pcm-f32` |
| Media backend | `auto`, `webcodecs` (both require WebCodecs)                                    |
| Video profile | `auto`                                                                          |
| Pixel format  | `yuv420p`, `nv12` (opaque 8-bit SDR 4:2:0)                                      |

Codec availability depends on Chromium, the operating system, and the driver.
WebM permits VP8/VP9/AV1 with Opus/Vorbis; other combinations must also be
supported by the encoder and muxer. Audio defaults to AAC for MP4/MOV and Opus
for WebM/MKV. Options do not add audio to a silent composition.

`--acceleration auto` prefers hardware encoding; `off` prefers a browser software
encoder. Both retain shared-texture transport. `required` is rejected because
WebCodecs preferences cannot establish a hardware-only guarantee. The pipeline
avoids application-level raw pixel readback; Chromium or the selected encoder
may perform internal copies. Shared textures do not guarantee hardware encoding.

## Submission and lifetime

Frame acknowledgments report submitted frames and the number of packets emitted
so far. Mediabunny may buffer or reorder packets; Velocast validates unique frame
timestamps, durations, keyframes, and bounded packet sizes. It drains the encoder
once at finalization and checks the complete frame count before publication.

The source `VideoFrame`, timing wrapper, `VideoSample`, and imported texture are
closed after submission/backpressure completes. Electron's
`allReferencesReleased` callback releases the original compositor texture only
when downstream references are gone. Up to 32 texture leases and 128 pending
packet identities are allowed; stalled consumers fail within bounded deadlines.
Finalization drains the encoder before awaiting its final texture releases.

Frame preparation still awaits authored work, fonts, images, and compositor
observations. This does not freeze arbitrary page side effects or make encoded
bytes reproducible across different encoders or machines. Complete output can
use segments; half-open ranges retain source frame numbers and rebase output PTS
to zero. WebM/Matroska timestamps use millisecond ticks, with up to half a
millisecond of rounding.

## Migration and validation

Rebuild the CLI, renderer, and runtime together for Electron host protocol **4**.
Remove `mediaBackend: "native"`, ProRes output, and ProRes profile/pixel-format
settings from existing configurations. Choose a supported WebCodecs video codec.
Bitmap/CpuBitmap modes and their force/fallback environment switches are removed.
ProRes input decoding and native audio remain supported. Runtime packages still
include Mediabunny's server dependencies for those utilities; no standalone
FFmpeg executable is required.

Capture requires even dimensions up to 4096 per side and integer 1–120 fps.
Alpha/HDR output, surround mixing, and native video output are outside this path.
Source adapters producing their own complete videos retain their separate
output contract.

Run these gates with output directories beneath the OS temporary directory:

```sh
node scripts/verify-electron-portable.mjs --renderer ABSOLUTE_RENDERER --output NEW_TEMP_DIRECTORY
node scripts/verify-shared-texture-capture.mjs --renderer ABSOLUTE_RENDERER --output NEW_TEMP_DIRECTORY --frames 24 --repeats 3 --mode both --all-frames true
node scripts/verify-media-formats.mjs --renderer ABSOLUTE_RENDERER --output NEW_TEMP_DIRECTORY
```

They check decoded frame identity, timestamps, audio, ranges, segments,
cancellation, and preservation of previous output when capture or encoding is
unavailable. Platform support requires validation on that operating system.

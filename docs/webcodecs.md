# Media backends and output formats

Electron renders compositions. Rust owns exact frame scheduling, cancellation,
validation, and transactional publication. Mediabunny owns containers and
sample-based encoding. `mediaBackend: "auto"` selects native NodeAV/FFmpeg
software codecs; `"webcodecs"` explicitly selects Chromium's video encoder.
On Windows x64, `auto` selects WebCodecs for VP9 because the pinned native
binding fails with an illegal instruction. Explicit native VP9 fails with a
diagnostic before invoking that binding.

## Format selection

The output extension determines the container. An explicit `--container` must
match it. Video output supports `.mp4`, `.mov`, `.webm`, and `.mkv`.

```sh
velocast render scene --output render.mp4 --codec h264 --audio-codec aac
velocast render scene --output render.webm --codec vp9 --audio-codec opus
velocast render scene --output edit.mov --codec prores --video-profile hq --audio-codec pcm-s16
velocast render scene --output archive.mkv --codec hevc --audio-codec flac
velocast render scene --output chromium.mp4 --media-backend webcodecs --codec h264
```

Corresponding `renderer` configuration fields are `container`, `codec`,
`audioCodec`, `videoProfile`, and `mediaBackend`. Explicit choices are binding.
Unsupported combinations fail and preserve existing output.

| Setting        | Values                                                                          |
| -------------- | ------------------------------------------------------------------------------- |
| Video codec    | `h264`, `hevc`/`h265`, `av1`, `vp8`, `vp9`, `prores`                            |
| Audio codec    | `auto`, `aac`, `opus`, `mp3`, `flac`, `vorbis`, `pcm-s16`, `pcm-s24`, `pcm-f32` |
| ProRes profile | `standard`, `hq`                                                                |
| Media backend  | `auto`, `native`, `webcodecs`                                                   |

WebM supports VP8, VP9, or AV1 video with Opus or Vorbis audio. Other combinations
must also be supported by the selected muxer and encoder. Without an explicit
video codec, WebM defaults to VP9 and other containers default to H.264.
Automatic audio selects AAC for MP4/MOV and Opus for WebM/MKV. Audio options
control authored or supplied audio; they do not add a track to silent compositions.

Complete renders can use segments in the selected container. Public half-open
ranges retain the reference worker and rebase timestamps to zero. Source
adapters that produce their own complete video retain their MP4 contract and
reject unsupported options explicitly.

## Backend behavior

The native backend uses software codecs. GPU capture remains available, but
conversion reads frames into CPU RGBA memory before encoding. Telemetry records
the actual backend and readback. Native hardware interop is outside this route.

With WebCodecs, `auto` acceleration requests hardware preference and `off`
requests software preference. Chromium selects the actual implementation.
`required` is rejected because Velocast does not establish a hardware-only
guarantee. Shared-texture failure before encoding triggers bitmap capture retry.

Frame acknowledgments represent bounded submission. Native encoders may buffer
packets; finalization drains them and verifies counts, dimensions, timestamps,
codec and container before publication. Authored pages remain sandboxed without
Node or access to trusted media IPC.

Input container recognition and codec decoding are separate capabilities.
Native media operations extend decoding through Mediabunny's codec registry.
Unsupported sources fail explicitly. The sample-based audio mixer continues
to support mono/stereo; codec availability does not enable surround mixing.

## Scope and migration

Capture is opaque SDR, with even dimensions up to 4096 per side and integer
frame rates from 1 to 120 fps. Delivery codecs use 8-bit 4:2:0. ProRes encodes
10-bit 4:2:2 from an 8-bit SDR capture; it does not restore HDR or lost precision.
Alpha/HDR output, surround audio, DNxHR, FFV1, and standalone audio export are
outside this change.

Rebuild the renderer and runtime together: Electron host protocol **3** is
required. Runtime preparation includes the production dependency closure of
`@mediabunny/server`, including native bindings. NodeAV package hooks that
download the separate FFmpeg CLI remain disabled. Use
`--media-backend webcodecs` to retain the previous video encoder route.

WebM and Matroska timestamps use millisecond ticks in the current muxer. Frame
order is preserved; timestamps may differ from the source clock by up to half
a millisecond. Frame extraction uses the encoded presentation timestamps.

The media acceptance gate checks six codec/container/audio combinations,
decoded frame identity, audio signal, ranges, segment assembly, and output
preservation after an invalid request:

```sh
node scripts/verify-media-formats.mjs --renderer ABSOLUTE_RENDERER --output NEW_TEMP_DIRECTORY
```

The existing `verify-electron-portable.mjs` gate explicitly tests WebCodecs,
including bitmap retry and cancellation. Run both on each supported operating
system. Windows results do not establish macOS/Linux behavior. Native binary
publication still requires signing, dependency/license audit, and external
consumer acceptance.

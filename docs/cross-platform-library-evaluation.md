# Cross-platform media library evaluation

Research date: 2026-09-28. Scope: Windows, macOS, and Linux desktop/CLI.
Status: design proposal; implementation is deferred. This document is based on
repository inspection and upstream sources. It changes no runtime behavior or
dependencies, and candidate backends have not passed native acceptance or benchmarks.

## Recommendation

Keep Electron for composition rendering and Rust for scheduling, cancellation,
validation, and output publication. Make the codec implementation replaceable
behind one media-session interface. Retain Chromium WebCodecs as one backend;
evaluate `@mediabunny/server` with NodeAV as the native alternative. Add
`@mediabunny/aac-encoder` first if consistent AAC output is the immediate goal.
Complete native runtime packaging for all target systems independently of this
codec work: a different media library does not finish distribution.

The expanded requirement includes broader audio/video codecs. For that scope,
prioritize the native media backend over an isolated AAC fallback. Keep the
public media interface owned by Velocast so Mediabunny's codec/container registry
does not become the limit of future native support.

## What the repository already does

- [The host package](../packages/electron-host/package.json) pins Electron
  44.4.5 and Mediabunny 1.60.0. Mediabunny is already the media I/O layer.
- [CodecSession](../packages/electron-host/webcodecs-codec.cjs) constructs
  `VideoEncoder` directly. [WebCodecsHost](../packages/electron-host/webcodecs-host.cjs)
  passes its packets to Mediabunny's `EncodedVideoPacketSource`.
- [The renderer guide](webcodecs.md) documents automatic shared-texture-to-bitmap
  retry. Bitmap capture still uses WebCodecs encoding, so it handles capture
  failures but cannot supply a missing codec implementation.
- [Audio selection](../packages/electron-host/audio-codec.cjs) tries native AAC
  then Opus. [Media runtime](../packages/electron-host/media-runtime.cjs) uses
  Mediabunny's audio encoder API and applies a macOS Chromium AAC priming offset.
- [CI](../.github/workflows/electron-renderer.yml) already runs portable output
  and footage checks on Ubuntu 24.04 and macOS 15. Its existence is not evidence
  that every GPU/driver path is validated.
- [Release building](../scripts/native-release-target.mjs) currently blocks
  targets other than `win32-x64`. [Runtime packaging](../scripts/electron-runtime-package.mjs)
  is Windows-specific and rejects the retired native FFmpeg payload layout.

## Mediabunny and WebCodecs serve different roles

Mediabunny can own demuxing, muxing, samples, conversions, and encoder plumbing.
Its default browser codecs still depend on WebCodecs availability. It explicitly
supports custom encoders and decoders to supply implementations absent from the
browser or to run outside browsers. Therefore, replacing direct WebCodecs calls
with Mediabunny improves the abstraction; replacing Chromium's codec dependency
also needs a native or WASM codec provider.
[Upstream codec documentation](https://mediabunny.dev/guide/supported-formats-and-codecs)

`VideoSampleSource` accepts raw samples and performs encoding, whereas
`EncodedVideoPacketSource` expects already encoded packets. Both expose
backpressure. A migration can use the former behind an adapter or retain the
latter with another packet-producing encoder. Merely registering a Mediabunny
extension does not intercept Velocast's direct `new VideoEncoder(...)` calls.
[Upstream media sources](https://mediabunny.dev/guide/media-sources)

## Candidates

| Candidate | Proposed role | Material limitation |
| --- | --- | --- |
| Mediabunny + Chromium WebCodecs | Keep the existing lightweight codec route and normalize its interface | Browser/OS codec availability and hardware choice still vary |
| `@mediabunny/aac-encoder` | Targeted fallback before switching MP4 audio to Opus | Requires distributing the extension and validating encoder delay |
| `@mediabunny/server` + NodeAV | Native media backend behind the same Mediabunny API | Adds native binaries, FFmpeg dependencies, and hardware interop validation |
| Native FFmpeg subprocess | Simpler reference/software fallback if native addon integration is too costly | Raw-frame transport adds CPU readback/copy costs |
| `ffmpeg.wasm` | Consider only for a future browser-only constrained workflow | Poor fit for the present desktop/CLI performance goal |

### Targeted AAC extension

`@mediabunny/aac-encoder` implements AAC-LC using a compact FFmpeg WASM build
through Mediabunny's custom-coder API. Upstream shows conditional registration
after `canEncodeAudio('aac')` fails. This fits the current audio path without
replacing video encoding.
[AAC extension documentation](https://mediabunny.dev/guide/extensions/aac-encoder)

**Integration proposal:** try native AAC, then the extension, then the configured
fallback policy. Preserve telemetry describing the actual provider. Replace the
OS-only AAC priming decision with provider-aware timing behavior before enabling
it on macOS: the existing 2112-sample correction is explicitly for Chromium's
AudioToolbox encoder, not every AAC encoder. Reuse the repository's impulse and
duration checks to verify the extension.

### Native Mediabunny extension

`@mediabunny/server` provides native video/audio encoders, decoders, and frame
transformations using NodeAV/FFmpeg. Upstream documents hardware acceleration
across Windows, macOS, and Linux and includes an Electron shared-texture import
example using `AvFrameVideoSampleResource`. Its zero-copy claims describe
compatible native frame paths; they do not establish zero-copy Velocast output
on every device.
[Server extension documentation](https://mediabunny.dev/guide/extensions/server)

The tagged 1.60.0 package requires Mediabunny `^1.45.0`, which includes this
repository's 1.60.0 pin, and NodeAV `^6.0.0`. This establishes declared version
compatibility only. Its registration installs Mediabunny custom coders and a
transformer; it does not replace browser WebCodecs globals.
[Tagged package manifest](https://github.com/Vanilagy/mediabunny/blob/v1.60.0/packages/server/package.json),
[registration source](https://github.com/Vanilagy/mediabunny/blob/v1.60.0/packages/server/src/index.ts)

NodeAV documents Electron-compatible native binaries and x64/ARM64 builds for
all three desktop operating systems. It also documents dependency-sensitive
Linux hardware support and native worker-lifetime constraints. Its default
installation obtains platform binaries, including FFmpeg. Adoption needs a
reviewed, pinned runtime inventory; it cannot simply bypass Velocast's existing
packaging policy. The wrapper's license does not replace the bundled FFmpeg
components' licenses.
[NodeAV installation, Electron, and packaging documentation](https://github.com/seydx/node-av#electron)

**Integration proposal:** isolate native codec resources in the trusted media
host. Start with bitmap input for a correctness reference, then enable native
texture import per supported device. Keep authored pages isolated from Node.
Use NodeAV directly only where the Mediabunny extension does not expose needed
device/encoder control. Validate the existing SDR MP4 contract before expanding
to HDR, 10-bit output, or additional containers.

### Shared textures need capability probes, not an OS assumption

Electron 44.4.5 explicitly represents Windows NT handles, macOS IOSurface, and
Linux native pixmaps. Its OSR implementation contains all three platform paths.
Linux shared-texture capture is therefore not categorically absent in the pinned
version. Availability still depends on the running graphics environment.
[Tagged handle contract](https://github.com/electron/electron/blob/v44.4.5/docs/api/structures/shared-texture-handle.md),
[tagged OSR implementation](https://github.com/electron/electron/blob/v44.4.5/shell/browser/osr/osr_video_consumer.cc)

NodeAV's `SharedTexture` implementation dispatches among IOSurface, D3D11, and
DMA-BUF imports and exposes hardware-frame mapping. This is a concrete starting
point for native interop, not a guarantee that a captured RGB texture is directly
accepted by every encoder. Probe import, color conversion, encoding, and release
as one path. Retain the existing bitmap fallback.
[NodeAV shared-texture implementation](https://github.com/seydx/node-av/blob/main/src/api/utilities/electron-shared-texture.ts)

### FFmpeg subprocess and WASM

Native FFmpeg supports rawvideo inputs and pipes. A deliberately bounded
bitmap-to-subprocess backend is a plausible portable reference implementation;
keep exact frame timing and transactional publication in Velocast. Package a
specific binary/build rather than depending on an arbitrary system installation.
[Rawvideo format](https://ffmpeg.org/ffmpeg-formats.html#rawvideo),
[pipe protocol](https://ffmpeg.org/ffmpeg-protocols.html#pipe)

`ffmpeg.wasm` reports lower performance than native FFmpeg, increased CPU/memory
use for its multithreaded variant, and discontinued Node.js support since 0.12.
Those tradeoffs make it a poor default for a desktop/CLI renderer that can ship
native codecs. A small AAC-specific WASM extension is a different proposition
from moving the complete video pipeline into FFmpeg WASM.
[ffmpeg.wasm FAQ](https://ffmpegwasm.netlify.app/docs/faq/)

## Proposed migration boundary and acceptance

Introduce a media session that owns capability probing, sample submission,
bounded buffering, flush/finalization, cancellation, and resource release. Keep
capture selection separate from codec selection: shared texture versus bitmap
and WebCodecs versus native codecs are independent decisions.

Preserve frame indices, timestamps, color metadata, keyframes, audio duration,
and output validation across adapters. Do not require every encoder to emit one
packet immediately per submitted frame: the current conservative per-frame
flush contract needs an explicit adapter if a new backend buffers output.

First compare the existing backend with a native software reference using exact
frame counts/order, static frames, ranges, AAC impulses, cancellation, repeated
jobs, and preservation of previous outputs on failure. Then benchmark hardware
paths on real Windows, macOS, and Linux hosts, reporting readbacks and actual
backend choices. Extend the existing CI gates and runtime packaging rather than
claiming cross-platform support from package installation alone.

## Expanded codec support

Treat importing media and exporting output as separate capabilities. The current
input helper uses Mediabunny's `ALL_FORMATS`, but successful demuxing does not
establish decoder availability. Export has additional application restrictions:
[Rust codec policy](../crates/renderer-policy/src/codec.rs) accepts only H.264,
HEVC, and AV1; [output creation](../packages/electron-host/media-io.cjs) always
constructs `Mp4OutputFormat`; audio selection permits AAC or Opus; and
[render validation](../crates/renderer/src/webcodecs.rs) requires MP4 and opaque
8-bit 4:2:0 output. A new dependency alone changes none of those restrictions.

### Proposed scope

| Area | Initial candidates | Implementation route |
| --- | --- | --- |
| Delivery video | H.264, HEVC, AV1, VP8, VP9 | Native provider plus the existing WebCodecs route where supported |
| Audio | AAC, Opus, MP3, FLAC, Vorbis, PCM | Native provider; PCM also exists in Mediabunny itself |
| Editing video | ProRes in MOV, with profile-specific validation | `@mediabunny/server` initially |
| Additional import audio | AC-3, E-AC-3, DTS | Native provider, with channel-layout handling evaluated separately |
| Additional output containers | MOV, WebM, MKV; audio-only WAV, FLAC, MP3, Ogg | Container selection and compatibility validation |
| Further lossless/professional formats | FFV1, DNxHD/DNxHR, MPEG-2; AVI/MXF input where needed | Direct NodeAV/FFmpeg codec and container implementation |

This table is a proposed product scope, not verified Velocast support. The server
extension documents video encoding/decoding for H.264, HEVC, VP8, VP9, AV1 and
ProRes, and audio encoding/decoding for AAC, MP3, Vorbis, Opus, FLAC, AC-3,
E-AC-3 and DTS. Check the actual packaged build and requested configuration.
[Server codec coverage](https://mediabunny.dev/guide/extensions/server)

Mediabunny's custom-coder extension mechanism supplies implementations for its
existing codecs; it cannot register arbitrary new codec identifiers. FFV1 is
outside its current video registry, although FFmpeg documents an FFV1 encoder.
Native support beyond that registry needs an adapter that can also demux/mux
through NodeAV/FFmpeg, without forcing its packets through Mediabunny.
[Mediabunny registry and extension limits](https://mediabunny.dev/guide/supported-formats-and-codecs#custom-coders),
[FFmpeg FFV1 encoder](https://ffmpeg.org/ffmpeg-codecs.html#ffv1),
[NodeAV interfaces](https://github.com/seydx/node-av#high-level-api)

The same restriction applies to DNxHD/DNxHR and MPEG-2 video; AVI and MXF are
also absent from Mediabunny's documented container list. FFmpeg exposes these
families, subject to the shipped build. Its DNxHD encoder includes DNxHR profiles.
[FFmpeg format coverage](https://ffmpeg.org/general.html),
[DNxHR profile definitions](https://github.com/FFmpeg/FFmpeg/blob/n8.0/libavcodec/dnxhdenc.c)

### Changes to the public contract

- Represent container, video codec/profile, audio codec, quality settings, and
  pixel/color requirements separately. Keep explicit choices binding.
- Resolve import support from demuxer plus decoder; resolve export support from
  encoder plus muxer plus the requested profile, format, and channel layout.
  Hardware availability is a separate capability from codec availability.
- Provide tested presets, for example H.264/AAC MP4, VP9/Opus WebM, ProRes/PCM
  MOV, and lossless audio. Expose audio codec selection through CLI/config and
  the generated renderer contract, not only internal media operations.
- Make output creation, segment assembly, verification, and audio timing use
  the selected format/provider. Replace MP4-specific filenames and assumptions
  throughout the output path, and add an explicit audio-only output operation
  if standalone audio exports enter the product scope.
- Negotiate alpha and bit depth before capture/conversion. ProRes or a 10-bit
  output setting cannot recover detail discarded by an opaque 8-bit intermediate.
  The current mono/stereo mixer also needs a separate extension before advertising
  surround audio, even when a codec library supports it.

Container support is not the same as playback compatibility in downstream
players. Validate the selected combinations and preserve the existing explicit
failure behavior for unsupported requests.
[Mediabunny codec/container matrix](https://mediabunny.dev/guide/supported-formats-and-codecs#compatibility-table)

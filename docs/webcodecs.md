# WebCodecs rendering

Velocast renders video through Electron and Chromium WebCodecs.
The native renderer owns composition discovery, exact frame scheduling,
cancellation, validation, and transactional output publication. The Electron
host captures frames and encodes them with WebCodecs. Mediabunny packages the
encoded packets and authored audio into the output container.

The default acceleration setting, `auto`, requests Chromium's
`prefer-hardware` option. `off` requests `prefer-software`. Neither setting
proves the selected encoder or guarantees a particular GPU path. `required`
fails because WebCodecs does not report a dependable hardware guarantee.
If shared-texture capture is unavailable before encoding, the renderer resets the
attempt and retries with bitmap capture. This path reads uncompressed frames
back to the CPU; telemetry reports `electron_bitmap`, the readback count, and
the fallback reason. Encoding still uses WebCodecs.

H.264 is the default codec and is probed for availability at runtime. HEVC and
AV1 availability also depends on Chromium, the operating system, and the
installed codecs. Unsupported codec, pixel format,
or container combinations fail before replacing an existing output. Full
compositions can use parallel segment workers; half-open frame ranges use the
reference worker. Inspection and single-frame PNG output remain available
independently of video encoding.

The current video output contract is MP4 with opaque SDR 8-bit 4:2:0 frames,
even dimensions up to 4096 pixels per side, and integer frame rates from 1 to
120 fps. Encoder names are `h264`, `hevc` (or `h265`), and `av1`; driver-specific
names are no longer accepted. Bitrate remains configurable. Native encoder
private options, explicit GPU selection, HDR output, and 10-bit or 4:4:4 output
are not exposed by this implementation.

The composition page remains isolated from Node. A trusted Electron window
receives frames through the host protocol, uses WebCodecs, and passes encoded
chunks to Mediabunny. A frame is released only after its consumer acknowledges
it. The renderer waits for completion, checks frame order and counts, and
publishes output atomically. Authored audio follows its sample plan and shares
the output transaction.

Authored audio encoding prefers native AAC. If Chromium cannot encode AAC,
Velocast uses native Opus in MP4 at 48 kHz and preserves the authored duration
through filtered resampling. Render output consumers must accept both codecs;
the render CLI does not currently expose an audio codec selector. If neither
encoder is available, output fails with `media.audio_encoder_unavailable`.
The report records the codec actually used.

Tagged HDR footage is converted to SDR only when the decoder exposes readable
high-bit-depth planes. Some Chromium HEVC Main10 decoders expose an opaque GPU
frame without readable planes and have no software decoder available. Velocast
rejects those sources with a diagnostic; it does not silently clip HDR values.

Telemetry identifies the capture backend, `chromium_webcodecs` conversion,
the selected `electron_webcodecs_*` encoder, and frame counts. These values
describe Velocast's route; they do not prove Chromium used hardware encoding
or performed no internal readback.

For a source build, install workspace dependencies, build the packages and
renderer, then run `velocast doctor --json`. The portable validation command is:

```sh
node scripts/verify-electron-portable.mjs --renderer ABSOLUTE_RENDERER --output NEW_TEMP_DIRECTORY --frames 12 --repeats 2
```

It checks inspection, PNG, full video, frame ranges, audio, static frames,
cancellation cleanup, bitmap retry, and output preservation on failure. Use a unique output
directory outside the repository. Local Windows validation does not establish
GPU behavior on macOS or Linux; run the native gate on each target platform.

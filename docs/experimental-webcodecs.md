# Experimental Electron sharedTexture + WebCodecs rendering

This opt-in backend keeps captured textures inside Electron, converts them to
`VideoFrame`s with the experimental `sharedTexture` API, and encodes H.264 using
Chromium's WebCodecs implementation. Rust retains composition discovery, exact
frame seeks, input props, audio, cancellation, validation, and transactional
publication. Existing default rendering paths remain unchanged.

## Run

Use a matching source-built renderer and Electron host. With the CLI configured
to use that renderer, enable the experiment in the calling process:

```powershell
$env:VELOCAST_EXPERIMENTAL_ENCODER = 'webcodecs'
pnpm velocast render product-hero --config apps/playground/velocast.config.ts --codec h264 --acceleration auto --pixel-format yuv420p --concurrency 1 --assembly reference --output renders/webcodecs.mp4 --report renders/webcodecs.json
Remove-Item Env:VELOCAST_EXPERIMENTAL_ENCODER
```

On macOS/Linux, prefix the command with
`VELOCAST_EXPERIMENTAL_ENCODER=webcodecs`. The environment variable is inherited by
the native renderer. Inspection and PNG commands retain their existing paths.
Explicit `--codec h264` is required; native encoder names are not aliases for this
backend. Unset the variable to return to the normal backend selection.

Full compositions and half-open frame ranges work with one reference worker.
Unspecified/automatic concurrency selects one worker for this experiment.
Explicit multiple workers, segment assembly, capture probes, other codecs,
non-MP4 output, and other pixel formats fail explicitly. `--acceleration off`
conflicts with shared-texture capture. `--acceleration required` fails because
WebCodecs only offers a hardware preference, not a hardware guarantee.
Failure does not silently switch to the native/software encoder.

## Implementation and guarantees

The composition stays in its sandboxed offscreen browser with no preload or
Node access. A separate hidden encoder window loads only the packaged
`webcodecs.html` page with a restrictive CSP. Its trusted preload needs Electron's
full `sharedTexture` module, so that window has `sandbox: false`, context
isolation, and no page Node integration. It rejects page navigation and popups;
encoder IPC accepts messages only from its main frame. Native handles are never
passed to composition code or serialized into the Rust control pipe.

Capture retains the reference path's initial and per-frame settling paints.
Only a size-matched texture is accepted. Each submitted frame receives a timestamp
derived from its zero-based output index; ranges still seek the original source
frame. Encoding uses baseline AVC, quality latency mode, Annex B packets, and
`prefer-hardware`. One frame is submitted and flushed at a time. This bounds the
queue and checks for missing, duplicate, reordered, and oversized packets; it is
intentionally not a throughput optimization.

`VideoFrame`s and imported texture references are closed after use. The original
OSR texture is released only by `allReferencesReleased`, including GPU completion.
The next frame waits for this acknowledgement. Errors and timeouts fail the job;
native process containment terminates the Electron process tree before cleanup.

Only compressed packets enter Node and the private native-owned `webcodecs.h264`
temporary file. FFmpeg remuxes that stream without re-encoding, generating the
constant-frame-rate timeline from ordered baseline frames. Decoder color metadata
reported by WebCodecs is written into H.264 VUI during remux: some hardware
encoders omit these tags from Annex B output. Unknown/missing color information
fails rather than guessing. Output is checked for codec, dimensions, pixel format,
frame count, duration, and a zero start timestamp before publication. The existing
audio pipeline then mixes/muxes authored sound.

Telemetry reports `mode: experimental_webcodecs`,
`capture_backend: electron_shared_texture_webcodecs`, and
`encoder_backend: electron_webcodecs_h264`. The `webcodecs` object records the AVC
configuration and reported color space. `hardware_encoder_verified` and
`uncompressed_readback_verified` are both false: Chromium does not expose enough
information here to prove the actual encoder or hidden copies. A zero
`cpu_readback_frames` count only means Velocast performed no explicit readback.

The initial scope is even dimensions up to 4096 per axis, 1–120 fps within AVC
level 5.2 limits, opaque SDR 8-bit 4:2:0 output, and supported WebCodecs codec
configurations. HDR and alpha export are unsupported. Codec availability,
driver interoperability, color fidelity, and performance vary by platform.

## Validation

Run ordinary host tests with `node --test packages/electron-host/test/*.test.cjs`.
Set `VELOCAST_WEBCODECS_TEST_BINARY` to the absolute pinned Electron executable
to enable the real shared-texture test. It decodes changing/repeated/black frames
and checks their pixels, count, and deterministic timestamps.

The shared native acceptance harness supports this backend:

```sh
node scripts/verify-electron-portable.mjs --renderer ABSOLUTE_RENDERER --output NEW_TEMP_DIRECTORY --encoder webcodecs --frames 12 --repeats 2
```

It checks inspection, PNG, full video, frame ranges, audio, static frames,
cancellation cleanup, failure preservation, and rejection of unsupported options. Run the same command
without `--encoder webcodecs` to check the software baseline. Keep output outside
the repository and remove it after inspection.

Windows has local runtime validation. macOS/Linux execution and GPU performance
remain unverified; upstream API availability is not a platform support guarantee.
Electron's sharedTexture API remains experimental.

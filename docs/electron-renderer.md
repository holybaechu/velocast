# Electron renderer

Electron is Velocast's browser host. Video uses shared GPU textures imported into
a separate trusted encoder renderer. Mediabunny manages WebCodecs encoding and
muxing through `VideoSampleSource`; Rust owns scheduling, cancellation,
validation, segment assembly, and transactional output publication. Authored
pages remain sandboxed without Node or trusted IPC.

Video fails explicitly when shared textures or a requested browser encoder are
unavailable. Bitmap/CpuBitmap capture and native CPU video output are removed.
Diagnostic PNG screenshots, native audio, and input decoding remain available.
See [media formats, lifetime, and migration](webcodecs.md).

The CLI, renderer, and runtime must agree on Electron host protocol **4**,
`supportedMediaBackends: [webcodecs]`, `videoEncoderBackend: webcodecs`, and
`mediaRuntime: mediabunny`. Hardware acceleration is a preference; near zero-copy
transport does not establish hardware encoding or exclude Chromium-internal
copies. Linux rendering needs a graphical session or Xvfb with working shared
textures. The checked-in release manifest has no published native artifact.

Validation includes `scripts/verify-electron-portable.mjs` for changing/repeated
frames, PNG, audio, ranges, segments, cancellation, and explicit unavailable
capture/encoder failures; `scripts/verify-shared-texture-capture.mjs` exercises
the 4K DOM scene and barcode identity oracle. Use new output directories under
the OS temporary directory. Validate separately on every supported platform.

## CI coverage

The default portable gate requires successful shared-texture rendering. macOS CI
runs it together with authored footage, codec/container/audio checks, and three
serial plus three four-worker 4K barcode runs. GPU capture failures, timeouts,
and frame mismatches fail those checks.

The hosted Ubuntu and Windows runners report a software compositor. They run
`verify-electron-portable.mjs --capture unavailable`, which requires the real
renderer to report that known capability failure, preserve previous output,
submit zero frames, and avoid CPU readback or a fallback host. PNG diagnostics,
invalid requests, and injected capture/encoder failures remain checked. This
mode fails if rendering unexpectedly succeeds or a different error occurs; it
does not automatically skip a failed GPU test. Browser video encoding from image
fixtures and native audio utilities are tested independently on these runners.

Successful Linux/Windows shared-texture rendering requires a GPU-capable machine;
their hosted rejection checks do not establish GPU render support. Run the
portable and 4K gates without `--capture unavailable` on that hardware before
publishing a native runtime. Prepared Windows runtime acceptance retains its
separate self-hosted release gate.

Capture retries invalidate the surface without restarting the active capturer.
Restarting every 50ms can cancel a GPU copy that takes longer than the retry
interval under four-worker 4K load. The first request still starts the capturer;
its deadline and frame-identity validation remain enforced.

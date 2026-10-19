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

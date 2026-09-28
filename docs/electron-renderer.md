# Electron renderer

Electron is Velocast's browser host. Mediabunny supplies native software codecs
and container I/O; Chromium WebCodecs remains an explicit video backend.
Standard Cargo builds include the renderer
without feature flags. The CLI discovers the installed workspace host or uses
the host inside a prepared runtime.

The native renderer retains exact frame scheduling, deterministic composition
inspection, cancellation, and transactional output publication. A single-frame
PNG request uses Electron's bitmap capture. Video frames use Electron's
shared-texture path when available. The actual Chromium encoder implementation
and internal GPU copies are not observable by Velocast.

The native backend reads frames into CPU memory and uses software codecs.
WebCodecs acceleration `auto` prefers hardware and `off` prefers software;
`required` remains unsupported. See [media backends and formats](webcodecs.md)
for supported combinations and the Windows x64 VP9 fallback.

## Build and run

```sh
pnpm install
pnpm build
cargo test -p velocast-renderer
cargo build -p velocast-renderer --release
```

On Windows x64, `pwsh -NoProfile -File scripts/build-electron-renderer.ps1
-Test` builds and tests the renderer using the local Rust and MSVC toolchains.
Set `VELOCAST_RENDERER_BINARY` to the built executable, then run `pnpm
velocast doctor --json`. Linux needs Electron's system libraries and a working
display or Xvfb. The checked-in release manifest has no published native
artifacts; a source build or private candidate is required.

The native binary reports one browser host, `electron`, host protocol version
3, `supportedMediaBackends: [webcodecs, native]`, the legacy
`videoEncoderBackend: webcodecs` field, and `mediaRuntime: mediabunny`. The CLI
rejects older binaries and incompatible host protocols. A prepared runtime's
adjacent `electron-runtime.json` selects its bundled Electron, host scripts,
and media package. See [Windows runtime preparation](windows-runtime-candidate-prep.md).

## Validation

```sh
pnpm check:fast
pnpm electron:verify-portable --renderer ABSOLUTE_RENDERER --output NEW-TEMP-DIR
node scripts/verify-media-formats.mjs --renderer ABSOLUTE_RENDERER --output ANOTHER-NEW-TEMP-DIR
```

The portable gate checks frame identity and order, PNG and offset capture,
video and range output, audio, static frames, cancellation, repeated jobs, and
failure preservation. It forces a shared-texture failure and verifies the
automatic bitmap retry and its readback telemetry. Run it on each supported operating system. Use a unique
directory outside the repository for its output and remove it after inspection.
Signed distribution and broader hardware coverage remain release requirements.

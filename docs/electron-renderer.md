# Electron renderer

Electron is Velocast's browser host. Chromium WebCodecs encodes video and
Mediabunny reads and writes media. Standard Cargo builds include the renderer
without feature flags. The CLI discovers the installed workspace host or uses
the host inside a prepared runtime.

The native renderer retains exact frame scheduling, deterministic composition
inspection, cancellation, and transactional output publication. A single-frame
PNG request uses Electron's bitmap capture. Video frames use Electron's
shared-texture path when available. The actual Chromium encoder implementation
and internal GPU copies are not observable by Velocast.

`auto` acceleration asks Chromium to prefer hardware; `off` asks it to prefer
software. `required` is unsupported because WebCodecs cannot guarantee that
hardware was selected. H.264 is the portable baseline; HEVC and AV1 depend on
platform codec support. See [WebCodecs rendering](webcodecs.md) for scope.

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
2, `videoEncoderBackend: webcodecs`, and `mediaRuntime: mediabunny`. The CLI
rejects older binaries and incompatible host protocols. A prepared runtime's
adjacent `electron-runtime.json` selects its bundled Electron, host scripts,
and media package. See [Windows runtime preparation](windows-runtime-candidate-prep.md).

## Validation

```sh
pnpm check:fast
pnpm electron:verify-portable --renderer ABSOLUTE_RENDERER --output NEW-TEMP-DIR
```

The portable gate checks frame identity and order, PNG and offset capture,
video and range output, audio, static frames, cancellation, repeated jobs, and
failure preservation. It forces a shared-texture failure and verifies the
automatic bitmap retry and its readback telemetry. Run it on each supported operating system. Use a unique
directory outside the repository for its output and remove it after inspection.
Signed distribution and broader hardware coverage remain release requirements.

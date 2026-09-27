# Electron renderer

Electron is the sole browser host. Standard Cargo builds include it without
feature flags, and the normal CLI discovers the workspace host or uses the host
inside a prepared runtime. The CEF adapters, download/build scripts, runtime
package, and Linux DMA-BUF/Vulkan/VAAPI implementations have been removed.

The composition protocol, deterministic Rust frame schedule, Windows GPU
conversion and encoding, audio pipeline, and transactional output publication
remain in place. WebCodecs is a separate future encoder decision.

| Capability                                   | Windows x64                                | Linux / macOS                                 |
| -------------------------------------------- | ------------------------------------------ | --------------------------------------------- |
| Inspection, PNG, offset capture              | Implemented                                | Implemented                                   |
| Software video, ranges, static frames, audio | Implemented                                | Implemented                                   |
| Parallel rendering                           | Native workers, each with an Electron host | Software workers, each with an Electron host  |
| `auto` acceleration                          | Native GPU route with software fallback    | Explicit software fallback in telemetry       |
| `required` acceleration                      | D3D11 shared textures and native encoding  | Fails with `electron.gpu_capture_unsupported` |
| Self-contained runtime candidate             | Packager and local validation              | Production packaging/signing remains blocked  |

The default Linux/macOS GPU rendering path is not implemented. An opt-in
[sharedTexture + WebCodecs experiment](experimental-webcodecs.md) adds browser-owned
H.264 encoding without claiming required hardware acceleration or validated Unix
GPU support. The release manifest has no
published artifacts; source builds and local runtime candidates do not establish
public installation support.

## Build and run

Install workspace dependencies and build the JavaScript packages:

```sh
pnpm install
pnpm build
```

On Windows x64, install Rust, Visual Studio C++ build tools, LLVM, and the FFmpeg
vcpkg dependencies. `scripts/setup-accelerated-rendering.ps1` prepares the Windows
media dependencies. Then build and test:

```powershell
. ./.velocast/accelerated-env.ps1
pwsh -NoProfile -File scripts/build-electron-renderer.ps1 -Test
$env:VELOCAST_RENDERER_BINARY = (Resolve-Path target/electron/release/velocast-renderer.exe).Path
pnpm velocast doctor --json
pnpm velocast render product-hero --config apps/playground/velocast.config.ts --acceleration required
```

From an already prepared Windows compiler environment, or on Linux/macOS:

```sh
cargo build -p velocast-renderer --release
cargo test --workspace
```

Linux/macOS native software builds need Rust, not FFmpeg development headers or
Vulkan/VAAPI/DRM libraries. Rendering needs `ffmpeg` and `ffprobe` on PATH plus the
installed Electron host. Linux also needs Electron's system libraries and a
working display or Xvfb. The CI workflow configures the Electron sandbox helper;
it does not disable the sandbox.

The native binary reports `browserHosts: ["electron"]` and
`defaultBrowserHost: "electron"`. The CLI rejects old dual-host binaries and
incompatible host protocols. The obsolete `cef-host` and `electron-host` Cargo
features no longer exist. No experimental browser variable is needed; the legacy
value `electron` is tolerated, while `cef` fails with an actionable error.

For a bare developer binary, the CLI discovers the installed private workspace
host. Missing Electron dependencies produce setup guidance without implicit
installation. For a prepared runtime, the adjacent `electron-runtime.json`
selects its bundled Electron, host scripts, and media tools. That bundle takes
precedence over development overrides. See
[Windows runtime preparation](windows-runtime-candidate-prep.md).

## Frame transport and parallel workers

The Windows GPU path passes shared D3D11 handles, copies into owned textures,
waits for GPU copy completion, and acknowledges release to Electron. It performs
no uncompressed-frame CPU readback. Generation, dimensions, and frame settling
checks remain part of capture correctness.

Software capture disables hardware acceleration before Electron starts. Each
bitmap uses one bounded binary file lease in a native-owned private directory;
the JSON pipe carries metadata. Rust checks generation, dimensions, pixel format,
and exact byte count, then acknowledges release. Pixel-bearing requests use
`capturePage` compositor completion. Cached paint events only establish loaded
or resized surfaces. The per-frame transfer limit is 256 MiB.

Each native worker owns a hidden Electron instance and its Chromium children.
GPU segment assembly lets the coordinator render one segment while additional
workers render the rest. Software workers return ordered BGRA frames to one
encoder; the discovery browser closes before they start. Every host has a private
profile directory, avoiding profile contention between workers. The native owner
terminates and reaps the process tree before cleaning up frame and profile files.

Accelerated capture queues preparation invalidation without waiting for a paint
that capture would discard. Initial surface readiness, resize/reload generations,
settling paints, and GPU copy/release fences remain enforced. Capture cadence
defaults to 1000 Hz and can be configured with `VELOCAST_ELECTRON_CAPTURE_FPS`;
software offscreen cadence is capped at 240 Hz by Electron. Output FPS remains
the composition's deterministic schedule.

## Validation

```sh
pnpm check:fast
pnpm electron:verify-portable --renderer PATH --output NEW-DIR
pnpm electron:verify --renderer WINDOWS-EXE --output NEW-DIR --segments true
```

The portable gate checks software frame identity/order, PNG, offset capture,
ranges, audio, static frames, repeated jobs, two workers, and output preservation
on failure. The real host tests additionally cover black frames and reload/resize.
On Unix the portable gate also checks automatic fallback
and rejection of required GPU capture. `--bundled true` uses the candidate's
runtime marker and bundled media tools.

The Windows GPU gate checks repeated renders, ranges, audio, static frames,
cancellation, failure preservation, and parallel segments. Pass `--reference
VIDEO` to compare an archived output with matching dimensions and frame count.
It no longer launches CEF.

Set `NEW-DIR` to a unique absolute path outside the repository, such as a directory
under the operating system's temporary directory. Remove generated reports,
fixtures, and media after inspecting the results. Keep runtime candidates outside
the repository until distribution validation is complete.

Run native and software gates on each supported operating system; cross-target
compilation alone does not establish runtime behavior. Signed distribution and
broader hardware coverage remain release requirements.

# Experimental native NV12 rendering

The opt-in Windows path captures Electron NV12 shared textures, encodes them in
a Rust Node-API addon in Electron's main process, and leaves scheduling, audio,
output validation and atomic publication in the existing native coordinator.
The ordinary BGRA renderer remains the default. No WebCodecs API is used.

```text
Electron NV12 texture → keyed mutex → owned D3D11 NV12 frame
    → QSV / NVENC / AMF H.264 → staged MP4
Rust coordinator → audio mux, final validation, atomic publication
```

The initial supported request is Windows x64, H.264 MP4, even dimensions,
NV12/8-bit 4:2:0, `acceleration: required`, and one reference worker. Complete
renders and half-open frame ranges use the same deterministic frame loop.
Other codecs, containers, parallel assembly, software fallback, PNG requests
and standalone capture probes are rejected while this option is selected.

This path uses Electron's reported BT.709 limited-range NV12 pixels. It does not
retag them as the existing BGRA shader path's full-range BT.601 output. The
addon validates the actual color metadata, geometry, frame ordering and PTS.
The original Electron texture remains retained until native GPU work has
completed; only a generation-bound token crosses the coordinator's JSON pipe.

## Build and run

Prepare the normal workspace JavaScript packages, the pinned Electron runtime,
Visual Studio C++ tools, LLVM, and FFmpeg development libraries as described in
[the Electron guide](electron-renderer.md). A CLI `ffmpeg.exe` is not a substitute
for the development libraries linked by the Rust addon.

Use an existing vcpkg installation and a task-specific temporary build directory:

```powershell
$nv12Build = Join-Path $env:TEMP ('velocast-nv12-' + [guid]::NewGuid().ToString('N'))
$nv12Vcpkg = 'C:\path\to\vcpkg'
pwsh -NoProfile -File scripts/build-native-encoder.ps1 `
  -VcpkgRoot $nv12Vcpkg -TargetDirectory "$nv12Build/addon-target" `
  -OutputDirectory "$nv12Build/addon" -Test
pwsh -NoProfile -File scripts/build-electron-renderer.ps1 `
  -VcpkgRoot $nv12Vcpkg -TargetDirectory "$nv12Build/renderer-target" -Test

$env:VELOCAST_NATIVE_NV12 = '1'
$env:VELOCAST_NATIVE_ENCODER_ADDON = "$nv12Build/addon/velocast-native-encoder.node"
$env:VELOCAST_RENDERER_BINARY = "$nv12Build/renderer-target/release/velocast-renderer.exe"
$env:PATH = "$nv12Vcpkg/installed/x64-windows/bin;$env:PATH"
pnpm velocast render hello-react --acceleration required --concurrency 1 `
  --assembly reference --codec h264 --pixel-format nv12 --output "$nv12Build/video.mp4"
```

Keep the addon and its packaged DLLs together. `VELOCAST_NATIVE_ENCODER_ADDON`
must name an existing absolute `.node` file; loading occurs only in Electron's
main process, never in the sandboxed composition. Remove `VELOCAST_NATIVE_NV12`
or set it to `0` to use the ordinary renderer. The addon is a separate
experimental build and is not automatically acquired by the runtime resolver.
Keep requested video deliverables before removing the task-owned build directory.

## Validation

Run the real-output gate with absolute paths and a directory under the OS temp
directory. `--core` defaults to this checkout's built `packages/core/dist`:

```powershell
node scripts/verify-native-nv12.mjs --renderer $env:VELOCAST_RENDERER_BINARY `
  --addon $env:VELOCAST_NATIVE_ENCODER_ADDON --electron C:/path/to/electron.exe `
  --host-script "$PWD/packages/electron-host/main.cjs" --output "$nv12Build/verification"
```

The gate checks changing and static frames, a rebased frame range, decoded
frame order/colors, H.264/BT.709 limited metadata and preservation of a previously
published output after an injected seek failure. Generated files stay below the
requested temporary directory. Unit tests separately cover malformed capture
metadata, lease release, queue limits, native cleanup and backend selection.

This path passed on Intel Arc B390 with Windows driver 32.0.101.8622 and Electron
44.4.5. QSV was selected; AMF and NVENC hardware were not tested. Native telemetry
reports no addon pixel readback or raw-frame IPC; these counters do not prove
the absence of internal Chromium/driver CPU access.

## Vulkan and Linux status

The separate `gpu-pipeline` crate supplies real Vulkan discovery and a bounded
transfer-only NV12 image pool with an optional diagnostic exercise. It is not
the encoder used by the Windows addon. On the tested Windows driver, Vulkan
image operations work but Vulkan Video encode queues are absent; a real
`h264_vulkan` initialization also fails for that reason.

Linux native DMA-BUF import, producer synchronization, encode-ready Vulkan
allocations and Vulkan Video submission require further integration and real
Linux GPU validation. The Windows route must not be reported as proving them.
See [Linux validation](native-nv12-linux.md) for the probe and its explicit
diagnostic readback behavior. Portable compilation and tests run without
asserting GPU availability on CI.

# Windows runtime candidate preparation

The checked-in [release manifest](../release/velocast-release.json) has no
published native artifacts. Use a source build or a prepared private runtime.
The renderer uses Electron as its sole browser host.

Prepare the Windows FFmpeg dependencies and build the renderer:

```powershell
. ./scripts/setup-accelerated-rendering.ps1
. ./.velocast/accelerated-env.ps1
pwsh -NoProfile -File scripts/build-electron-renderer.ps1 -Test
pnpm build
```

Create a new runtime directory using explicit local inputs:

```powershell
$runtimeOutput = Join-Path $env:TEMP ('velocast-runtime-' + [guid]::NewGuid().ToString('N'))
pnpm electron:package --renderer target/electron/release/velocast-renderer.exe `
  --electron packages/electron-host/node_modules/electron/dist `
  --ffmpeg C:\media-tools\ffmpeg.exe --ffprobe C:\media-tools\ffprobe.exe `
  --dll-dir .tools/vcpkg/installed/x64-windows/bin `
  --dll-dir C:\Windows\System32 `
  --licenses .tools/vcpkg/installed/x64-windows/share `
  --output $runtimeOutput
```

The runtime contains the renderer, FFmpeg CLI tools and required native DLLs at
its root, pinned Electron in `electron/`, host JavaScript in `electron-host/`,
and applicable licenses/notices. The packager follows native DLL imports, checks
architecture and Electron-only capabilities, rejects CEF imports, and records
file hashes, dependency edges, and source revision in `electron-runtime.json`.
It refuses to overwrite an existing candidate directory. Build intermediates and
toolchain binaries do not belong in the payload.

Point the normal CLI at the candidate:

```powershell
$env:VELOCAST_RENDERER_BINARY = Join-Path $runtimeOutput 'velocast-renderer.exe'
pnpm velocast doctor --json
pnpm velocast frame product-hero --config apps/playground/velocast.config.ts --frame 0 --output (Join-Path $env:TEMP 'product-hero.png')
pnpm velocast render product-hero --config apps/playground/velocast.config.ts --acceleration required --output (Join-Path $env:TEMP 'product-hero.mp4')
```

The CLI reads the adjacent runtime marker and uses the bundled host and media
tools. No browser selection variable or CEF setup is required. The browser
protocol remains **4**, and the Electron host protocol is **1**.

Keep the candidate outside the checkout and delete it and the test media when
validation is complete. Put any retained deliverable in a designated artifact
directory outside the repository.

A local candidate is unsigned and does not establish public release support.
Release tooling still requires the declared inventory, file hashes, architecture,
compatible capabilities, signing evidence, and validation before atomic cache
promotion and publication. Rebuild from the intended release commit and validate
installation, offline cache behavior, corruption rejection, cancellation, and
native output in a clean consumer environment.

Review the selected FFmpeg redistribution terms, Electron/Chromium and oneVPL
notices, and Microsoft Visual C++ redistribution terms before release. See the
[FFmpeg legal page](https://ffmpeg.org/legal.html) and
[Microsoft redistribution guidance](https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files?view=msvc-170).
Linux/macOS software rendering remains available from source; production
packaging and signing for those platforms are separate work.

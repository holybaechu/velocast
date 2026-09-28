# Windows runtime candidate preparation

The checked-in [release manifest](../release/velocast-release.json) has no
published native artifacts. Use a source build or a prepared private runtime.
The renderer uses Electron, Chromium WebCodecs, and Mediabunny.

Build the renderer and workspace packages:

```powershell
pnpm install
pnpm build
$rendererTarget = Join-Path $env:TEMP ('velocast-renderer-' + [guid]::NewGuid().ToString('N'))
pwsh -NoProfile -File scripts/build-electron-renderer.ps1 -TargetDirectory $rendererTarget -Test
```

Create a new runtime directory using the pinned Electron distribution and
the installed Mediabunny package:

```powershell
$runtimeOutput = Join-Path $env:TEMP ('velocast-runtime-' + [guid]::NewGuid().ToString('N'))
pnpm electron:package --renderer (Join-Path $rendererTarget 'release/velocast-renderer.exe') `
  --electron packages/electron-host/node_modules/electron/dist `
  --output $runtimeOutput
```

The runtime contains the renderer, Electron, the trusted host scripts, and
Mediabunny's runtime bundle and license. The packager checks architecture,
renderer capabilities, native imports, and every staged file hash. It records
the source revision in `electron-runtime.json` and refuses to overwrite an
existing directory.

Point the normal CLI at the candidate:

```powershell
$env:VELOCAST_RENDERER_BINARY = Join-Path $runtimeOutput 'velocast-renderer.exe'
pnpm velocast doctor --json
pnpm velocast frame product-hero --config apps/playground/velocast.config.ts --frame 0 --output (Join-Path $env:TEMP 'product-hero.png')
pnpm velocast render product-hero --config apps/playground/velocast.config.ts --output (Join-Path $env:TEMP 'product-hero.mp4')
```

The CLI reads the adjacent runtime marker. Browser protocol 4 and Electron
host protocol 2 must match the CLI. The candidate remains unsigned and does
not establish public release support. Validate installation, offline cache
behavior, corruption rejection, cancellation, and native output in a clean
consumer environment before publication. Keep generated media outside the
repository and remove it after validation.

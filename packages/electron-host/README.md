# Electron browser host

The native renderer starts Electron with `main.cjs` as its application entry.
This private package opens a hidden offscreen `BrowserWindow` with no preload
or page IPC, and no Node
integration in the composition. Windows accelerated capture uses shared D3D11
textures. The software path uses Electron's software output device and a bounded
BGRA file transfer; it has no platform-specific texture import. Windows software
capture is tested locally; hosted macOS ARM64 and Linux x64 gates exercise the
portable software path. See the [renderer guide](../../docs/electron-renderer.md)
for the current support limits. The Electron main process alone reads JSONL
commands from stdin and writes JSONL responses to stdout. Diagnostics go to
stderr. The runtime in `crates/renderer/browser/runtime.js` remains the browser
protocol; native injects it with `execute` after `load`.

The shared-texture host defaults to 1000 Hz offscreen capture, independently of output FPS.
`VELOCAST_ELECTRON_CAPTURE_FPS` accepts a positive integer override up to 1000000;
the upper guard keeps Electron's microsecond interval nonzero. There is no
unlimited sentinel: Electron treats zero as 1 fps, so this host rejects it.
Higher rates do not remove the bounded texture lease or native backpressure.
Electron caps the bitmap/software path at 240 Hz even when a higher rate is
requested; capture settings do not guarantee achieved throughput.

Native gives each host a private temporary directory, including accelerated
hosts. `VELOCAST_ELECTRON_PROFILE_DIRECTORY` points to its `profile` subdirectory;
the host sets both Electron `userData` and `sessionData` there before readiness.
Concurrent hosts therefore do not share Chromium disk/GPU caches or browser
storage. Native removes only its owned directory after terminating and reaping
the host, with bounded Windows retries for transient profile locks. Profile
isolation does not create frame-pixel files in accelerated mode.

Native sets `VELOCAST_ELECTRON_SURFACE_MODE` before startup (`accelerated` or
`software`). Software mode calls `app.disableHardwareAcceleration()` before
readiness and requires `VELOCAST_ELECTRON_FRAME_DIRECTORY`, an existing private
directory owned by native. Native creates it with mode 0700 on Unix. The host
writes at most one `frame.bgra` with mode 0600, using exclusive creation, and
returns only `softwareFrameId`, `generation`, `width`, `height`, `pixelFormat`,
and `byteLength` in JSON. Dimensions are capped at 16384 per axis and 256 MiB
per frame before browser resize or bitmap allocation. Native checks the exact
file length, reads the packed BGRA bytes, and acknowledges the exact lease with
`release { softwareFrameId }`. Release, EOF, and close delete the file; native
also deletes an abandoned file and its directory after process termination.

Software pixel capture awaits a compositor fence and `capturePage`'s
request-correlated surface copy. An invalidation event can re-emit the cached
backing bitmap, so it cannot acknowledge a pixel-bearing software request.
NativeImage's packed premultiplied sRGB
BGRA bytes retain alpha and enter the existing software/crop/FFmpeg pipeline.
The browser background is black for consistent video compositing.
Accelerated mode never constructs a software file lease or reads bitmap pixels.
Software load/reload also consumes a size-matched startup paint before its
acknowledgement, preventing the initial blank surface from becoming frame zero.
This observation transfers no bitmap bytes and accepts genuinely black frames.

The host first writes `{ "event": "ready", "version": 1, "pid": N }` with
`surfaceMode` and the optional `asyncPaintInvalidation` capability. Accelerated
hosts advertise that capability so native can submit `invalidate` and receive
`{ "queued": true }` without awaiting the discarded preparation paint. It
requires an idle capture surface with no retained texture. Actual `paint`
requests still wait for fresh generation/size-checked textures and retain all
settling and copy/release fences. Older hosts use the synchronous preparation
path; older native controllers remain compatible without the profile variable.
Commands have a safe integer `id` and one of these methods:

| Method    | Fields                                            | Success response fields                                                              |
| --------- | ------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `load`    | HTTP(S) or local `file:` `url`, `width`, `height` | none                                                                                 |
| `execute` | `script`, optional `token`                        | `result` string for tokened scripts                                                  |
| `resize`  | `width`, `height`                                 | none, after a size-matched BGRA paint                                                |
| `paint`   | `generation`, `copy` boolean                      | geometry, pixel format, color metadata; `textureId` and `handle` when `copy` is true |
| `release` | `textureId` or software `softwareFrameId`         | none                                                                                 |
| `close`   | none                                              | none, then process exit                                                              |

Every command gets `{ "id": N, "ok": true, ... }` or
`{ "id": N, "ok": false, "error": "..." }`. A tokened `execute` waits for
`velocast-script-result:<token>:ok|err:<payload>` in `document.title`; titles
for other tokens do not complete the request. An accelerated paint command calls
`webContents.invalidate()` and waits for a new `paint` event. Unsolicited
textures are released immediately. A copied paint retains one Electron texture
until native has duplicated its process-local NT HANDLE, copied into its own GPU
texture, and sent `release`. The handle is a `0x` hexadecimal string so all 64
bits survive JSON. The host rejects any non-BGRA or malformed shared texture.

Commands and responses are limited to 4 MiB, and the queue is bounded. Load,
script, and paint waits have timeouts. Each accelerated paint request restarts the offscreen
capturer before invalidating, which produces a fresh GPU texture even for static
content without changing composition pixels or layout. Early null-texture paints
are ignored until the bounded paint deadline. Resize waits for a BGRA paint at
the requested viewport size before adapter initialization can continue; paints
from the old size are released. EOF or pipe failure tears down the
window and releases retained textures. After the `close` ACK, native closes the
stdin pipe and reaps the Electron process; the inherited Windows pipe otherwise
keeps the GUI process alive after `app.exit`. Native must terminate the child if
a command times out or the pipe fails. The frame association still requires
Windows validation with repeated, reverse, static, and video-backed seeks
before this route can be treated as a
production renderer.

Electron API references: [offscreen rendering](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering),
[shared texture structure](https://www.electronjs.org/docs/latest/api/structures/offscreen-shared-texture),
and [native texture lifecycle](https://github.com/electron/electron/blob/main/shell/browser/osr/README.md).

## Validation

`node --test packages/electron-host/test/*.test.cjs` runs bounded transfer and
protocol tests. Set `VELOCAST_ELECTRON_TEST_BINARY` to an absolute Electron binary
path to additionally run the real software host test. It verifies exact BGRA and
alpha-composited pixels, static repeat equality, changed pixels, resized geometry,
and release/close cleanup, including genuine black frames and same-size reload.
By default it starts 25 fresh hosts sequentially to catch startup races; set
`VELOCAST_ELECTRON_TEST_REPEATS` to an integer from 1 to 100 to adjust this bounded
stress check. Run it without simultaneous rendering workloads.

Native owns a Windows Job Object or isolated Unix process group for lifecycle
cleanup. Windows cancellation/timeout tests run with the native suite; the Unix
process-group test runs in the hosted Linux/macOS native suites.

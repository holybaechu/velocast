"use strict";

// This file is Electron's main process. The composition only runs in the sandboxed
// page. Native commands and GPU handles never enter that page or an Electron preload.
const { app, BrowserWindow } = require("electron/main");
const fs = require("node:fs");
const {
  MAX_LINE_BYTES,
  MAX_QUEUED_COMMANDS,
  parseCommand,
  loadUrl,
  parseScriptTitle,
  textureMetadata,
} = require("./protocol.cjs");
const { TextureLease } = require("./texture-lease.cjs");
const { NativeEncodeSession } = require("./native-encode.cjs");
const { SoftwareFrameLease, byteLength } = require("./software-frame.cjs");
const { resolveCaptureFrameRate } = require("./capture-rate.cjs");
const { configureProfileDirectory } = require("./profile-directory.cjs");

const LOAD_TIMEOUT_MS = 14_000;
const SCRIPT_TIMEOUT_MS = 4_500;
const PAINT_TIMEOUT_MS = 1_800;
const LEASE_TIMEOUT_MS = 10_000;

const surfaceMode = process.env.VELOCAST_ELECTRON_SURFACE_MODE || "accelerated";
if (!["software", "accelerated"].includes(surfaceMode)) {
  throw new Error("Invalid Electron surface mode");
}
const software = surfaceMode === "software";
const captureFormat = process.env.VELOCAST_ELECTRON_CAPTURE_FORMAT || "bgra";
if (
  !["bgra", "nv12"].includes(captureFormat) ||
  (software && captureFormat !== "bgra")
) {
  throw new Error("Invalid Electron capture format for surface mode");
}
// Older protocol-1 controllers do not provide an owned profile directory.
// Keep their existing startup behavior; updated controllers always isolate it.
if (process.env.VELOCAST_ELECTRON_PROFILE_DIRECTORY !== undefined)
  configureProfileDirectory(
    app,
    process.env.VELOCAST_ELECTRON_PROFILE_DIRECTORY,
  );
// This must happen before app.whenReady and before any renderer process exists.
if (software) app.disableHardwareAcceleration();
const softwareFrames = software
  ? new SoftwareFrameLease(process.env.VELOCAST_ELECTRON_FRAME_DIRECTORY)
  : null;
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("disable-background-timer-throttling");

let window = null;
let paintWaiter = null;
let titleWaiter = null;
let closed = false;
let textureSequence = 0;
let leaseTimer = null;
let inputStream = null;
const leases = new TextureLease();
const nativeEncode = new NativeEncodeSession({
  leases,
  addonPath: process.env.VELOCAST_NATIVE_ENCODER_ADDON,
  captureFormat,
});
const debug = (...parts) => {
  if (process.env.VELOCAST_ELECTRON_HOST_DEBUG === "1") {
    process.stderr.write(`[electron-host] ${parts.join(" ")}\n`);
  }
};

function deadline(work, milliseconds, description) {
  let timer;
  return Promise.race([
    work,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${description} timed out`)),
        milliseconds,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

function releaseTexture(texture) {
  if (texture) texture.release();
}

function abortPending(error) {
  if (paintWaiter) {
    const waiter = paintWaiter;
    paintWaiter = null;
    clearTimeout(waiter.timer);
    clearTimeout(waiter.retryTimer);
    waiter.reject(error);
  }
  if (titleWaiter) {
    const waiter = titleWaiter;
    titleWaiter = null;
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
}

function cleanup() {
  debug("cleanup entered");
  if (closed) return;
  closed = true;
  abortPending(new Error("Electron host closed"));
  clearTimeout(leaseTimer);
  leaseTimer = null;
  inputStream?.destroy();
  inputStream = null;
  // An unresponsive GPU worker must not keep an orphaned host alive forever.
  // End the process on a hard deadline; never fake completion or release a
  // texture that native GPU commands may still be reading. The coordinator also
  // contains and terminates the full Electron process tree on request failure.
  const shutdownWatchdog = setTimeout(() => {
    process.stderr.write(
      "Electron native cleanup timed out; terminating host\n",
    );
    app.exit(1);
  }, 5_000);
  shutdownWatchdog.unref();
  void (async () => {
    try {
      await nativeEncode.abort();
    } catch (error) {
      process.stderr.write(`${error}\n`);
    } finally {
      await leases.waitForIdle();
      try {
        leases.releaseAll();
        softwareFrames?.releaseAll();
      } catch (error) {
        process.stderr.write(`${error}\n`);
      }
      if (window && !window.isDestroyed()) window.destroy();
      window = null;
      clearTimeout(shutdownWatchdog);
      debug("cleanup exit process");
      app.exit(0);
    }
  })();
}

function positiveSize(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 16384) {
    throw new Error(`Invalid ${name}: expected an integer from 1 to 16384`);
  }
  return value;
}

function browser() {
  if (!window || window.isDestroyed())
    throw new Error("Electron browser has not been loaded");
  return window.webContents;
}

function onPaint(event, dirtyRect, image) {
  if (software) {
    releaseTexture(event.texture);
    const waiter = paintWaiter;
    if (!waiter || !image || image.isEmpty()) return;
    const size = image.getSize(1);
    if (
      size.width !== waiter.request.expectedWidth ||
      size.height !== waiter.request.expectedHeight
    ) {
      waiter.staleSizePaints++;
      schedulePaintRetry(waiter);
      return;
    }
    paintWaiter = null;
    clearTimeout(waiter.timer);
    clearTimeout(waiter.retryTimer);
    try {
      const metadata = softwareFrames.capture(image, waiter.request);
      if (waiter.request.copy) armLeaseTimeout();
      waiter.resolve(metadata);
    } catch (error) {
      waiter.reject(error);
    }
    return;
  }
  debug(
    "paint event",
    JSON.stringify(Object.keys(event)),
    `texture=${!!event.texture}`,
  );
  const texture = event.texture;
  const waiter = paintWaiter;
  if (!waiter) {
    releaseTexture(texture);
    return;
  }
  const staleSize =
    texture &&
    waiter.request.expectedWidth !== undefined &&
    (texture.textureInfo?.visibleRect?.width !== waiter.request.expectedWidth ||
      texture.textureInfo?.visibleRect?.height !==
        waiter.request.expectedHeight);
  if (!texture || staleSize) {
    // Chromium can emit a null texture before its GPU pool is ready, or a
    // texture from the old viewport while a resize is settling.
    if (staleSize) {
      waiter.staleSizePaints++;
      releaseTexture(texture);
    } else {
      waiter.missingGpuPaints++;
    }
    schedulePaintRetry(waiter);
    return;
  }
  paintWaiter = null;
  clearTimeout(waiter.timer);
  clearTimeout(waiter.retryTimer);
  try {
    const textureId = `${waiter.request.generation}:${++textureSequence}`;
    const metadata = textureMetadata(
      texture.textureInfo,
      waiter.request,
      textureId,
      captureFormat,
    );
    metadata.dirtyRect = dirtyRect;
    if (waiter.request.copy) {
      leases.retain(textureId, texture, metadata);
      armLeaseTimeout();
    } else {
      releaseTexture(texture);
    }
    if (captureFormat === "nv12") {
      // The native addon imports this process-local handle directly. The
      // controller only needs the lease token and actual texture properties.
      const { handle, ...publicMetadata } = metadata;
      waiter.resolve(publicMetadata);
    } else {
      waiter.resolve(metadata);
    }
  } catch (error) {
    releaseTexture(texture);
    waiter.reject(error);
  }
}

function schedulePaintRetry(waiter) {
  if (waiter.retryTimer) return;
  waiter.retryTimer = setTimeout(() => {
    waiter.retryTimer = null;
    if (paintWaiter === waiter && window && !window.isDestroyed())
      browser().invalidate();
  }, 50);
}

function armLeaseTimeout() {
  leaseTimer = setTimeout(() => {
    process.stderr.write("Electron frame release timed out\n");
    cleanup();
  }, LEASE_TIMEOUT_MS);
}

function onTitle(_event, title) {
  if (!titleWaiter) return;
  const result = parseScriptTitle(title, titleWaiter.token);
  if (!result) return;
  const waiter = titleWaiter;
  titleWaiter = null;
  clearTimeout(waiter.timer);
  if (result.ok) waiter.resolve(result.result);
  else waiter.reject(new Error(result.error));
}

function waitForTitle(token) {
  if (titleWaiter)
    throw new Error("Electron host already has a script in flight");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (titleWaiter?.token !== token) return;
      titleWaiter = null;
      reject(new Error("Electron script result timed out"));
      if (window && !window.isDestroyed()) {
        window.webContents
          .executeJavaScript(
            `window.__velocastRenderer?.cancel(${JSON.stringify(token)});`,
          )
          .catch(() => {});
      }
    }, SCRIPT_TIMEOUT_MS);
    titleWaiter = { token, timer, resolve, reject };
  });
}

async function captureSoftware(request) {
  if (softwareFrames.occupied)
    throw new Error("Release the previous software frame first");
  const contents = browser();
  const [width, height] = window.getContentSize();
  await deadline(
    contents.executeJavaScript(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))",
    ),
    PAINT_TIMEOUT_MS,
    "Electron software compositor fence",
  );
  // OSR invalidate() synchronously emits CompositeFrame from its cached backing
  // bitmap. It does not request a new compositor frame. capturePage instead
  // resolves this request through OSR CopyFromSurface/CopyFromCompositingSurface.
  const image = await deadline(
    contents.capturePage(
      { x: 0, y: 0, width, height },
      { stayHidden: true, stayAwake: true },
    ),
    PAINT_TIMEOUT_MS,
    "Electron software compositor copy",
  );
  if (closed) throw new Error("Electron host closed during software capture");
  const size = image.getSize(1);
  if (
    image.isEmpty() ||
    size.width !== (request.expectedWidth ?? width) ||
    size.height !== (request.expectedHeight ?? height)
  ) {
    throw new Error(
      "Electron software compositor copy returned invalid dimensions",
    );
  }
  const metadata = softwareFrames.capture(image, request);
  if (request.copy) armLeaseTimeout();
  return metadata;
}

async function waitForPaint(request) {
  if (software && request.copy) return captureSoftware(request);
  if (software) {
    // Observation fences establish the loaded/resized surface before capture.
    // Pixel-bearing requests use captureSoftware's correlated compositor copy;
    // a paint notification alone can still contain cached prior-frame pixels.
    await deadline(
      browser().executeJavaScript(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))",
      ),
      PAINT_TIMEOUT_MS,
      "Electron software compositor fence",
    );
  }
  if (paintWaiter)
    throw new Error("Electron host already has a paint in flight");
  if (leases.occupied || softwareFrames?.occupied)
    throw new Error("Electron host must release the previous texture first");
  const [width, height] = window.getContentSize();
  request.expectedWidth ??= width;
  request.expectedHeight ??= height;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (paintWaiter?.request !== request) return;
      const missingGpuPaints = paintWaiter.missingGpuPaints;
      const staleSizePaints = paintWaiter.staleSizePaints;
      clearTimeout(paintWaiter.retryTimer);
      paintWaiter = null;
      reject(
        new Error(
          `Electron ${surfaceMode} paint timed out (${missingGpuPaints} null textures, ${staleSizePaints} old-size textures)`,
        ),
      );
    }, PAINT_TIMEOUT_MS);
    paintWaiter = {
      request,
      timer,
      resolve,
      reject,
      missingGpuPaints: 0,
      staleSizePaints: 0,
      retryTimer: null,
    };
    try {
      // Invalidate alone can produce a software paint with no shared texture
      // when the composition is unchanged. Restarting the offscreen capturer
      // requests a fresh GPU texture without changing page pixels or layout.
      if (!software) {
        browser().stopPainting();
        browser().startPainting();
      }
      browser().invalidate();
    } catch (error) {
      paintWaiter = null;
      clearTimeout(timer);
      reject(error);
    }
  });
}

async function commandLoad(command) {
  debug("load begin", command.url);
  if (leases.occupied || softwareFrames?.occupied)
    throw new Error("Release the shared texture before loading");
  const url = loadUrl(command.url);
  const captureFrameRate = resolveCaptureFrameRate(
    process.env.VELOCAST_ELECTRON_CAPTURE_FPS,
  );
  const width = positiveSize(command.width, "browser width");
  const height = positiveSize(command.height, "browser height");
  if (software) byteLength(width, height);
  abortPending(new Error("Electron browser is loading another page"));
  if (!window || window.isDestroyed()) {
    window = new BrowserWindow({
      show: false,
      width,
      height,
      useContentSize: true,
      frame: false,
      backgroundColor: "#000000",
      webPreferences: {
        offscreen: {
          useSharedTexture: !software,
          ...(captureFormat === "nv12"
            ? { sharedTexturePixelFormat: "nv12" }
            : {}),
        },
        backgroundThrottling: false,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webviewTag: false,
        // Preserve the renderer's Windows generic monospace resolution. Electron otherwise
        // uses Courier New and canvas text differs even with the same source.
        ...(process.platform === "win32"
          ? { defaultFontFamily: { monospace: "Consolas" } }
          : {}),
      },
    });
    const contents = window.webContents;
    debug("created browser", `offscreen=${contents.isOffscreen()}`);
    contents.setFrameRate(captureFrameRate);
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("paint", onPaint);
    contents.on("page-title-updated", onTitle);
    contents.on("render-process-gone", (_event, details) => {
      process.stderr.write(`Electron renderer exited: ${details.reason}\n`);
      cleanup();
    });
    window.on("closed", () => cleanup());
  } else {
    window.setContentSize(width, height);
  }
  await deadline(window.loadURL(url), LOAD_TIMEOUT_MS, "Electron page load");
  if (software) {
    // loadURL resolves before the offscreen output device has presented its
    // first surface. Consume that size-matched startup paint before ACKing load;
    // otherwise the first correlated capture can receive the initial blank
    // viewport even after its animation-frame fence. This observation transfers
    // no bitmap bytes and accepts legitimate black/transparent compositions.
    await waitForPaint({
      generation: 0,
      copy: false,
      expectedWidth: width,
      expectedHeight: height,
    });
  }
  debug("load complete");
  if (process.env.VELOCAST_ELECTRON_HOST_DEBUG === "1") {
    const gpuInfo = await app.getGPUInfo("complete");
    debug(
      "gpu info",
      gpuInfo.auxAttributes?.glRenderer,
      `shared=${gpuInfo.auxAttributes?.supportsD3dSharedImages}`,
    );
    debug("gpu status after load", JSON.stringify(app.getGPUFeatureStatus()));
  }
  return {};
}

async function commandExecute(command) {
  if (typeof command.script !== "string")
    throw new Error("Electron execute requires script text");
  const contents = browser();
  if (command.token === undefined) {
    // Setup scripts can evaluate to objects with functions (the browser runtime
    // itself does). Do not ask Electron to clone those values into the main process.
    await deadline(
      contents.executeJavaScript(`${command.script}\n;undefined`),
      SCRIPT_TIMEOUT_MS,
      "Electron script",
    );
    return {};
  }
  if (typeof command.token !== "string" || !command.token) {
    throw new Error("Electron execute token must be a nonempty string");
  }
  const titleResult = waitForTitle(command.token);
  // The existing browser runtime publishes the completion through document.title.
  // Keep the evaluation rejection observable, but let the exact-token title be
  // the sole completion signal. A stale title from another seek cannot finish it.
  contents.executeJavaScript(command.script).catch((error) => {
    if (titleWaiter?.token === command.token) {
      const waiter = titleWaiter;
      titleWaiter = null;
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  });
  return { result: await titleResult };
}

async function dispatch(command) {
  switch (command.method) {
    case "load":
      return commandLoad(command);
    case "execute":
      return commandExecute(command);
    case "invalidate": {
      if (software || leases.occupied || paintWaiter)
        throw new Error(
          "GPU preparation requires an idle, released capture surface",
        );
      // The native loop discards this preparation paint. Submit it without
      // waiting for a paint that capture would discard. Actual frame
      // acceptance still goes through all generation/size/settling fences.
      const contents = browser();
      contents.stopPainting();
      contents.startPainting();
      contents.invalidate();
      return { queued: true };
    }
    case "resize": {
      if (leases.occupied || softwareFrames?.occupied)
        throw new Error("Release the shared texture before resizing");
      const width = positiveSize(command.width, "browser width");
      const height = positiveSize(command.height, "browser height");
      if (software) byteLength(width, height);
      browser();
      window.setContentSize(width, height);
      // Wait for a size-matched composition paint before adapter init.
      // Without this fence, Electron can capture the pre-init black surface
      // forever when subsequent seeks leave an initialized canvas unchanged.
      await waitForPaint({
        generation: 0,
        copy: false,
        expectedWidth: width,
        expectedHeight: height,
      });
      return {};
    }
    case "paint": {
      if (
        !Number.isSafeInteger(command.generation) ||
        command.generation < 0 ||
        typeof command.copy !== "boolean"
      ) {
        throw new Error(
          "Electron paint requires a safe generation and copy boolean",
        );
      }
      browser();
      return waitForPaint(command);
    }
    case "release": {
      if (software) {
        softwareFrames.release(command.softwareFrameId);
        clearTimeout(leaseTimer);
        leaseTimer = null;
        return {};
      }
      if (typeof command.textureId !== "string") {
        throw new Error("Electron release requires textureId");
      }
      leases.release(command.textureId);
      clearTimeout(leaseTimer);
      leaseTimer = null;
      return {};
    }
    case "beginNativeEncode":
      return nativeEncode.begin(command.config);
    case "encodeNativeFrame": {
      try {
        return await nativeEncode.encode(command);
      } finally {
        if (!leases.occupied) {
          clearTimeout(leaseTimer);
          leaseTimer = null;
        }
      }
    }
    case "finishNativeEncode":
      return nativeEncode.finish();
    case "abortNativeEncode":
      try {
        return await nativeEncode.abort();
      } finally {
        leases.releaseAll();
        if (!leases.occupied) {
          clearTimeout(leaseTimer);
          leaseTimer = null;
        }
      }
    case "close":
      return {};
    default:
      throw new Error("Unsupported Electron host method");
  }
}

async function writeLine(value) {
  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
    throw new Error("Electron host response exceeds 4 MiB");
  }
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      process.stdout.off("error", onError);
      reject(error);
    };
    process.stdout.once("error", onError);
    process.stdout.write(line, (error) => {
      process.stdout.off("error", onError);
      if (error) reject(error);
      else resolve();
    });
  });
}

const queue = [];
let processing = false;
async function processQueue() {
  if (processing) return;
  processing = true;
  while (queue.length && !closed) {
    const command = queue.shift();
    debug("dispatch", command.id, command.method);
    let response;
    try {
      response = { id: command.id, ok: true, ...(await dispatch(command)) };
    } catch (error) {
      response = {
        id: command.id,
        ok: false,
        error: String(error?.message || error),
      };
    }
    try {
      await writeLine(response);
    } catch (error) {
      process.stderr.write(`Electron host output failed: ${error}\n`);
      cleanup();
      break;
    }
    if (command.method === "close") {
      debug("close response written");
      cleanup();
    }
  }
  processing = false;
}

function enqueue(line) {
  debug("line", line.length);
  let command;
  try {
    command = parseCommand(line);
    if (queue.length >= MAX_QUEUED_COMMANDS) {
      throw new Error("Electron host command queue is full");
    }
  } catch (error) {
    process.stderr.write(`${error}\n`);
    cleanup();
    return;
  }
  queue.push(command);
  void processQueue();
}

function listenForCommands() {
  // Electron's Windows GUI process exposes a dummy process.stdin Readable even
  // when fd 0 is a real inherited pipe. Reading fd 0 directly receives JSONL.
  const input = fs.createReadStream(null, { fd: 0, autoClose: true });
  inputStream = input;
  let pending = Buffer.alloc(0);
  input.on("data", (chunk) => {
    debug("stdin bytes", chunk.length);
    pending = Buffer.concat([pending, chunk]);
    if (pending.length > MAX_LINE_BYTES && pending.indexOf(10) === -1) {
      process.stderr.write("Electron host input line exceeds 4 MiB\n");
      cleanup();
      return;
    }
    let newline;
    while ((newline = pending.indexOf(10)) !== -1 && !closed) {
      const line = pending
        .subarray(0, newline)
        .toString("utf8")
        .replace(/\r$/, "");
      pending = pending.subarray(newline + 1);
      enqueue(line);
    }
  });
  input.on("end", cleanup);
  input.on("error", cleanup);
  process.stdout.on("error", cleanup);
  input.resume();
  debug("stdin resumed");
}

app
  .whenReady()
  .then(async () => {
    if (!software && process.platform !== "win32") {
      throw new Error(
        "Electron shared-texture host currently supports Windows only",
      );
    }
    await writeLine({
      event: "ready",
      version: 1,
      pid: process.pid,
      surfaceMode,
      captureFormat,
      nativeEncode: captureFormat === "nv12",
      asyncPaintInvalidation: !software,
    });
    listenForCommands();
  })
  .catch((error) => {
    process.stderr.write(`Electron host startup failed: ${error}\n`);
    cleanup();
  });

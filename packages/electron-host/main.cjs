"use strict";

// This file is Electron's main process. The composition stays in a sandboxed
// page without native commands or GPU handles. The optional trusted encoder
// preload lives in a separate window that never loads composition content.
const { app, BrowserWindow } = require("electron/main");
const { NativeCapture } = require("./native-capture.cjs");
const fs = require("node:fs");
const {
  MAX_LINE_BYTES,
  MAX_QUEUED_COMMANDS,
  parseCommand,
  loadUrl,
  parseScriptTitle,
} = require("./protocol.cjs");
const { SoftwareFrameLease, byteLength } = require("./software-frame.cjs");
const { configureProfileDirectory } = require("./profile-directory.cjs");

const LOAD_TIMEOUT_MS = 14_000;
const SCRIPT_TIMEOUT_MS = 4_500;
const SNAPSHOT_TIMEOUT_MS = 1_800;
const LEASE_TIMEOUT_MS = 10_000;

const surfaceMode = process.env.VELOCAST_ELECTRON_SURFACE_MODE || "webcodecs";
if (!["software", "webcodecs"].includes(surfaceMode)) {
  throw new Error("Invalid Electron surface mode");
}
const software = surfaceMode === "software";
const webcodecs = surfaceMode === "webcodecs";
// Electron's capability status is usable only after its first GPU info update.
let gpuInfoAvailable = false;
let titleWaiter = null;
app.on("gpu-info-update", () => {
  gpuInfoAvailable = true;
});
let webcodecsEncoder = null;
// Older protocol-1 controllers do not provide an owned profile directory.
// Keep their existing startup behavior; updated controllers always isolate it.
if (process.env.VELOCAST_ELECTRON_PROFILE_DIRECTORY !== undefined)
  configureProfileDirectory(
    app,
    process.env.VELOCAST_ELECTRON_PROFILE_DIRECTORY,
  );
// Software audit output is an explicit readback of native capture, not a capture fallback.
let nativeCapture = null;
const softwareFrames = software
  ? new SoftwareFrameLease(process.env.VELOCAST_ELECTRON_FRAME_DIRECTORY)
  : null;
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("disable-background-timer-throttling");

let window = null;
let closed = false;
let leaseTimer = null;
let inputStream = null;
let snapshotViewport = null;
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

function abortPending(error) {
  if (titleWaiter) {
    const waiter = titleWaiter;
    titleWaiter = null;
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
}

async function cleanup() {
  debug("cleanup entered");
  if (closed) return;
  closed = true;
  abortPending(new Error("Electron host closed"));
  nativeCapture?.dispose();
  clearTimeout(leaseTimer);
  leaseTimer = null;
  inputStream?.destroy();
  inputStream = null;
  try {
    await webcodecsEncoder?.dispose();
    softwareFrames?.releaseAll();
  } catch (error) {
    process.stderr.write(`${error}\n`);
  }
  if (window && !window.isDestroyed()) window.destroy();
  window = null;
  debug("cleanup exit process");
  app.exit(0);
  debug("app.exit returned");
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

function gpuCompositorFailure() {
  if (!gpuInfoAvailable) return null;
  const status = app.getGPUFeatureStatus().gpu_compositing;
  return status === "disabled_software" || status === "unavailable_software"
    ? new Error(`capture.compositor_unavailable: ${status}`)
    : null;
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
  if (!snapshotViewport)
    throw new Error("capture.snapshot_viewport_unavailable");
  const { width, height } = snapshotViewport;
  const result = await encoderHost().transfer(
    await captureNative(width, height),
    {
      method: "bitmap",
      width,
      height,
    },
  );
  const pixels = Buffer.from(result.pixels);
  if (pixels.length !== byteLength(width, height))
    throw new Error("capture.invalid_native_bitmap");
  const metadata = softwareFrames.capture(
    {
      getSize: () => ({ width, height }),
      toBitmap: () => pixels,
    },
    request,
  );
  if (request.copy) armLeaseTimeout();
  return metadata;
}

function snapshotDebugger() {
  const debuggerSession = browser().debugger;
  if (!debuggerSession.isAttached()) debuggerSession.attach();
  return debuggerSession;
}

async function setSnapshotViewport(width, height) {
  await deadline(
    snapshotDebugger().sendCommand("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    }),
    SNAPSHOT_TIMEOUT_MS,
    "Electron snapshot viewport override",
  );
  const actual = await deadline(
    browser().executeJavaScript("({width: innerWidth, height: innerHeight})"),
    SNAPSHOT_TIMEOUT_MS,
    "Electron snapshot viewport measurement",
  );
  if (actual?.width !== width || actual?.height !== height)
    throw new Error(
      `capture.invalid_snapshot_viewport: expected ${width}x${height}, received ${actual?.width}x${actual?.height}`,
    );
  snapshotViewport = { width, height };
}

async function captureNative(width, height) {
  const failure = gpuCompositorFailure();
  if (failure) throw failure;
  if (!nativeCapture) throw new Error("capture.shared_texture_unavailable");
  return nativeCapture.capture(width, height);
}

function encoderHost() {
  const { WebCodecsHost } = require("./webcodecs-host.cjs");
  webcodecsEncoder ??= new WebCodecsHost(
    process.env.VELOCAST_ELECTRON_FRAME_DIRECTORY,
  );
  return webcodecsEncoder;
}

async function commandLoad(command) {
  debug("load begin", command.url);
  if (softwareFrames?.occupied)
    throw new Error("Release the software frame before loading");
  const url = loadUrl(command.url);
  const width = positiveSize(command.width, "browser width");
  const height = positiveSize(command.height, "browser height");
  if (software) byteLength(width, height);
  abortPending(new Error("Electron browser is loading another page"));
  const initialCompositorFailure = gpuCompositorFailure();
  if (initialCompositorFailure) throw initialCompositorFailure;
  if (!window || window.isDestroyed()) {
    window = new BrowserWindow({
      show: false,
      width,
      height,
      useContentSize: true,
      enableLargerThanScreen: true,
      frame: false,
      backgroundColor: "#000000",
      webPreferences: {
        offscreen: { useSharedTexture: true },
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
    nativeCapture = new NativeCapture(contents);
    // Avoid the default 60 Hz wait for authoring readiness and forced redraws.
    // This affects compositor scheduling, not encoded frame timestamps.
    contents.setFrameRate(240);
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("page-title-updated", onTitle);
    contents.on("render-process-gone", (_event, details) => {
      process.stderr.write(`Electron renderer exited: ${details.reason}\n`);
      cleanup();
    });
    window.on("closed", () => cleanup());
  }
  // Some window managers clamp constructor bounds to the display work area.
  // Apply the requested offscreen viewport explicitly before observing it.
  window.setContentSize(width, height);
  await deadline(window.loadURL(url), LOAD_TIMEOUT_MS, "Electron page load");
  const loadedCompositorFailure = gpuCompositorFailure();
  if (loadedCompositorFailure) throw loadedCompositorFailure;
  await setSnapshotViewport(width, height);
  nativeCapture.resetSource();
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
    case "webcodecs-open": {
      if (!webcodecs || webcodecsEncoder?.settings)
        throw new Error("webcodecs.invalid_open");
      const { WebCodecsHost } = require("./webcodecs-host.cjs");
      webcodecsEncoder ??= new WebCodecsHost(
        process.env.VELOCAST_ELECTRON_FRAME_DIRECTORY,
      );
      return {
        config: await webcodecsEncoder.open(command.settings, command.audio),
      };
    }
    case "media-operation": {
      if (!webcodecsEncoder) {
        const { WebCodecsHost } = require("./webcodecs-host.cjs");
        webcodecsEncoder = new WebCodecsHost(
          process.env.VELOCAST_ELECTRON_FRAME_DIRECTORY,
        );
      }
      return webcodecsEncoder.mediaOperation(command.operation);
    }
    case "png": {
      const { absolute } = require("./media-io.cjs");
      const [physicalWidth, physicalHeight] = window.getContentSize();
      const width = positiveSize(
        command.expectedWidth ?? snapshotViewport?.width ?? physicalWidth,
        "PNG width",
      );
      const height = positiveSize(
        command.expectedHeight ?? snapshotViewport?.height ?? physicalHeight,
        "PNG height",
      );
      byteLength(width, height);
      if (
        snapshotViewport &&
        (snapshotViewport.width !== width || snapshotViewport.height !== height)
      )
        throw new Error("media.invalid_png_geometry");
      return encoderHost().transfer(await captureNative(width, height), {
        method: "png",
        outputPath: absolute(command.outputPath),
        width,
        height,
      });
    }

    case "webcodecs-frame": {
      if (
        !webcodecs ||
        !webcodecsEncoder ||
        command.index !== webcodecsEncoder.frames ||
        !Number.isSafeInteger(command.index) ||
        command.index < 0
      )
        throw new Error("webcodecs.invalid_sequence");
      if (
        !Number.isSafeInteger(command.frame) ||
        command.frame < 0 ||
        command.frame > 0xffffffff ||
        typeof command.token !== "string" ||
        !command.token ||
        command.frame !== webcodecsEncoder.settings.startFrame + command.index
      )
        throw new Error("capture.invalid_frame_identity");
      // The serialized host queue owns this entire transaction. A failed seek
      // cannot capture, and Chromium acknowledges the redraw/copy before encoding.
      await commandExecute(command);
      const { width, height } = webcodecsEncoder.settings;
      if (
        snapshotViewport?.width !== width ||
        snapshotViewport?.height !== height
      )
        throw new Error("capture.invalid_snapshot_viewport");
      const texture = await captureNative(width, height);
      return {
        ...(await webcodecsEncoder.encode(
          texture,
          command.index,
          command.frame,
          command.token,
        )),
        frame: command.frame,
        token: command.token,
        width,
        height,
        captureBackend: "electron_shared_texture",
        cpuReadback: false,
      };
    }

    case "webcodecs-finish": {
      if (!webcodecs || !webcodecsEncoder)
        throw new Error("webcodecs.invalid_finish");
      return webcodecsEncoder.finish();
    }
    case "load":
      return commandLoad(command);
    case "execute":
      return commandExecute(command);
    case "resize": {
      if (softwareFrames?.occupied)
        throw new Error("Release the software frame before resizing");
      const width = positiveSize(command.width, "browser width");
      const height = positiveSize(command.height, "browser height");
      if (software) byteLength(width, height);
      const compositorFailure = gpuCompositorFailure();
      if (compositorFailure) throw compositorFailure;
      browser();
      window.setContentSize(width, height);
      // Keep the logical viewport pinned to the requested composition geometry.
      await setSnapshotViewport(width, height);

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
      if (!software) throw new Error("capture.streaming_paint_unsupported");
      return captureSoftware({
        generation: command.generation,
        copy: command.copy,
      });
    }
    case "release": {
      if (software) {
        softwareFrames.release(command.softwareFrameId);
        clearTimeout(leaseTimer);
        leaseTimer = null;
        return {};
      }
      throw new Error("WebCodecs frame ownership is internal to Electron");
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
    await writeLine({
      event: "ready",
      version: 5,
      pid: process.pid,
      surfaceMode,
    });
    listenForCommands();
  })
  .catch((error) => {
    process.stderr.write(`Electron host startup failed: ${error}\n`);
    cleanup();
  });

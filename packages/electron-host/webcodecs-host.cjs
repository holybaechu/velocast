"use strict";

const { BrowserWindow, ipcMain } = require("electron/main");
const fs = require("node:fs");
const path = require("node:path");
const { absolute } = require("./media-io.cjs");
const { mediaSettings } = require("./media-settings.cjs");
const { frameTiming } = require("./webcodecs-codec.cjs");
const TIMEOUT_MS = 300_000;

class WebCodecsHost {
  constructor(directory) {
    if (
      !path.isAbsolute(directory || "") ||
      !fs.lstatSync(directory).isDirectory()
    ) {
      throw new Error("webcodecs.invalid_directory");
    }
    this.directory = directory;
    this.window = null;
    this.pending = null;
    this.sequence = 0;
    this.frames = 0;
    this.bytes = 0;
    this.finished = false;
    this.onResult = (event, message) => {
      if (
        event.sender !== this.window?.webContents ||
        event.senderFrame !== event.sender.mainFrame
      )
        return;
      const pending = this.pending;
      if (!pending || message?.id !== pending.id) return;
      message.error
        ? pending.reject(new Error(message.error))
        : pending.resolve(message.result);
    };
    ipcMain.on("velocast:webcodecs:result", this.onResult);
  }

  wait(id) {
    if (this.pending) throw new Error("webcodecs.busy");
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("webcodecs.timeout")),
        TIMEOUT_MS,
      );
      this.pending = { id, resolve, reject, timer };
    });
    return promise.finally(() => {
      clearTimeout(this.pending?.timer);
      this.pending = null;
    });
  }

  async initialize() {
    if (this.window) return;
    this.window = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "webcodecs-preload.cjs"),
        additionalArguments: this.utilityOnly
          ? [`--velocast-${this.utilityOnly}-utility`]
          : [],
        // Only this fixed local page loads media libraries; authored pages stay sandboxed.
        sandbox: false,
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
        webviewTag: false,
      },
    });
    this.window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    this.window.webContents.on("will-navigate", (event) =>
      event.preventDefault(),
    );
    this.window.webContents.on("will-attach-webview", (event) =>
      event.preventDefault(),
    );
    this.window.webContents.on("render-process-gone", (_event, details) =>
      this.pending?.reject(
        new Error(
          `webcodecs.renderer_exited: ${details.reason} (exit ${details.exitCode})`,
        ),
      ),
    );
    this.window.webContents.on("preload-error", (_event, _path, error) =>
      this.pending?.reject(
        new Error(`webcodecs.preload_failed: ${error.message}`),
      ),
    );
    const ready = this.wait(0);
    const onReady = (event) => {
      if (
        event.sender === this.window?.webContents &&
        event.senderFrame === event.sender.mainFrame
      ) {
        this.pending?.resolve();
      }
    };
    ipcMain.on("velocast:webcodecs:ready", onReady);
    try {
      await Promise.all([
        ready,
        this.window.loadFile(path.join(__dirname, "webcodecs.html")),
      ]);
    } finally {
      ipcMain.off("velocast:webcodecs:ready", onReady);
    }
  }

  async open(settings, audio) {
    if (this.settings) throw new Error("webcodecs.already_open");
    const selected = mediaSettings(settings);
    if (
      !Number.isSafeInteger(settings.startFrame) ||
      settings.startFrame < 0 ||
      settings.startFrame > 0xffffffff
    )
      throw new Error("webcodecs.invalid_start_frame");
    this.settings = settings;
    this.audio = audio;
    this.file = absolute(settings.outputPath);
    this.videoFile = audio
      ? path.join(this.directory, `encoded-video.${selected.container}`)
      : this.file;
    await this.initialize();
    const config = await this.command("open", {
      ...settings,
      outputPath: this.videoFile,
    });
    this.config = config;
    return { ...config, cpuReadback: true };
  }

  command(method, settings) {
    const id = ++this.sequence;
    const result = this.wait(id);
    try {
      this.window.webContents.send("velocast:webcodecs:command", {
        id,
        method,
        settings,
      });
    } catch (error) {
      this.pending.reject(error);
    }
    return result;
  }

  async encode(png, index, frame, token) {
    if (!this.config || this.finished || index !== this.frames)
      throw new Error("webcodecs.invalid_sequence");
    const result = await this.command("frame", { png, index, frame, token });
    this.validateAcknowledgement(
      result,
      index,
      frameTiming(index, this.settings.fps),
    );
    if (result.frame !== frame || result.token !== token)
      throw new Error("capture.invalid_frame_acknowledgement");
    this.frames++;
    this.colorSpace = result.colorSpace;
    return result;
  }

  async finish() {
    if (!this.config || this.finished)
      throw new Error("webcodecs.invalid_finish");
    const result = await this.command("finish");
    if (result.frames !== this.frames || !this.frames)
      throw new Error("webcodecs.frame_count_mismatch");
    this.colorSpace = result.colorSpace ?? this.colorSpace;
    const metadata = this.audio
      ? await this.mediaOperation({
          kind: "mux-audio-plan",
          videoPath: this.videoFile,
          outputPath: this.file,
          audio: this.audio,
          audioCodec: this.settings.audioCodec,
          container: this.config.container,
          fps: this.settings.fps,
          mediaBackend: "native",
        })
      : result;
    if (
      metadata.video?.frameCount !== this.frames ||
      metadata.video.width !== this.settings.width ||
      metadata.video.height !== this.settings.height
    )
      throw new Error("webcodecs.invalid_final_media");
    this.finished = true;
    if (this.audio) fs.rmSync(this.videoFile, { force: true });
    return {
      ...metadata,
      frames: this.frames,
      colorSpace: this.colorSpace,
      backend: this.config.backend,
      pixelFormat: this.config.pixelFormat,
    };
  }

  async mediaOperation(operation) {
    // Native decoders/audio encoders register global Mediabunny extensions.
    // Isolate them from the GPU video renderer's codec registry.
    if (operation.kind === "encode-frames") {
      const encoder = new WebCodecsHost(this.directory);
      encoder.utilityOnly = "frame";
      try {
        await encoder.initialize();
        return await encoder.command("media-operation", operation);
      } finally {
        await encoder.dispose();
      }
    }
    if (!this.utility) {
      this.utility = new WebCodecsHost(this.directory);
      this.utility.utilityOnly = "media";
      await this.utility.initialize();
    }
    return this.utility.command("media-operation", operation);
  }

  validateAcknowledgement(result, index, timing) {
    if (
      result.index !== index ||
      result.timestamp !== timing.timestamp ||
      result.duration !== timing.duration ||
      result.frames !== index + 1 ||
      !Number.isSafeInteger(result.encodedFrames) ||
      result.encodedFrames < (this.encodedFrames ?? 0) ||
      result.encodedFrames > index + 1
    )
      throw new Error("media.invalid_acknowledgement");
    this.encodedFrames = result.encodedFrames;
  }

  async dispose() {
    this.pending?.reject(new Error("webcodecs.closed"));
    ipcMain.off("velocast:webcodecs:result", this.onResult);
    try {
      await this.utility?.dispose();
    } finally {
      if (this.window && !this.window.isDestroyed()) this.window.destroy();
      this.window = null;
      if (!this.finished && this.config) {
        fs.rmSync(this.videoFile, {
          force: true,
          maxRetries: 8,
          retryDelay: 50,
        });
      }
    }
  }
}

module.exports = { WebCodecsHost };

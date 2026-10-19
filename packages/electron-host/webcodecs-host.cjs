"use strict";

const { BrowserWindow, ipcMain, sharedTexture } = require("electron/main");
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
    this.leases = new Set();
    this.peakTextureLeases = 0;
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
        // sharedTexture is unavailable in a sandboxed preload. Only this fixed,
        // empty local page has a full preload; it never loads authored content.
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
    return config;
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

  async encode(texture, index) {
    let imported;
    try {
      if (!this.config || this.finished || index !== this.frames)
        throw new Error("webcodecs.invalid_sequence");
      // Do not await every release: encoders may retain frames until later
      // submissions or finalization. Backpressure bounds live GPU leases.
      if (this.leases.size >= 32)
        await this.deadline(Promise.race(this.leases));
      const id = ++this.sequence;
      let releaseDone;
      const released = new Promise((resolve) => {
        releaseDone = resolve;
      });
      this.leases.add(released);
      this.peakTextureLeases = Math.max(
        this.peakTextureLeases,
        this.leases.size,
      );
      try {
        imported = sharedTexture.importSharedTexture({
          textureInfo: texture.textureInfo,
          allReferencesReleased: () => {
            texture.release();
            this.leases.delete(released);
            releaseDone();
          },
        });
      } catch (error) {
        this.leases.delete(released);
        throw new Error(`capture.shared_texture_unavailable: ${error.message}`);
      }
      const packet = this.wait(id);
      // Observe transfer and encode errors together; never leave an unhandled
      // rejected acknowledgement behind if importing/transferring fails.
      const transferred = Promise.resolve()
        .then(() =>
          sharedTexture.sendSharedTexture(
            {
              frame: this.window.webContents.mainFrame,
              importedSharedTexture: imported,
            },
            { id, index },
          ),
        )
        .catch((error) => {
          throw new Error(
            `capture.shared_texture_unavailable: ${error.message}`,
          );
        })
        .finally(() => imported.release());
      const [result] = await Promise.all([packet, transferred]);
      const timing = frameTiming(index, this.settings.fps);
      this.validateAcknowledgement(result, index, timing);
      this.frames++;
      this.colorSpace = result.colorSpace;
      return result;
    } catch (error) {
      this.pending?.reject(error);
      if (!imported) texture.release();
      // Once imported, only allReferencesReleased may release the OSR source.
      // Request failure terminates the contained host and its GPU process.
      throw error;
    }
  }

  async finish() {
    if (!this.config || this.finished)
      throw new Error("webcodecs.invalid_finish");
    const result = await this.command("finish");
    // Finalization must happen before waiting for the encoder's last leases.
    await this.deadline(Promise.all(this.leases));
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
      peakTextureLeases: this.peakTextureLeases,
      outstandingTextureLeases: this.leases.size,
    };
  }

  deadline(work) {
    let timer;
    return Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("webcodecs.texture_release_timeout")),
          10000,
        );
      }),
    ]).finally(() => clearTimeout(timer));
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

"use strict";

const { BrowserWindow, ipcMain, sharedTexture } = require("electron/main");
const fs = require("node:fs");
const path = require("node:path");
const { mb, absolute, outputFile, probe } = require("./media-io.cjs");
const {
  encoderConfig,
  frameTiming,
  MAX_PACKET_BYTES,
} = require("./webcodecs-codec.cjs");
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
    this.window.webContents.on("render-process-gone", () =>
      this.pending?.reject(new Error("webcodecs.renderer_exited")),
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
    encoderConfig(settings);
    this.settings = settings;
    this.audio = audio;
    this.file = absolute(settings.outputPath);
    this.videoFile = audio
      ? path.join(this.directory, "encoded-video.mp4")
      : this.file;
    await this.initialize();
    const config = await this.command("open", settings);
    this.sink = outputFile(this.videoFile);
    this.source = new mb.EncodedVideoPacketSource(
      config.logicalCodec === "h264" ? "avc" : config.logicalCodec,
    );
    this.sink.output.addVideoTrack(this.source, { frameRate: settings.fps });
    await this.sink.output.start();
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
      if (!this.sink || this.finished || index !== this.frames)
        throw new Error("webcodecs.invalid_sequence");
      const id = ++this.sequence;
      let releaseDone;
      const released = new Promise((resolve) => {
        releaseDone = resolve;
      });
      try {
        imported = sharedTexture.importSharedTexture({
          textureInfo: texture.textureInfo,
          allReferencesReleased: () => {
            texture.release();
            releaseDone();
          },
        });
      } catch (error) {
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
      if (
        result.index !== index ||
        result.timestamp !== timing.timestamp ||
        result.duration !== timing.duration ||
        !(result.data instanceof Uint8Array) ||
        result.data.byteLength < 1 ||
        result.data.byteLength > MAX_PACKET_BYTES
      ) {
        throw new Error("webcodecs.invalid_packet");
      }
      // Only compressed bytes cross into Node. AVCC/HEVC/AV1 decoder metadata,
      // including the encoder's actual color space, travels into the MP4 track.
      await this.source.add(
        new mb.EncodedPacket(
          result.data,
          result.type,
          result.timestamp / 1e6,
          result.duration / 1e6,
        ),
        result.metadata,
      );
      this.bytes += result.data.byteLength;
      const releaseWait = this.wait(++this.sequence);
      const releasePending = this.pending;
      released.then(() => releasePending.resolve());
      await releaseWait;
      this.frames++;
      this.colorSpace = result.colorSpace;
      return {
        index,
        ...timing,
        bytes: result.data.byteLength,
        frames: this.frames,
        colorSpace: this.colorSpace,
      };
    } catch (error) {
      if (!imported) texture.release();
      // Once imported, only allReferencesReleased may release the OSR source.
      // Native request failure terminates the contained host and its GPU process.
      throw error;
    }
  }

  async finish() {
    if (!this.sink || this.finished)
      throw new Error("webcodecs.invalid_finish");
    const result = await this.command("finish");
    if (result.frames !== this.frames || !this.frames)
      throw new Error("webcodecs.frame_count_mismatch");
    this.source.close();
    await this.sink.output.finalize();
    this.sink.close();
    const metadata = this.audio
      ? await this.command("media-operation", {
          kind: "mux-audio-plan",
          videoPath: this.videoFile,
          outputPath: this.file,
          audio: this.audio,
        })
      : await probe({ path: this.file });
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
    };
  }

  async encodeBitmap(data, index) {
    if (
      !this.sink ||
      this.finished ||
      index !== this.frames ||
      data.byteLength !== this.settings.width * this.settings.height * 4
    )
      throw new Error("webcodecs.invalid_bitmap");
    const result = await this.command("bitmap", {
      data,
      index,
      width: this.settings.width,
      height: this.settings.height,
    });
    const timing = frameTiming(index, this.settings.fps);
    if (
      result.index !== index ||
      result.timestamp !== timing.timestamp ||
      result.duration !== timing.duration ||
      !(result.data instanceof Uint8Array) ||
      result.data.byteLength < 1 ||
      result.data.byteLength > MAX_PACKET_BYTES
    )
      throw new Error("webcodecs.invalid_packet");
    await this.source.add(
      new mb.EncodedPacket(
        result.data,
        result.type,
        result.timestamp / 1e6,
        result.duration / 1e6,
      ),
      result.metadata,
    );
    this.frames++;
    this.bytes += result.data.byteLength;
    this.colorSpace = result.colorSpace;
    return {
      index,
      ...timing,
      frames: this.frames,
      bytes: result.data.byteLength,
      colorSpace: this.colorSpace,
    };
  }

  dispose() {
    this.pending?.reject(new Error("webcodecs.closed"));
    ipcMain.off("velocast:webcodecs:result", this.onResult);
    this.sink?.close();
    if (!this.finished && this.sink) fs.rmSync(this.videoFile, { force: true });
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }
}

module.exports = { WebCodecsHost };

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Buffer } = require("node:buffer");
const { setImmediate } = require("node:timers");
const { fork } = require("node:child_process");
const { encoderConfig, frameTiming } = require("./webcodecs-codec.cjs");
const TIMEOUT_MS = 300_000;

async function bounded(work, timeout, message) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// The regular Node child inherits the host's process group/job. IPC disconnect
// also terminates it if its Electron owner disappears.
class NativeVideoClient {
  constructor() {
    this.sequence = 0;
    this.frames = 0;
    this.stderr = "";
    this.closed = false;
    this.pending = null;
    this.busy = false;
  }

  start() {
    const binary = process.env.VELOCAST_NODE_BINARY;
    if (!binary || !path.isAbsolute(binary) || !fs.statSync(binary).isFile())
      throw new Error(
        "media.node_binary_required: VELOCAST_NODE_BINARY must name an absolute regular Node executable",
      );
    const env = { ...process.env };
    for (const name of [
      "ELECTRON_RUN_AS_NODE",
      "NODE_OPTIONS",
      "NODE_PATH",
      "LD_PRELOAD",
      "DYLD_INSERT_LIBRARIES",
    ])
      delete env[name];
    if (
      typeof this.settings.outputPath !== "string" ||
      !path.isAbsolute(this.settings.outputPath)
    )
      throw new Error("media.absolute_path_required");
    // Reserve ownership before the child can crash. The inherited descriptor
    // avoids reopening the destination and preserves an existing file with wx.
    const outputFd = fs.openSync(this.settings.outputPath, "wx", 0o600);
    this.outputOwned = true;
    try {
      this.child = fork(path.join(__dirname, "native-video-worker.cjs"), [], {
        execPath: binary,
        execArgv: [],
        env,
        serialization: "json",
        stdio: ["pipe", "ignore", "pipe", "ipc", outputFd],
        windowsHide: true,
        detached: false,
      });
    } finally {
      fs.closeSync(outputFd);
    }
    this.joined = new Promise((resolve) => {
      this.child.once("exit", (code, signal) => {
        this.exited = true;
        this.exitStatus = { code, signal };
        // Allow IPC already queued with the final response to be delivered.
        // We own/destroy pipe ends in stop; disconnect need not emit close.
        setImmediate(() => {
          if (!this.terminalReply || this.pending || code !== 0)
            this.fail(
              new Error(
                `media.native_worker_exited: ${code ?? signal}${this.stderr ? `\n${this.stderr}` : ""}`,
              ),
            );
          process.removeListener("exit", this.parentExit);
          resolve();
        });
      });
      this.child.once("error", (error) => {
        this.fail(error);
        if (!this.child.pid) {
          this.exited = true;
          resolve();
        }
      });
    });
    this.parentExit = () => this.child?.kill("SIGKILL");
    process.once("exit", this.parentExit);
    this.child.stderr.on("data", (bytes) => {
      this.stderr = (this.stderr + bytes.toString()).slice(-65536);
    });
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.on("message", (message) => {
      const pending = this.pending;
      if (
        !pending ||
        message?.id !== pending.id ||
        typeof message.ok !== "boolean"
      ) {
        this.fail(
          new Error("media.native_worker_protocol: unexpected response"),
        );
        this.abort();
        return;
      }
      this.pending = null;
      clearTimeout(pending.timer);
      if (message.ok) {
        if (pending.method === "finish" || pending.method === "cancel")
          this.terminalReply = true;
        pending.resolve(message.result);
      } else
        pending.reject(
          new Error(`media.native_worker_error: ${String(message.error)}`),
        );
    });
  }

  fail(error) {
    this.failure ??= error;
    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  async request(method, payload, pixels) {
    if (this.pending) throw new Error("media.busy");
    if (this.closed || this.failure || !this.child?.connected)
      throw this.failure ?? new Error("media.native_worker_closed");
    const id = ++this.sequence;
    try {
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => this.fail(new Error(`media.native_worker_timeout: ${method}`)),
          TIMEOUT_MS,
        );
        this.pending = { id, method, resolve, reject, timer };
      });
      const written = new Promise((resolve, reject) => {
        try {
          this.child.send({ id, method, payload }, (error) => {
            if (error) {
              this.fail(error);
              reject(error);
            } else if (pixels) {
              // Raw pixels use a byte stream: Electron and stock Node can use
              // different V8 serialization versions, even for Uint8Arrays.
              this.child.stdin.write(
                Buffer.from(
                  pixels.buffer,
                  pixels.byteOffset,
                  pixels.byteLength,
                ),
                (error) => {
                  if (error) {
                    this.fail(error);
                    reject(error);
                  } else resolve();
                },
              );
            } else resolve();
          });
        } catch (error) {
          this.fail(error);
          reject(error);
        }
      });
      const [result] = await Promise.all([
        response,
        bounded(
          written,
          TIMEOUT_MS,
          `media.native_worker_write_timeout: ${method}`,
        ),
      ]);
      return result;
    } catch (error) {
      await this.stop(true);
      throw error;
    }
  }

  stop(force = false) {
    if (force) this.discard = true;
    if (force && this.child && !this.exited) this.child.kill("SIGKILL");
    this.closed = true;
    this.stopping ??= (async () => {
      if (!this.child) return;
      try {
        try {
          await bounded(
            this.joined,
            1000,
            "media.native_worker_shutdown_timeout",
          );
        } catch {
          this.child.kill("SIGKILL");
          await bounded(this.joined, 5000, "media.native_worker_join_timeout");
        }
      } finally {
        process.removeListener("exit", this.parentExit);
        this.child.stdin?.destroy();
        this.child.stderr?.destroy();
        if (this.child.connected) this.child.disconnect();
      }
    })();
    return this.stopping.then(() => {
      if (this.discard && this.outputOwned && !this.finished) {
        fs.rmSync(this.settings.outputPath, { force: true });
        this.outputOwned = false;
      }
    });
  }

  abort() {
    this.fail(new Error("media.native_worker_cancelled"));
    void this.stop(true).catch(() => {});
  }

  async open(settings) {
    if (this.settings || this.closed) throw new Error("media.already_open");
    encoderConfig({ ...settings, codec: "av1" });
    this.settings = { ...settings };
    try {
      this.start();
      this.config = await this.request("open", this.settings);
      if (this.config?.backend !== "native")
        throw new Error("media.native_worker_invalid_config");
      return this.config;
    } catch (error) {
      await this.stop(true);
      throw error;
    }
  }

  async encodeBitmap({ data, index, width, height, format = "BGRA", timing }) {
    if (this.busy) throw new Error("media.busy");
    this.busy = true;
    try {
      if (
        !this.config ||
        this.finished ||
        index !== this.frames ||
        width !== this.settings.width ||
        height !== this.settings.height ||
        !(data instanceof Uint8Array) ||
        data.byteLength !== width * height * 4 ||
        !["BGRA", "RGBA"].includes(format)
      )
        throw new Error("media.invalid_bitmap");
      timing ??= frameTiming(index, this.settings.fps);
      if (
        !Number.isSafeInteger(timing.timestamp) ||
        timing.timestamp < 0 ||
        !Number.isSafeInteger(timing.duration) ||
        timing.duration <= 0
      )
        throw new Error("media.invalid_timing");
      const result = await this.request(
        "frame",
        {
          byteLength: data.byteLength,
          index,
          format,
          timing,
        },
        data,
      );
      if (
        result?.index !== index ||
        result.frames !== index + 1 ||
        result.timestamp !== timing.timestamp ||
        result.duration !== timing.duration ||
        !Number.isSafeInteger(result.encodedFrames) ||
        result.encodedFrames < 0 ||
        result.encodedFrames > index + 1
      )
        throw new Error("media.invalid_acknowledgement");
      this.frames++;
      return result;
    } catch (error) {
      await this.stop(true);
      throw error;
    } finally {
      this.busy = false;
    }
  }

  async encode(imported, index, timing) {
    if (this.busy) {
      imported.release();
      throw new Error("media.busy");
    }
    let frame;
    try {
      if (!this.settings) throw new Error("media.invalid_sequence");
      frame = imported.getVideoFrame();
      const { width, height } = this.settings;
      if (frame.displayWidth !== width || frame.displayHeight !== height)
        throw new Error("media.invalid_geometry");
      this.canvas ??= new OffscreenCanvas(width, height);
      const context = this.canvas.getContext("2d", {
        willReadFrequently: true,
      });
      context.drawImage(frame, 0, 0);
      const pixels = context.getImageData(0, 0, width, height).data;
      return await this.encodeBitmap({
        data: new Uint8Array(
          pixels.buffer,
          pixels.byteOffset,
          pixels.byteLength,
        ),
        index,
        width,
        height,
        format: "RGBA",
        timing,
      });
    } catch (error) {
      await this.stop(true);
      throw error;
    } finally {
      frame?.close();
      imported.release();
    }
  }

  async finish() {
    if (this.busy || !this.frames || this.finished)
      throw new Error("media.invalid_finish");
    try {
      const result = await this.request("finish");
      if (result?.frames !== this.frames)
        throw new Error("media.frame_count_mismatch");
      await this.stop();
      if (this.exitStatus?.code !== 0)
        throw this.failure ?? new Error("media.native_worker_failed_shutdown");
      this.finished = true;
      return result;
    } catch (error) {
      await this.stop(true);
      throw error;
    }
  }

  async cancel() {
    if (this.closed) return this.stop(true);
    if (this.pending || this.busy) {
      this.fail(new Error("media.native_worker_cancelled"));
      return this.stop(true);
    }
    this.discard = true;
    try {
      if (this.child?.connected && !this.failure) await this.request("cancel");
    } finally {
      await this.stop();
    }
  }
}

module.exports = { NativeVideoClient };

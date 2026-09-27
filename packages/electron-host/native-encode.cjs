"use strict";

const path = require("node:path");

function nonnegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(
      `Electron native encode requires a nonnegative safe ${name}`,
    );
  return value;
}

function jsonObject(value, name) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`Electron native encoder returned invalid ${name} JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`Electron native encoder returned invalid ${name}`);
  return parsed;
}

class NativeEncodeSession {
  #leases;
  #addonPath;
  #captureFormat;
  #loadAddon;
  #encoder = null;

  constructor({ leases, addonPath, captureFormat, loadAddon = require }) {
    this.#leases = leases;
    this.#addonPath = addonPath;
    this.#captureFormat = captureFormat;
    this.#loadAddon = loadAddon;
  }

  get active() {
    return this.#encoder !== null;
  }

  async begin(config) {
    if (this.#captureFormat !== "nv12")
      throw new Error("Native encode requires NV12 Electron capture");
    if (this.#encoder)
      throw new Error("Electron native encoder is already active");
    if (this.#leases.occupied)
      throw new Error(
        "Release the shared texture before beginning native encode",
      );
    if (!config || typeof config !== "object" || Array.isArray(config))
      throw new Error("Electron native encode requires a config object");
    if (
      typeof this.#addonPath !== "string" ||
      !path.isAbsolute(this.#addonPath)
    )
      throw new Error("VELOCAST_NATIVE_ENCODER_ADDON must be an absolute path");
    const addon = this.#loadAddon(this.#addonPath);
    if (typeof addon?.NativeEncoder !== "function")
      throw new Error(
        "Electron native encoder addon has no NativeEncoder class",
      );
    const encoder = new addon.NativeEncoder(JSON.stringify(config));
    this.#encoder = encoder;
    try {
      return { report: jsonObject(await encoder.ready(), "ready report") };
    } catch (error) {
      this.#encoder = null;
      await encoder.abort().catch(() => {});
      throw error;
    }
  }

  async encode(command) {
    const encoder = this.#encoder;
    if (!encoder) throw new Error("Electron native encoder has not begun");
    const textureId = command.textureId;
    if (typeof textureId !== "string" || !textureId)
      throw new Error("Electron native encode requires textureId");
    const generation = nonnegativeInteger(command.generation, "generation");
    const frame = nonnegativeInteger(command.frame, "frame");
    const pts = nonnegativeInteger(command.pts, "pts");
    return this.#leases.consume(textureId, async (metadata) => {
      if (
        !metadata ||
        metadata.generation !== generation ||
        metadata.textureId !== textureId ||
        metadata.pixelFormat !== "nv12" ||
        typeof metadata.handle !== "string"
      ) {
        throw new Error(
          "Electron native encode texture does not match its capture generation",
        );
      }
      const input = {
        handle: metadata.handle,
        textureWidth: metadata.textureWidth,
        textureHeight: metadata.textureHeight,
        sourceRect: metadata.sourceRect,
        width: metadata.width,
        height: metadata.height,
        pixelFormat: metadata.pixelFormat,
        colorSpace: metadata.colorSpace,
        frame,
        pts,
      };
      return {
        stats: jsonObject(
          await encoder.encodeFrame(JSON.stringify(input)),
          "frame stats",
        ),
      };
    });
  }

  async finish() {
    const encoder = this.#encoder;
    if (!encoder) throw new Error("Electron native encoder has not begun");
    if (this.#leases.occupied)
      throw new Error(
        "Release the shared texture before finishing native encode",
      );
    try {
      const report = jsonObject(await encoder.finish(), "final report");
      this.#encoder = null;
      return { report };
    } catch (error) {
      this.#encoder = null;
      await encoder.abort().catch(() => {});
      throw error;
    }
  }

  async abort() {
    const encoder = this.#encoder;
    this.#encoder = null;
    if (encoder) await encoder.abort();
    return {};
  }
}

module.exports = { NativeEncodeSession };

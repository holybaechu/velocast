"use strict";

const fs = require("node:fs");
const path = require("node:path");
const MAX_FRAME_BYTES = 256 * 1024 * 1024;

function byteLength(width, height) {
  const length = width * height * 4;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width <= 0 || height <= 0 || width > 16384 || height > 16384 ||
      !Number.isSafeInteger(length) || length > MAX_FRAME_BYTES) {
    throw new Error("Electron software frame exceeds bounded BGRA geometry");
  }
  return length;
}

// Native owns this private directory and removes it even if Electron is killed.
// One fixed filename and one lease avoid paths from page content or the pipe.
class SoftwareFrameLease {
  constructor(directory) {
    if (typeof directory !== "string" || !path.isAbsolute(directory) ||
        !fs.lstatSync(directory).isDirectory()) {
      throw new Error("Electron software frame directory must be an existing absolute directory");
    }
    this.file = path.join(directory, "frame.bgra");
    this.id = null;
    this.sequence = 0;
  }

  get occupied() { return this.id !== null; }

  capture(image, request) {
    if (this.occupied) throw new Error("Electron software frame already retained");
    const { width, height } = image.getSize(1);
    const length = byteLength(width, height);
    const metadata = {
      generation: request.generation, width, height,
      pixelFormat: "bgra", byteLength: length,
    };
    if (!request.copy) return metadata;
    // Electron 44 toBitmap returns packed sRGB N32 premultiplied pixels, matching
    // the renderer's software surface. Keep alpha bytes intact.
    const pixels = image.toBitmap({ scaleFactor: 1 });
    if (!Buffer.isBuffer(pixels) || pixels.length !== length) {
      throw new Error("Electron software bitmap has an invalid byte length");
    }
    const id = `${request.generation}:${++this.sequence}`;
    const descriptor = fs.openSync(this.file, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, pixels);
    } catch (error) {
      // openSync succeeded, so this attempt owns the partial file.
      fs.closeSync(descriptor);
      fs.rmSync(this.file, { force: true });
      throw error;
    }
    fs.closeSync(descriptor);
    this.id = id;
    return { ...metadata, softwareFrameId: id };
  }

  release(id) {
    if (!this.occupied || id !== this.id) throw new Error("Unknown Electron software frame lease");
    fs.unlinkSync(this.file);
    this.id = null;
  }

  releaseAll() {
    if (this.occupied) {
      fs.rmSync(this.file, { force: true });
      this.id = null;
    }
  }
}

module.exports = { SoftwareFrameLease, byteLength, MAX_FRAME_BYTES };

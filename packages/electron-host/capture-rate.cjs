"use strict";

const DEFAULT_CAPTURE_FPS = 1000;
// Electron 44 divides 1,000,000 by this value for a microsecond interval.
// A larger value would round that compositor interval down to zero.
const MAX_CAPTURE_FPS = 1_000_000;

function resolveCaptureFrameRate(value) {
  if (value === undefined || value.trim() === "") return DEFAULT_CAPTURE_FPS;
  const text = value.trim();
  const fps = Number(text);
  if (
    !/^[1-9]\d*$/.test(text) ||
    !Number.isSafeInteger(fps) ||
    fps > MAX_CAPTURE_FPS
  ) {
    throw new Error(
      "VELOCAST_ELECTRON_CAPTURE_FPS must be an integer from 1 to 1000000; Electron has no unlimited value (0 means 1 fps)",
    );
  }
  return fps;
}

module.exports = { DEFAULT_CAPTURE_FPS, resolveCaptureFrameRate };

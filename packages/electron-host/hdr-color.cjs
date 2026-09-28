"use strict";
// BT.2100 PQ/HLG EOTFs and BT.2020 NCL coefficients. Pixel plane layout follows
// WebCodecs §9.8: 10/12-bit planar samples are little-endian, low-bit aligned.
// https://www.itu.int/rec/R-REC-BT.2100
// https://www.w3.org/TR/webcodecs/#pixel-format
function pqNits(value) {
  const p = Math.max(0, Math.min(1, value)) ** (1 / (2523 / 32));
  return (
    10000 *
    (Math.max(p - 3424 / 4096, 0) / (2413 / 128 - (2392 / 128) * p)) **
      (1 / (2610 / 16384))
  );
}
function hlgScene(value) {
  const v = Math.max(0, value),
    a = 0.17883277,
    b = 1 - 4 * a,
    c = 0.5 - a * Math.log(4 * a);
  return v <= 0.5 ? (v * v) / 3 : (Math.exp((v - c) / a) + b) / 12;
}
function hdrToRgba({ bytes, layouts, format, width, height, colorSpace }) {
  const match = /^I(420|422|444)P(10|12)$/.exec(format ?? "");
  if (
    !match ||
    !["pq", "hlg"].includes(colorSpace.transfer) ||
    colorSpace.primaries !== "bt2020" ||
    colorSpace.matrix !== "bt2020-ncl" ||
    typeof colorSpace.fullRange !== "boolean"
  ) {
    throw new Error(
      `media.hdr_tonemap_unavailable: requires readable planar 10/12-bit BT.2020 NCL PQ/HLG; received ${format}`,
    );
  }
  if (
    !Number.isSafeInteger(width * height) ||
    width < 1 ||
    height < 1 ||
    width * height * 4 > 256 * 1024 * 1024 ||
    layouts.length !== 3
  )
    throw new Error("media.invalid_hdr_geometry");
  const depth = Number(match[2]),
    scale = 2 ** (depth - 8),
    maximum = 2 ** depth - 1;
  const divisorX = match[1] === "444" ? 1 : 2,
    divisorY = match[1] === "420" ? 2 : 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    rgba = new Uint8ClampedArray(width * height * 4);
  const read = (plane, x, y) =>
    view.getUint16(
      layouts[plane].offset + y * layouts[plane].stride + x * 2,
      true,
    );
  const srgb = (x) =>
    x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const cx = Math.floor(x / divisorX),
        cy = Math.floor(y / divisorY);
      const luma = colorSpace.fullRange
        ? read(0, x, y) / maximum
        : (read(0, x, y) - 16 * scale) / (219 * scale);
      const u =
        (read(1, cx, cy) - 128 * scale) /
        (colorSpace.fullRange ? maximum : 224 * scale);
      const v =
        (read(2, cx, cy) - 128 * scale) /
        (colorSpace.fullRange ? maximum : 224 * scale);
      const encoded = [
        luma + 1.4746 * v,
        luma - 0.1645531268 * u - 0.5713531268 * v,
        luma + 1.8814 * u,
      ];
      let linear;
      if (colorSpace.transfer === "pq") linear = encoded.map(pqNits);
      else {
        const scene = encoded.map(hlgScene),
          luminance = 0.2627 * scene[0] + 0.678 * scene[1] + 0.0593 * scene[2];
        // BT.2100 reference HLG display: 1000 cd/m² peak, system gamma 1.2.
        const ootf = 1000 * Math.max(luminance, 0) ** 0.2;
        linear = scene.map((value) => value * ootf);
      }
      const [r, g, b] = linear;
      const rgb = [
        1.660491 * r - 0.587641 * g - 0.07285 * b,
        -0.12455 * r + 1.1329 * g - 0.008349 * b,
        -0.018151 * r - 0.100579 * g + 1.11873 * b,
      ];
      // Luminance-preserving extended Reinhard: 203-nit diffuse reference and
      // 1000-nit mastering white. This is an explicit SDR rendering policy,
      // independent of the monitor and browser's implicit Canvas HDR clipping.
      const luminance = Math.max(
        0,
        (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 203,
      );
      const white = 1000 / 203,
        mapped =
          (luminance * (1 + luminance / (white * white))) / (1 + luminance);
      const factor = luminance > 0 ? mapped / luminance / 203 : 0;
      const offset = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++)
        rgba[offset + channel] = Math.round(
          255 * srgb(Math.max(0, Math.min(1, rgb[channel] * factor))),
        );
      rgba[offset + 3] = 255;
    }
  return rgba;
}
async function toneMapFrame(frame) {
  const rect = frame.visibleRect;
  const bytes = new Uint8Array(frame.allocationSize());
  const layouts = await frame.copyTo(bytes);
  return {
    data: hdrToRgba({
      bytes,
      layouts,
      format: frame.format,
      width: rect.width,
      height: rect.height,
      colorSpace: frame.colorSpace,
    }),
    width: rect.width,
    height: rect.height,
  };
}
module.exports = { hdrToRgba, toneMapFrame, pqNits, hlgScene };

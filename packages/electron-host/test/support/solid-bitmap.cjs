"use strict";

module.exports = function solidBitmap(width, height, color) {
  const bmp = Buffer.alloc(54 + width * height * 3);
  bmp.write("BM");
  bmp.writeUInt32LE(bmp.length, 2);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(width, 18);
  bmp.writeInt32LE(height, 22);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(24, 28);
  for (let index = 54; index < bmp.length; index += 3)
    bmp[index + (color === "red" ? 2 : 0)] = 255;
  return bmp;
};

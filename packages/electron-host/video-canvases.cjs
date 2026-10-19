"use strict";
const mb = require("mediabunny");

// Native decoders may omit color fields carried only by the container. Restore
// those fields before Chromium converts the YUV planes to canvas RGB.
async function* videoCanvases(track, start) {
  const width = await track.getDisplayWidth(),
    height = await track.getDisplayHeight();
  const rotation = await track.getRotation(),
    flip = await track.getFlip();
  const containerColor = await track.getColorSpace();
  const canvases = [
    new OffscreenCanvas(width, height),
    new OffscreenCanvas(width, height),
  ];
  let index = 0;
  for await (const sample of new mb.VideoSampleSink(track).samples(start)) {
    let corrected;
    const canvas = canvases[index++ % canvases.length];
    const timing = { timestamp: sample.timestamp, duration: sample.duration };
    try {
      const colorSpace = {};
      let needsColor = false;
      for (const key of ["primaries", "transfer", "matrix", "fullRange"]) {
        colorSpace[key] = sample.colorSpace[key] ?? containerColor?.[key];
        needsColor ||=
          sample.colorSpace[key] == null && containerColor?.[key] != null;
      }
      if (needsColor && sample.format) {
        const options = {
          rect: {
            x: 0,
            y: 0,
            width: sample.codedWidth,
            height: sample.codedHeight,
          },
        };
        const data = new Uint8Array(sample.allocationSize(options));
        const layout = await sample.copyTo(data, options);
        corrected = new mb.VideoSample(data, {
          format: sample.format,
          codedWidth: sample.codedWidth,
          codedHeight: sample.codedHeight,
          displayWidth: sample.squarePixelWidth,
          displayHeight: sample.squarePixelHeight,
          visibleRect: sample.visibleRect,
          ...timing,
          colorSpace,
          layout,
        });
      }
      const context = canvas.getContext("2d", {
        alpha: false,
        willReadFrequently: true,
      });
      context.fillStyle = "black";
      context.fillRect(0, 0, width, height);
      (corrected ?? sample).drawWithFit(context, {
        fit: "fill",
        rotation,
        flip,
      });
    } finally {
      corrected?.close();
      sample.close();
    }
    yield { canvas, ...timing };
  }
}
module.exports = { videoCanvases };

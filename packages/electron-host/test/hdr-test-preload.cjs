"use strict";
const { ipcRenderer } = require("electron/renderer");
const { toneMapFrame } = require("../hdr-color.cjs");
const { mb, inputFile, outputFile } = require("../media-io.cjs");
const { runMediaOperation } = require("../media-runtime.cjs");
const path = require("node:path"),
  fs = require("node:fs");
(async () => {
  const results = [];
  for (const transfer of ["pq", "hlg"]) {
    const bytes = new Uint16Array(12);
    bytes.fill(512);
    bytes[0] = bytes[1] = bytes[4] = bytes[5] = 64;
    bytes[3] = bytes[7] = 723;
    const frame = new VideoFrame(bytes, {
      format: "I420P10",
      codedWidth: 4,
      codedHeight: 2,
      timestamp: 0,
      colorSpace: {
        primaries: "bt2020",
        transfer,
        matrix: "bt2020-ncl",
        fullRange: false,
      },
    });
    try {
      const value = await toneMapFrame(frame);
      const canvas = new OffscreenCanvas(4, 2),
        context = canvas.getContext("2d", {
          colorSpace: "srgb",
          colorType: "float16",
          toneMapping: { mode: "extended" },
        });
      context.drawImage(frame, 0, 0);
      const floats = context.getImageData(0, 0, 4, 2, {
        pixelFormat: "rgba-float16",
      }).data;
      results.push({
        transfer,
        format: frame.format,
        pixels: [...value.data],
        floats: [...floats],
        attributes: context.getContextAttributes(),
      });
    } finally {
      frame.close();
    }
  }
  const compressed = [];
  for (const transfer of ["pq", "hlg"]) {
    const config = {
      codec: "av01.0.04M.10",
      width: 64,
      height: 64,
      bitrate: 500000,
      framerate: 1,
      hardwareAcceleration: "prefer-software",
    };
    if (!(await VideoEncoder.isConfigSupported(config)).supported) {
      compressed.push({ transfer, supported: false });
      continue;
    }
    const file = path.join(
        process.env.VELOCAST_HDR_TEST_DIRECTORY,
        `${transfer}.mp4`,
      ),
      sink = outputFile(file);
    const source = new mb.EncodedVideoPacketSource("av1");
    sink.output.addVideoTrack(source);
    await sink.output.start();
    const writes = [];
    let failure;
    const encoder = new VideoEncoder({
      output(chunk, metadata) {
        writes.push(
          source.add(mb.EncodedPacket.fromEncodedChunk(chunk), metadata),
        );
      },
      error(error) {
        failure = error;
      },
    });
    encoder.configure(config);
    const bytes = new Uint16Array((64 * 64 * 3) / 2);
    bytes.fill(512);
    bytes.fill(transfer === "pq" ? 509 : 502, 0, 64 * 64);
    const frame = new VideoFrame(bytes, {
      format: "I420P10",
      codedWidth: 64,
      codedHeight: 64,
      timestamp: 0,
      duration: 1000000,
      colorSpace: {
        primaries: "bt2020",
        transfer,
        matrix: "bt2020-ncl",
        fullRange: false,
      },
    });
    try {
      encoder.encode(frame, { keyFrame: true });
      await encoder.flush();
      if (failure) throw failure;
      await Promise.all(writes);
      source.close();
      await sink.output.finalize();
      sink.close();
      const outputPath = path.join(
        process.env.VELOCAST_HDR_TEST_DIRECTORY,
        `${transfer}.rgba`,
      );
      const decoded = await runMediaOperation({
        kind: "frame",
        path: file,
        outputPath,
        format: "rgba",
        timestamp: 0,
      });
      compressed.push({
        transfer,
        supported: true,
        ...decoded,
        pixels: [...fs.readFileSync(outputPath).subarray(0, 4)],
      });
    } finally {
      frame.close();
      if (encoder.state !== "closed") encoder.close();
    }
  }
  let external;
  if (process.env.VELOCAST_HDR_TEST_SOURCE) {
    const input = inputFile(process.env.VELOCAST_HDR_TEST_SOURCE);
    try {
      const track = await input.getPrimaryVideoTrack(),
        sample = await new mb.VideoSampleSink(track).getSample(0),
        frame = sample.toVideoFrame();
      try {
        const canvas = new OffscreenCanvas(
            frame.displayWidth,
            frame.displayHeight,
          ),
          context = canvas.getContext("2d", {
            colorSpace: "srgb",
            colorType: "float16",
          });
        context.drawImage(frame, 0, 0);
        const data = context.getImageData(0, 0, canvas.width, canvas.height, {
          colorSpace: "srgb",
          pixelFormat: "rgba-float16",
        }).data;
        let maximum = 0,
          aboveOne = 0;
        for (let i = 0; i < data.length; i += 4)
          for (let channel = 0; channel < 3; channel++) {
            maximum = Math.max(maximum, data[i + channel]);
            if (data[i + channel] > 1) aboveOne++;
          }
        external = {
          format: frame.format,
          attributes: context.getContextAttributes(),
          arrayType: data.constructor.name,
          maximum,
          aboveOne,
        };
      } finally {
        frame.close();
        sample.close();
      }
    } finally {
      input.dispose();
    }
  }
  ipcRenderer.send("hdr-result", { ok: true, results, compressed, external });
})().catch((error) =>
  ipcRenderer.send("hdr-result", {
    ok: false,
    error: String(error.stack || error),
  }),
);

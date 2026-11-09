"use strict";

// Only this fixed, trusted encoder page receives GPU resources.
const { ipcRenderer, sharedTexture } = require("electron/renderer");
const { MediaSession } = require("./media-session.cjs");
const fs = require("node:fs");
const { absolute } = require("./media-io.cjs");
const frameUtility = process.argv.includes("--velocast-frame-utility");
const utilityOnly =
  frameUtility || process.argv.includes("--velocast-media-utility");
const session = utilityOnly ? null : new MediaSession();
const reply = (id, result) =>
  ipcRenderer.send("velocast:webcodecs:result", { id, ...result });
const failure = (id, error) =>
  reply(id, { error: String(error?.message || error) });

sharedTexture.setSharedTextureReceiver(
  async ({ importedSharedTexture }, settings) => {
    const { id, method } = settings;
    let handedOff = false;
    let frame;
    try {
      let result;
      if (method === "frame" && session) {
        handedOff = true; // MediaSession releases even when validation/encoding fails.
        result = await session.encode(importedSharedTexture, settings.index);
        result = { ...result, frame: settings.frame, token: settings.token };
      } else if ((method === "png" || method === "bitmap") && !utilityOnly) {
        frame = importedSharedTexture.getVideoFrame();
        if (
          frame.displayWidth !== settings.width ||
          frame.displayHeight !== settings.height
        )
          throw new Error("capture.invalid_native_geometry");
        // Still/audit output explicitly requests CPU bytes. Video never visits this path.
        const canvas = new OffscreenCanvas(settings.width, settings.height);
        const context = canvas.getContext("2d");
        context.drawImage(frame, 0, 0);
        if (method === "png") {
          const blob = await canvas.convertToBlob({ type: "image/png" });
          const bytes = Buffer.from(await blob.arrayBuffer());
          fs.writeFileSync(absolute(settings.outputPath), bytes, {
            flag: "wx",
            mode: 0o600,
          });
          result = {
            path: settings.outputPath,
            width: settings.width,
            height: settings.height,
            bytes: bytes.length,
            pixelFormat: frame.format,
            captureBackend: "electron_shared_texture",
            cpuReadback: true,
          };
        } else {
          const pixels = context.getImageData(
            0,
            0,
            settings.width,
            settings.height,
          ).data;
          // SoftwareFrameLease's explicit audit contract is premultiplied BGRA.
          for (let i = 0; i < pixels.length; i += 4) {
            const red = pixels[i];
            const alpha = pixels[i + 3] / 255;
            pixels[i] = Math.round(pixels[i + 2] * alpha);
            pixels[i + 1] = Math.round(pixels[i + 1] * alpha);
            pixels[i + 2] = Math.round(red * alpha);
          }
          result = { pixels, width: settings.width, height: settings.height };
        }
      } else throw new Error("webcodecs.invalid_texture_command");
      reply(id, { result });
    } catch (error) {
      failure(id, error);
    } finally {
      frame?.close();
      if (!handedOff) importedSharedTexture.release();
    }
  },
);

ipcRenderer.on(
  "velocast:webcodecs:command",
  async (_event, { id, method, settings }) => {
    try {
      let result;
      if (
        method === "media-operation" &&
        utilityOnly &&
        (frameUtility
          ? settings.kind === "encode-frames"
          : settings.kind !== "encode-frames")
      )
        result = await require("./media-runtime.cjs").runMediaOperation(
          settings,
        );
      else if (method === "open" && session)
        result = await session.open(settings);
      else if (method === "finish" && session) result = await session.finish();
      else throw new Error("webcodecs.invalid_command");
      reply(id, { result });
    } catch (error) {
      failure(id, error);
    }
  },
);
ipcRenderer.send("velocast:webcodecs:ready");

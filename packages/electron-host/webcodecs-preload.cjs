"use strict";

// This preload belongs only to the trusted empty encoder window. Composition
// pages remain sandboxed, without a preload or access to these IPC channels.
const { ipcRenderer, sharedTexture } = require("electron/renderer");
const { CodecSession } = require("./webcodecs-codec.cjs");
const session = new CodecSession(VideoEncoder, VideoFrame);
const reply = (id, result) =>
  ipcRenderer.send("velocast:webcodecs:result", { id, ...result });
const failure = (id, error) =>
  reply(id, { error: String(error?.message || error) });

ipcRenderer.on(
  "velocast:webcodecs:command",
  async (_event, { id, method, settings }) => {
    try {
      const result =
        method === "open"
          ? await session.open(settings)
          : await session.finish();
      reply(id, { result });
    } catch (error) {
      failure(id, error);
    }
  },
);

sharedTexture.setSharedTextureReceiver(
  async ({ importedSharedTexture }, { id, index }) => {
    // Acknowledge transfer immediately; Electron's transfer deadline is 1 second.
    // The separate result message acknowledges bounded encode/flush completion.
    void session.encode(importedSharedTexture, index).then(
      (result) => reply(id, { result }),
      (error) => failure(id, error),
    );
  },
);
ipcRenderer.send("velocast:webcodecs:ready");

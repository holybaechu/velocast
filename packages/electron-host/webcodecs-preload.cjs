"use strict";

// This preload belongs only to the trusted empty encoder window. Composition
// pages remain sandboxed, without a preload or access to these IPC channels.
const { ipcRenderer, sharedTexture } = require("electron/renderer");
const { MediaSession } = require("./media-session.cjs");
const frameUtility = process.argv.includes("--velocast-frame-utility");
const utilityOnly =
  frameUtility || process.argv.includes("--velocast-media-utility");
const session = utilityOnly ? null : new MediaSession();
const reply = (id, result) =>
  ipcRenderer.send("velocast:webcodecs:result", { id, ...result });
const failure = (id, error) =>
  reply(id, { error: String(error?.message || error) });

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

sharedTexture.setSharedTextureReceiver(
  async ({ importedSharedTexture }, { id, index }) => {
    // Acknowledge transfer immediately; Electron's transfer deadline is 1 second.
    // The separate result acknowledges submission/backpressure, not final drain.
    if (!session) {
      importedSharedTexture.release();
      failure(id, new Error("webcodecs.utility_only"));
      return;
    }
    void session.encode(importedSharedTexture, index).then(
      (result) => reply(id, { result }),
      (error) => failure(id, error),
    );
  },
);
ipcRenderer.send("velocast:webcodecs:ready");

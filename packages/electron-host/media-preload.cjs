"use strict";
const { ipcRenderer } = require("electron/renderer");
const { runMediaOperation } = require("./media-runtime.cjs");
ipcRenderer.on(
  "velocast:media:operation",
  async (_event, { id, operation }) => {
    try {
      ipcRenderer.send("velocast:media:result", {
        id,
        ok: true,
        result: await runMediaOperation(operation),
      });
    } catch (error) {
      ipcRenderer.send("velocast:media:result", {
        id,
        ok: false,
        error: String(error?.stack || error),
      });
    }
  },
);
ipcRenderer.send("velocast:media:ready");

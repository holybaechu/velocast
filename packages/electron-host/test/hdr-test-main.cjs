"use strict";
const { app, BrowserWindow, ipcMain } = require("electron/main");
const fs = require("node:fs"),
  path = require("node:path");
app.setPath("userData", process.env.VELOCAST_HDR_TEST_DIRECTORY);
app.setPath("sessionData", process.env.VELOCAST_HDR_TEST_DIRECTORY);
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "hdr-test-preload.cjs"),
      sandbox: false,
      contextIsolation: true,
    },
  });
  ipcMain.once("hdr-result", (_event, result) => {
    fs.writeFileSync(
      path.join(process.env.VELOCAST_HDR_TEST_DIRECTORY, "result.json"),
      JSON.stringify(result),
    );
    window.destroy();
    app.exit(0);
  });
  window.webContents.on("preload-error", (_event, _path, error) => {
    console.error(error);
    app.exit(1);
  });
  await window.loadFile(path.join(__dirname, "../webcodecs.html"));
});

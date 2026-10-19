"use strict";
const { app, BrowserWindow, ipcMain } = require("electron/main");
const fs = require("node:fs");
const path = require("node:path");
const { configureProfileDirectory } = require("./profile-directory.cjs");
configureProfileDirectory(app, process.env.VELOCAST_ELECTRON_PROFILE_DIRECTORY);
let window,
  frameEncoder,
  input,
  active,
  closed = false;
const write = (file, value) => {
  const temporary = `${file}.writing`;
  fs.writeFileSync(temporary, JSON.stringify(value), {
    flag: "wx",
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
};
const exit = (code) => {
  if (closed) return;
  closed = true;
  input?.destroy();
  window?.destroy();
  void Promise.resolve(frameEncoder?.dispose()).finally(() => app.exit(code));
};
app
  .whenReady()
  .then(async () => {
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "media-preload.cjs"),
        sandbox: false,
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
        webviewTag: false,
      },
    });
    const sender = (event) =>
      event.sender === window.webContents &&
      event.senderFrame === event.sender.mainFrame;
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.on("will-attach-webview", (event) =>
      event.preventDefault(),
    );
    window.webContents.on("preload-error", (_event, _path, error) => {
      write(process.env.VELOCAST_MEDIA_READY, {
        ok: false,
        error: error.message,
      });
    });
    window.webContents.on("render-process-gone", () => exit(1));
    ipcMain.on("velocast:media:ready", (event) => {
      if (sender(event)) write(process.env.VELOCAST_MEDIA_READY, { ok: true });
    });
    ipcMain.on("velocast:media:result", (event, result) => {
      if (sender(event) && active && active.id === result.id) {
        write(active.response, result);
        active = null;
      }
    });
    input = fs.createReadStream(null, {
      fd: 0,
      autoClose: true,
      encoding: "utf8",
    });
    let buffer = "";
    input.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 16384) return exit(1);
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          if (active) throw new Error("media.busy");
          const command = JSON.parse(line);
          if (!Number.isSafeInteger(command.id) || command.id < 1)
            throw new Error("media.invalid_id");
          for (const file of [command.request, command.response])
            if (path.dirname(file) !== process.env.VELOCAST_MEDIA_SCRATCH)
              throw new Error("media.invalid_request_path");
          active = command;
          const operation = JSON.parse(
            fs.readFileSync(command.request, "utf8"),
          );
          if (operation.kind === "encode-frames") {
            // A persistent utility may already have registered native decoders.
            // Image-sequence video encoding gets a fresh WebCodecs registry.
            const { WebCodecsHost } = require("./webcodecs-host.cjs");
            frameEncoder = new WebCodecsHost(
              process.env.VELOCAST_MEDIA_SCRATCH,
            );
            frameEncoder.utilityOnly = "frame";
            void (async () => {
              let result;
              try {
                await frameEncoder.initialize();
                result = {
                  id: command.id,
                  ok: true,
                  result: await frameEncoder.command(
                    "media-operation",
                    operation,
                  ),
                };
              } catch (error) {
                result = {
                  id: command.id,
                  ok: false,
                  error: String(error?.stack || error),
                };
              } finally {
                await frameEncoder.dispose();
                frameEncoder = null;
              }
              if (!closed) {
                write(command.response, result);
                active = null;
              }
            })().catch(() => exit(1));
          } else {
            window.webContents.send("velocast:media:operation", {
              id: command.id,
              operation,
            });
          }
        } catch {
          exit(1);
        }
      }
    });
    input.on("end", () => exit(0));
    input.on("error", () => exit(1));
    input.resume();
    await window.loadFile(path.join(__dirname, "webcodecs.html"));
  })
  .catch((error) => {
    write(process.env.VELOCAST_MEDIA_READY, {
      ok: false,
      error: error.message,
    });
  });

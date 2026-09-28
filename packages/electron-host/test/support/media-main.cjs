"use strict";
// A Node-only transport fixture: its descendant deliberately keeps stderr open
// after the process that owns the media protocol has exited.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const holder = spawn(
  process.execPath,
  [path.join(__dirname, "media-pipe-holder.cjs")],
  {
    env: process.env,
    stdio: ["ignore", "ignore", process.stderr],
    windowsHide: true,
    detached: true,
  },
);
holder.unref();
holder.once("spawn", () =>
  fs.writeFileSync(
    process.env.VELOCAST_MEDIA_READY,
    JSON.stringify({ ok: true }),
  ),
);
let pending = "";
process.stdin.on("data", (bytes) => {
  pending += bytes;
  const newline = pending.indexOf("\n");
  if (newline < 0) return;
  const request = JSON.parse(pending.slice(0, newline));
  pending = pending.slice(newline + 1);
  fs.writeFileSync(
    request.response,
    JSON.stringify({ ok: true, result: { complete: true } }),
  );
});
process.stdin.on("end", () => process.exit(0));

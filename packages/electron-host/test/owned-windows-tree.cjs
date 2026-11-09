"use strict";
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const runFile = promisify(execFile);

async function stopOwnedWindowsTree(child) {
  // Never target an exited PID, which Windows could already reuse.
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    await runFile(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, timeout: 5000 });
  } catch (error) {
    // Only a completed taskkill plus OS absence proves this exit race. Launch,
    // timeout, access-denied and still-live failures must retain scratch.
    if (typeof error.code !== "number" || error.killed || error.signal) throw error;
    try {
      process.kill(child.pid, 0);
    } catch (probeError) {
      if (probeError.code === "ESRCH") return;
    }
    throw error;
  }
}

module.exports = { stopOwnedWindowsTree };

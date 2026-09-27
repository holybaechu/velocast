"use strict";
const { createInterface } = require("node:readline");

// The runtime probe must report pre-handshake Electron crashes, not leave a
// pending promise when the child closes the last active event-loop handle.
function hostResponses(child, timeoutMs = 10_000) {
  let stderr = "";
  let terminalError;
  let pending;
  const responses = [];
  const lines = createInterface({ input: child.stdout });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-256 * 1024);
  });
  function fail(error) {
    terminalError = error;
    if (pending) {
      const { reject, timer } = pending;
      pending = null;
      clearTimeout(timer);
      reject(error);
    }
  }
  child.on("error", (error) => fail(new Error(`Host spawn failed: ${error.message}`)));
  // close follows stderr EOF, unlike exit, so diagnostics are complete here.
  child.on("close", (code, signal) => {
    fail(new Error(`Host closed (code=${code}, signal=${signal}): ${stderr}`));
  });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let value;
    try { value = JSON.parse(line); }
    catch { fail(new Error(`Host returned invalid JSON: ${line}; stderr: ${stderr}`)); return; }
    if (pending) {
      const { resolve, timer } = pending;
      pending = null;
      clearTimeout(timer);
      resolve(value);
    } else responses.push(value);
  });
  return {
    stderr: () => stderr,
    close: () => lines.close(),
    next() {
      if (responses.length) return Promise.resolve(responses.shift());
      if (terminalError) return Promise.reject(terminalError);
      if (pending) return Promise.reject(new Error("Host already has a pending response read"));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => fail(new Error(`Host timeout: ${stderr}`)), timeoutMs);
        pending = { resolve, reject, timer };
      });
    },
  };
}

module.exports = { hostResponses };

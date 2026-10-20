"use strict";

const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_QUEUED_COMMANDS = 4;
const SCRIPT_TITLE_PREFIX = "velocast-script-result:";

function parseCommand(line) {
  if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
    throw new Error("Electron host command exceeds 4 MiB");
  }
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    throw new Error("Electron host received invalid JSON");
  }
  if (!command || typeof command !== "object" || Array.isArray(command)) {
    throw new Error("Electron host command must be an object");
  }
  if (!Number.isSafeInteger(command.id) || command.id < 0) {
    throw new Error(
      "Electron host command id must be a nonnegative safe integer",
    );
  }
  if (
    ![
      "load",
      "execute",
      "resize",
      "paint",
      "release",
      "close",
      "webcodecs-open",
      "webcodecs-frame",
      "webcodecs-finish",
      "media-operation",
      "png",
    ].includes(command.method)
  ) {
    throw new Error(
      `Electron host command method is unsupported: ${String(command.method)}`,
    );
  }
  return command;
}

function loadUrl(value) {
  if (typeof value !== "string") {
    throw new Error("Electron load requires an HTTP(S) or file URL");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Electron load requires an HTTP(S) or file URL");
  }
  if (!["http:", "https:", "file:"].includes(parsed.protocol)) {
    throw new Error("Electron load requires an HTTP(S) or file URL");
  }
  return parsed.href;
}

function parseScriptTitle(title, token) {
  if (typeof title !== "string" || typeof token !== "string" || !token)
    return null;
  const prefix = `${SCRIPT_TITLE_PREFIX}${token}:`;
  if (!title.startsWith(prefix)) return null;
  const rest = title.slice(prefix.length);
  if (rest.startsWith("ok:")) return { ok: true, result: rest.slice(3) };
  if (rest.startsWith("err:")) return { ok: false, error: rest.slice(4) };
  return null;
}

module.exports = {
  MAX_LINE_BYTES,
  MAX_QUEUED_COMMANDS,
  parseCommand,
  loadUrl,
  parseScriptTitle,
};

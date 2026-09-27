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
    !["load", "execute", "resize", "invalidate", "paint", "release", "close"].includes(
      command.method,
    )
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

function handleHex(ntHandle) {
  if (!Buffer.isBuffer(ntHandle) || ntHandle.length !== 8) {
    throw new Error("Electron shared texture has no 64-bit Windows NT HANDLE");
  }
  const handle = ntHandle.readBigUInt64LE();
  if (handle === 0n)
    throw new Error("Electron shared texture has a null NT HANDLE");
  return `0x${handle.toString(16)}`;
}

function positiveDimension(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Electron shared texture has invalid ${name}`);
  }
  return value;
}

function rectangle(value, name) {
  if (!value || typeof value !== "object") {
    throw new Error(`Electron shared texture has no ${name}`);
  }
  const left = value.x ?? value.left;
  const top = value.y ?? value.top;
  if (
    !Number.isSafeInteger(left) ||
    left < 0 ||
    !Number.isSafeInteger(top) ||
    top < 0
  ) {
    throw new Error(`Electron shared texture has invalid ${name} origin`);
  }
  return {
    left,
    top,
    width: positiveDimension(value.width, `${name} width`),
    height: positiveDimension(value.height, `${name} height`),
  };
}

function textureMetadata(textureInfo, request, textureId) {
  if (
    !textureInfo ||
    textureInfo.widgetType !== "frame" ||
    textureInfo.pixelFormat !== "bgra"
  ) {
    throw new Error("Electron did not produce a BGRA frame shared texture");
  }
  const textureWidth = positiveDimension(
    textureInfo.codedSize?.width,
    "coded width",
  );
  const textureHeight = positiveDimension(
    textureInfo.codedSize?.height,
    "coded height",
  );
  const sourceRect = rectangle(textureInfo.visibleRect, "visible rectangle");
  if (
    sourceRect.left + sourceRect.width > textureWidth ||
    sourceRect.top + sourceRect.height > textureHeight
  ) {
    throw new Error(
      "Electron shared texture visible rectangle exceeds coded size",
    );
  }
  const metadata = {
    generation: request.generation,
    width: sourceRect.width,
    height: sourceRect.height,
    textureWidth,
    textureHeight,
    sourceRect,
    pixelFormat: "bgra",
    colorSpace: textureInfo.colorSpace ?? null,
    contentRect: textureInfo.contentRect ?? null,
    timestamp: textureInfo.timestamp ?? null,
  };
  if (request.copy) {
    metadata.textureId = textureId;
    metadata.handle = handleHex(textureInfo.handle?.ntHandle);
  }
  return metadata;
}

module.exports = {
  MAX_LINE_BYTES,
  MAX_QUEUED_COMMANDS,
  parseCommand,
  loadUrl,
  parseScriptTitle,
  textureMetadata,
};

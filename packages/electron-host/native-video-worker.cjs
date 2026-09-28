"use strict";

// This entry point must run in stock Node, never Electron's allocator runtime.
if (
  process.versions.electron ||
  typeof process.send !== "function" ||
  !process.connected
) {
  process.stderr.write("media.native_worker_requires_node_ipc\n");
  process.exit(1);
}
process.once("disconnect", () => process.exit(1));

const { NativeMediaSession } = require("./media-session.cjs");
let session;
let sequence = 0;
let busy = false;
let closing = false;
process.stdin.pause();

function readPixels(length) {
  return new Promise((resolve, reject) => {
    const data = Buffer.allocUnsafe(length);
    let offset = 0;
    const cleanup = () => {
      process.stdin.removeListener("readable", read);
      process.stdin.removeListener("end", ended);
      process.stdin.removeListener("error", failed);
    };
    const failed = (error) => {
      cleanup();
      reject(error);
    };
    const ended = () =>
      failed(new Error("media.native_worker_truncated_frame"));
    const read = () => {
      while (offset < length) {
        const chunk = process.stdin.read(Math.min(length - offset, 65536));
        if (!chunk) break;
        chunk.copy(data, offset);
        offset += chunk.length;
      }
      if (offset === length) {
        cleanup();
        resolve(data);
      } else if (process.stdin.readableEnded || process.stdin.destroyed)
        ended();
    };
    process.stdin.on("readable", read);
    process.stdin.once("end", ended);
    process.stdin.once("error", failed);
    read();
  });
}

function reply(message, terminal = false) {
  process.send(message, (error) => {
    if (error || terminal) process.exit(error || !message.ok ? 1 : 0);
  });
}

process.on("message", async (message) => {
  if (closing) return;
  const id = message?.id;
  if (busy || !Number.isSafeInteger(id) || id !== sequence + 1) {
    closing = true;
    reply(
      { id, ok: false, error: "media.native_worker_invalid_sequence" },
      true,
    );
    return;
  }
  sequence = id;
  busy = true;
  try {
    let result;
    switch (message.method) {
      case "open":
        if (session) throw new Error("media.already_open");
        session = new NativeMediaSession({ outputFd: 4 });
        result = await session.open(message.payload);
        break;
      case "frame": {
        if (!session) throw new Error("media.invalid_sequence");
        const { byteLength, index, format, timing } = message.payload;
        const expected = session.settings.width * session.settings.height * 4;
        if (!Number.isSafeInteger(byteLength) || byteLength !== expected)
          throw new Error("media.native_worker_invalid_frame_length");
        const data = await readPixels(byteLength);
        result = await session.encodeBitmap(data, index, format, timing);
        break;
      }
      case "finish":
        if (!session) throw new Error("media.invalid_finish");
        result = await session.finish();
        closing = true;
        break;
      case "cancel":
        await session?.cancel();
        closing = true;
        result = {};
        break;
      default:
        throw new Error("media.native_worker_invalid_method");
    }
    reply({ id, ok: true, result }, closing);
  } catch (error) {
    closing = true;
    try {
      await session?.cancel();
    } catch {}
    reply({ id, ok: false, error: String(error?.stack ?? error) }, true);
  } finally {
    busy = false;
  }
});

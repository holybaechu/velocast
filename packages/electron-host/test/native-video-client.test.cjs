"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { createRequire } = require("node:module");
const { fork } = require("node:child_process");
const { NativeVideoClient } = require("../native-video-client.cjs");
const { frameTiming } = require("../webcodecs-codec.cjs");
const clientPath = path.join(__dirname, "../native-video-client.cjs");
const ownedClients = new Map();
const settingsFor = (directory, width = 64, height = 64) => ({
  width,
  height,
  fps: 60,
  bitrate: 16000000,
  codec: "h264",
  container: "mp4",
  mediaBackend: "native",
  outputPath: path.join(directory, "video.mp4"),
});

function directoryFor(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "velocast-native-video-test-"),
  );
  ownedClients.set(directory, []);
  t.after(async () => {
    await Promise.all(
      ownedClients.get(directory).map((client) => client.cancel()),
    );
    assert.equal(
      path.dirname(fs.realpathSync(directory)),
      fs.realpathSync(os.tmpdir()),
    );
    fs.rmSync(directory, { recursive: true, force: true });
    ownedClients.delete(directory);
  });
  return directory;
}

function harness(t, onRequest) {
  const directory = directoryFor(t);
  const child = new EventEmitter();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.stdin.resume();
  child.connected = true;
  child.pid = 1234;
  child.kill = () => {
    queueMicrotask(() => child.close(null, "SIGKILL"));
    return true;
  };
  child.close = (code = 0, signal = null) => {
    if (child.closed) return;
    child.closed = true;
    child.connected = false;
    child.emit("exit", code, signal);
    child.emit("close", code, signal);
  };
  child.disconnect = () => {
    child.connected = false;
  };
  child.send = (message, callback) => {
    callback(null);
    queueMicrotask(() => onRequest(message, child));
  };
  const parent = new EventEmitter();
  parent.env = {
    VELOCAST_NODE_BINARY: process.execPath,
    ELECTRON_RUN_AS_NODE: "1",
    NODE_OPTIONS: "--require unwanted-loader",
  };
  const localRequire = createRequire(clientPath);
  let options;
  const context = {
    module: { exports: {} },
    __dirname: path.dirname(clientPath),
    process: parent,
    Uint8Array,
    setTimeout,
    clearTimeout,
    require: (name) =>
      name === "node:child_process"
        ? {
            fork: (_file, _args, value) => {
              options = value;
              return child;
            },
          }
        : localRequire(name),
  };
  vm.runInNewContext(fs.readFileSync(clientPath, "utf8"), context, {
    filename: clientPath,
  });
  const client = new context.module.exports.NativeVideoClient();
  ownedClients.get(directory).push(client);
  return {
    client,
    child,
    parent,
    settings: settingsFor(directory),
    options: () => options,
  };
}

function opened(message, child) {
  if (message.method === "open")
    child.emit("message", {
      id: message.id,
      ok: true,
      result: { backend: "native" },
    });
  else if (message.method === "cancel") {
    child.emit("message", { id: message.id, ok: true, result: {} });
    child.close();
  }
}

test("native worker rejects stale replies and joins the child before failing", async (t) => {
  const { client, settings, child } = harness(t, (message, worker) => {
    worker.emit("message", { id: message.id + 1, ok: true, result: {} });
  });
  await assert.rejects(client.open(settings), /native_worker_protocol/);
  assert.equal(child.closed, true);
});

test("native worker bounds submissions and finish waits for process exit", async (t) => {
  let frameRequest, finishRequest;
  const { client, child, settings, parent, options } = harness(
    t,
    (message, worker) => {
      opened(message, worker);
      if (message.method === "frame") frameRequest = message;
      if (message.method === "finish") finishRequest = message;
    },
  );
  await client.open(settings);
  assert.equal(options().serialization, "json");
  assert.equal(options().detached, false);
  assert.equal(options().execPath, process.execPath);
  assert.equal(options().env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(options().env.NODE_OPTIONS, undefined);
  const input = {
    data: Buffer.alloc(64 * 64 * 4),
    index: 0,
    width: 64,
    height: 64,
  };
  const first = client.encodeBitmap(input);
  await assert.rejects(client.encodeBitmap(input), /media.busy/);
  await new Promise(setImmediate);
  child.emit("message", {
    id: frameRequest.id,
    ok: true,
    result: { index: 0, frames: 1, encodedFrames: 1, ...frameTiming(0, 60) },
  });
  await first;
  let completed = false;
  const finished = client.finish().then(() => {
    completed = true;
  });
  await new Promise(setImmediate);
  child.emit("message", {
    id: finishRequest.id,
    ok: true,
    result: { frames: 1 },
  });
  await new Promise(setImmediate);
  assert.equal(completed, false);
  child.close();
  await finished;
  assert.equal(parent.listenerCount("exit"), 0);
});

test("a native worker crash rejects an in-flight frame and removes only its owned output", async (t) => {
  const { client, child, settings } = harness(t, (message, worker) => {
    opened(message, worker);
    if (message.method === "frame") {
      worker.stderr.write("native codec crashed");
      worker.close(133);
    }
  });
  await client.open(settings);
  fs.writeFileSync(settings.outputPath, "incomplete");
  await assert.rejects(
    client.encodeBitmap({
      data: Buffer.alloc(64 * 64 * 4),
      index: 0,
      width: 64,
      height: 64,
    }),
    /native_worker_exited: 133.*native codec crashed/s,
  );
  assert.equal(child.closed, true);
  assert.equal(fs.existsSync(settings.outputPath), false);
});

test("failed open preserves a pre-existing destination", async (t) => {
  const { client, settings } = harness(t, (message, child) => {
    child.emit("message", { id: message.id, ok: false, error: "EEXIST" });
  });
  fs.writeFileSync(settings.outputPath, "previous video");
  await assert.rejects(client.open(settings), /EEXIST/);
  assert.equal(fs.readFileSync(settings.outputPath, "utf8"), "previous video");
});

test("a worker crash before open acknowledgement removes its reserved output", async (t) => {
  const { client, settings, child, options } = harness(t, (message, worker) => {
    assert.equal(message.method, "open");
    assert.equal(fs.existsSync(message.payload.outputPath), true);
    fs.writeFileSync(message.payload.outputPath, "partial header");
    worker.close(133);
  });
  await assert.rejects(client.open(settings), /native_worker_exited: 133/);
  assert.equal(child.closed, true);
  assert.equal(Number.isInteger(options().stdio[4]), true);
  assert.equal(fs.existsSync(settings.outputPath), false);
});

test("native worker timeout terminates and joins an unresponsive child", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { client, settings, child } = harness(t, opened);
  await client.open(settings);
  const pending = client.encodeBitmap({
    data: Buffer.alloc(64 * 64 * 4),
    index: 0,
    width: 64,
    height: 64,
  });
  t.mock.timers.tick(300000);
  await assert.rejects(pending, /native_worker_timeout: frame/);
  assert.equal(child.closed, true);
});

test(
  "native worker exits when its owner disconnects",
  { timeout: 10000 },
  async () => {
    const child = fork(path.join(__dirname, "../native-video-worker.cjs"), [], {
      execPath: process.execPath,
      execArgv: [],
      serialization: "json",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    });
    let timer;
    try {
      const closed = new Promise((resolve, reject) => {
        child.once("exit", resolve);
        child.once("error", reject);
        timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("worker did not exit after IPC disconnect"));
        }, 5000);
      });
      child.disconnect();
      await closed;
      assert.notEqual(child.exitCode, null);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  },
);

test("worker entry rejects Electron before importing any native engine", () => {
  let stderr = "",
    imported = false;
  const stopped = new Error("stopped");
  assert.throws(
    () =>
      vm.runInNewContext(
        fs.readFileSync(
          path.join(__dirname, "../native-video-worker.cjs"),
          "utf8",
        ),
        {
          process: {
            versions: { electron: "44.4.5" },
            send() {},
            stderr: {
              write(value) {
                stderr += value;
              },
            },
            exit(code) {
              assert.equal(code, 1);
              throw stopped;
            },
          },
          require() {
            imported = true;
          },
        },
      ),
    (error) => error === stopped,
  );
  assert.match(stderr, /native_worker_requires_node_ipc/);
  assert.equal(imported, false);
});

test(
  "native byte stream rejects wrong sizes and truncated frames",
  { timeout: 15000 },
  async (t) => {
    const directory = directoryFor(t);
    const previous = process.env.VELOCAST_NODE_BINARY;
    process.env.VELOCAST_NODE_BINARY = process.execPath;
    t.after(() => {
      if (previous === undefined) delete process.env.VELOCAST_NODE_BINARY;
      else process.env.VELOCAST_NODE_BINARY = previous;
    });
    for (const truncated of [false, true]) {
      const client = new NativeVideoClient();
      ownedClients.get(directory).push(client);
      const settings = {
        ...settingsFor(directory),
        outputPath: path.join(directory, `${truncated}.mp4`),
      };
      await client.open(settings);
      const response = client.request("frame", {
        index: 0,
        format: "BGRA",
        timing: frameTiming(0, 60),
        byteLength: truncated ? 64 * 64 * 4 : 4,
      });
      if (truncated) client.child.stdin.end(Buffer.alloc(4));
      await assert.rejects(
        response,
        truncated
          ? /native_worker_truncated_frame/
          : /native_worker_invalid_frame_length/,
      );
      assert.equal(client.exited, true);
      assert.equal(fs.existsSync(settings.outputPath), false);
    }
  },
);

test(
  "regular Node worker encodes and verifies 4K without Electron's allocator",
  { timeout: 30000 },
  async (t) => {
    const directory = directoryFor(t);
    const previous = process.env.VELOCAST_NODE_BINARY;
    process.env.VELOCAST_NODE_BINARY = process.execPath;
    t.after(() => {
      if (previous === undefined) delete process.env.VELOCAST_NODE_BINARY;
      else process.env.VELOCAST_NODE_BINARY = previous;
    });
    const client = new NativeVideoClient();
    ownedClients.get(directory).push(client);
    const settings = settingsFor(directory, 3840, 2160);
    await client.open(settings);
    const data = Buffer.alloc(3840 * 2160 * 4, 64);
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    await client.encodeBitmap({ data, index: 0, width: 3840, height: 2160 });
    const result = await client.finish();
    assert.equal(result.frames, 1);
    assert.equal(result.video.frameCount, 1);
    assert.equal(result.video.width, 3840);
    assert.equal(result.video.height, 2160);
    assert.equal(client.exited, true);
    assert.equal(client.exitStatus.code, 0);
  },
);

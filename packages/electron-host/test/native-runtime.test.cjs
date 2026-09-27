"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { hostResponses } = require("./host-responses.cjs");

test(
  "orphaned host terminates when native cleanup cannot complete",
  {
    skip:
      process.platform !== "win32" ||
      !process.env.VELOCAST_ELECTRON_TEST_BINARY,
    timeout: 15_000,
  },
  async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "velocast-nv12-shutdown-"),
    );
    const addon = path.join(directory, "stalled-addon.cjs");
    await fs.mkdir(path.join(directory, "profile"), { mode: 0o700 });
    await fs.writeFile(
      addon,
      `module.exports.NativeEncoder = class {
    async ready() { return '{}'; }
    abort() { setInterval(() => {}, 1000); return new Promise(() => {}); }
  };`,
    );
    const env = {
      ...process.env,
      VELOCAST_ELECTRON_SURFACE_MODE: "accelerated",
      VELOCAST_ELECTRON_CAPTURE_FORMAT: "nv12",
      VELOCAST_NATIVE_ENCODER_ADDON: addon,
      VELOCAST_ELECTRON_PROFILE_DIRECTORY: path.join(directory, "profile"),
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(
      process.env.VELOCAST_ELECTRON_TEST_BINARY,
      [path.resolve(__dirname, "../main.cjs")],
      { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    const responses = hostResponses(child);
    const closed = new Promise((resolve) => child.once("close", resolve));
    const emergency = setTimeout(() => child.kill(), 12_000);
    try {
      assert.equal((await responses.next()).event, "ready");
      child.stdin.write(
        JSON.stringify({ id: 1, method: "beginNativeEncode", config: {} }) +
          "\n",
      );
      assert.equal((await responses.next()).ok, true);
      child.stdin.end();
      assert.equal(await closed, 1);
      assert.match(responses.stderr(), /native cleanup timed out/);
    } finally {
      clearTimeout(emergency);
      if (child.exitCode === null) child.kill();
      await closed;
      responses.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);

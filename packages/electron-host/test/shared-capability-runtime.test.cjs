"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");
const { hostResponses } = require("./host-responses.cjs");

test(
  "known unavailable GPU rejects shared-texture load and resize without creating a window",
  {
    skip: !process.env.VELOCAST_WEBCODECS_TEST_BINARY,
    timeout: 15000,
  },
  async (t) => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "velocast-shared-capability-"),
    );
    const profile = path.join(directory, "profile");
    fs.mkdirSync(profile);
    const html = path.join(directory, "scene.html");
    fs.writeFileSync(html, "<!doctype html><title>Capability fixture</title>");
    const marker = path.join(directory, "window-created");
    const wrapper = path.join(directory, "host.cjs");
    fs.writeFileSync(
      wrapper,
      `"use strict";
const {app}=require("electron/main");
app.getGPUFeatureStatus=()=>({gpu_compositing:"disabled_software"});
app.on("browser-window-created",()=>require("node:fs").writeFileSync(${JSON.stringify(marker)},"created"));
require(${JSON.stringify(path.resolve(__dirname, "../main.cjs"))});
app.emit("gpu-info-update");
`,
    );
    const env = {
      ...process.env,
      VELOCAST_ELECTRON_SURFACE_MODE: "webcodecs",
      VELOCAST_ELECTRON_CPU_BITMAP: "0",
      VELOCAST_ELECTRON_FRAME_DIRECTORY: directory,
      VELOCAST_ELECTRON_PROFILE_DIRECTORY: profile,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(process.env.VELOCAST_WEBCODECS_TEST_BINARY, [wrapper], {
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const responses = hostResponses(child);
    const exited = new Promise((resolve) => child.once("exit", resolve));
    t.after(async () => {
      child.stdin.end();
      if (child.exitCode === null) {
        let timer;
        await Promise.race([
          exited,
          new Promise((resolve) => {
            timer = setTimeout(resolve, 1000);
          }),
        ]);
        clearTimeout(timer);
      }
      if (child.exitCode === null) {
        child.kill();
        await exited;
      }
      responses.close();
      assert.equal(
        path.dirname(fs.realpathSync(directory)),
        fs.realpathSync(os.tmpdir()),
      );
      fs.rmSync(directory, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 100,
      });
    });
    assert.equal((await responses.next()).surfaceMode, "webcodecs");
    for (const [id, command] of [
      [
        1,
        {
          method: "load",
          url: pathToFileURL(html).href,
          width: 160,
          height: 100,
        },
      ],
      [2, { method: "resize", width: 192, height: 108 }],
    ]) {
      child.stdin.write(JSON.stringify({ id, ...command }) + "\n");
      const reply = await responses.next();
      assert.equal(reply.id, id);
      assert.equal(reply.ok, false);
      assert.match(
        reply.error,
        /^capture\.shared_texture_unavailable: disabled_software$/,
      );
    }
    assert.equal(fs.existsSync(marker), false);
    child.stdin.write(JSON.stringify({ id: 3, method: "close" }) + "\n");
    const closed = await responses.next();
    assert.equal(closed.id, 3);
    assert.equal(closed.ok, true);
    child.stdin.end();
    assert.equal(await exited, 0);
  },
);

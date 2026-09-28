"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { spawn } = require("node:child_process");
test(
  "real browser exposes HDR ten-bit planes without Canvas clipping",
  { skip: !process.env.VELOCAST_WEBCODECS_TEST_BINARY, timeout: 20000 },
  async (t) => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "velocast-hdr-test-"),
    );
    const env = { ...process.env, VELOCAST_HDR_TEST_DIRECTORY: directory };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(
      process.env.VELOCAST_WEBCODECS_TEST_BINARY,
      [path.join(__dirname, "hdr-test-main.cjs")],
      { env, windowsHide: true, stdio: "ignore" },
    );
    const timeout = setTimeout(() => child.kill(), 15000);
    try {
      const code = await new Promise((resolve, reject) => {
        child.once("exit", resolve);
        child.once("error", reject);
      });
      assert.equal(code, 0);
      const result = JSON.parse(
        fs.readFileSync(path.join(directory, "result.json"), "utf8"),
      );
      assert.equal(result.ok, true, result.error);
      assert.equal(result.results.length, 2);
      if (result.external) t.diagnostic(JSON.stringify(result.external));
      for (const item of result.results) {
        if (process.env.VELOCAST_HDR_TEST_SOURCE)
          t.diagnostic(
            JSON.stringify({
              transfer: item.transfer,
              floatBlack: item.floats[0],
              floatMid: item.floats[8],
              floatWhite: item.floats[12],
              attributes: item.attributes,
            }),
          );
        assert.equal(item.format, "I420P10");
        assert.equal(item.pixels[0], 0);
        assert.ok(item.pixels[8] > 20 && item.pixels[8] < 250);
        assert.equal(item.pixels[11], 255);
      }
      for (const item of result.compressed) {
        if (!item.supported) {
          t.diagnostic(
            `${item.transfer} compressed fixture skipped: this browser has no software AV1 ten-bit encoder`,
          );
          continue;
        }
        assert.equal(item.normalization, "hdr-to-sdr-bt709");
        assert.ok(item.pixels[0] > 20 && item.pixels[0] < 250);
        assert.ok(Math.abs(item.pixels[0] - item.pixels[1]) <= 2);
        assert.ok(Math.abs(item.pixels[0] - item.pixels[2]) <= 2);
      }
    } finally {
      clearTimeout(timeout);
      fs.rmSync(directory, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 100,
      });
    }
  },
);

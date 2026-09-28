"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const {
  createMediaSession,
  runMediaOperation,
} = require("../media-client.cjs");
const { wavHeader } = require("../media-runtime.cjs");
test(
  "persistent media sessions bound requests, reuse codecs, preserve destinations and join cancellation",
  { skip: !process.env.VELOCAST_WEBCODECS_TEST_BINARY, timeout: 30000 },
  async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "velocast-media-test-"),
    );
    const options = {
      electronBinary: process.env.VELOCAST_WEBCODECS_TEST_BINARY,
      timeoutMs: 10000,
    };
    let session;
    try {
      const input = path.join(directory, "source.wav"),
        bytes = Buffer.alloc(64 * 4);
      for (let i = 0; i < 64; i++) bytes.writeFloatLE(i / 64, i * 4);
      fs.writeFileSync(input, Buffer.concat([wavHeader(64, 48000, 1), bytes]));
      session = await createMediaSession(options);
      const requests = Array.from({ length: 5 }, () =>
        session.run({ kind: "probe", path: input }),
      );
      const outcomes = await Promise.allSettled(requests);
      assert.equal(
        outcomes.filter((result) => result.status === "fulfilled").length,
        4,
      );
      assert.match(outcomes[4].reason.message, /queue_full/);
      const output = path.join(directory, "decoded.f32");
      await session.run({
        kind: "decode-audio",
        path: input,
        outputPath: output,
        sampleRate: 48000,
        channels: 1,
        format: "f32",
      });
      assert.deepEqual(fs.readFileSync(output), bytes);
      await session.close();
      session = null;
      session = await createMediaSession(options);
      const raced = path.join(directory, "concurrent.wav");
      const racing = session.run({
        kind: "mix-audio",
        plan: { sampleRate: 48000, durationSamples: 128, clips: [] },
        channels: 1,
        outputPath: raced,
      });
      fs.writeFileSync(raced, "another writer owns this destination", {
        flag: "wx",
      });
      await assert.rejects(racing, /EEXIST/);
      assert.equal(
        fs.readFileSync(raced, "utf8"),
        "another writer owns this destination",
      );
      await session.close();
      session = null;
      await assert.rejects(
        runMediaOperation(
          {
            kind: "mix-audio",
            plan: { sampleRate: 48000, durationSamples: 32, clips: [] },
            channels: 1,
            outputPath: output,
          },
          options,
        ),
        /EEXIST/,
      );
      assert.deepEqual(fs.readFileSync(output), bytes);
      session = await createMediaSession(options);
      const controller = new AbortController(),
        abortedOutput = path.join(directory, "aborted.wav");
      const work = session.run(
        {
          kind: "mix-audio",
          plan: { sampleRate: 48000, durationSamples: 10000000, clips: [] },
          channels: 2,
          outputPath: abortedOutput,
        },
        { signal: controller.signal },
      );
      controller.abort(new Error("test abort"));
      await assert.rejects(work, /test abort/);
      await assert.rejects(
        session.run({ kind: "probe", path: input }),
        /session_closed/,
      );
      assert.equal(fs.existsSync(abortedOutput), false);
    } finally {
      await session?.close();
      fs.rmSync(directory, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 100,
      });
    }
  },
);

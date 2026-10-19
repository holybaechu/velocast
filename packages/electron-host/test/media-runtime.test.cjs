"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  vm = require("node:vm");
const { createRequire } = require("node:module");
const {
  createMediaSession,
  runMediaOperation,
} = require("../media-client.cjs");
const { wavHeader } = require("../media-runtime.cjs");

for (const cancellationFails of [false, true])
  test(`failed mux joins its sibling before removing output and inputs${cancellationFails ? " even when cancellation fails" : ""}`, async () => {
    const events = [];
    let releaseAudio, audioStarted, cancellationStarted;
    const audioReleased = new Promise((resolve) => (releaseAudio = resolve)),
      audioReading = new Promise((resolve) => (audioStarted = resolve)),
      cancelled = new Promise((resolve) => (cancellationStarted = resolve));
    let outputCancelled = false,
      settled = false;
    const cleanupError = new Error("encoder cleanup failed");
    const video = {
      getDecoderConfig: async () => ({ codec: "avc" }),
      getCodec: async () => "avc",
      getRotation: async () => 0,
      getFirstTimestamp: async () => 0,
    };
    const audio = {
      getDecoderConfig: async () => ({ codec: "aac" }),
      getCodec: async () => "aac",
      getSampleRate: async () => 48000,
      getFirstTimestamp: async () => 0,
    };
    const media = {
      mb: {
        EncodedVideoPacketSource: class {},
        EncodedAudioPacketSource: class {
          async add() {
            assert.equal(outputCancelled, true);
            throw new Error("output cancelled");
          }
        },
        EncodedPacketSink: class {
          constructor(track) {
            this.track = track;
          }
          async *packets() {
            if (this.track === video) {
              await audioReading;
              yield { type: "delta" };
              return;
            }
            audioStarted();
            try {
              await audioReleased;
              assert.equal(events.includes("input disposed"), false);
              yield { clone: () => ({}) };
            } finally {
              events.push("audio joined");
            }
          }
        },
      },
      inputFile: () => ({
        getPrimaryVideoTrack: async () => video,
        getPrimaryAudioTrack: async () => audio,
        dispose: () => events.push("input disposed"),
      }),
      outputFile: () => ({
        output: {
          format: { getSupportedAudioCodecs: () => ["aac"] },
          addVideoTrack() {},
          addAudioTrack() {},
          async start() {},
          async cancel() {
            outputCancelled = true;
            cancellationStarted();
            if (cancellationFails) throw cleanupError;
          },
        },
        async cancel() {
          cancellationStarted();
          events.push("output removed");
        },
      }),
    };
    const file = path.join(__dirname, "../media-runtime.cjs"),
      realRequire = createRequire(file),
      module = { exports: {} };
    vm.runInNewContext(
      `(function(require,module){${fs.readFileSync(file, "utf8")}\n})`,
      { Buffer },
    )((name) => {
      if (name === "./media-io.cjs") return media;
      if (name === "./native-media.cjs") return { registerNativeMedia() {} };
      return realRequire(name);
    }, module);
    const result = module.exports
      .runMediaOperation({
        kind: "mux-audio",
        videoPath: "/video.mp4",
        audioPath: "/audio.aac",
        outputPath: "/output.mp4",
      })
      .catch((error) => error)
      .finally(() => (settled = true));
    try {
      await cancelled;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, false);
      assert.deepEqual(events, []);
    } finally {
      releaseAudio();
    }
    const error = await result;
    assert.match(error.message, /media.segment_must_start_with_keyframe/);
    if (cancellationFails) {
      assert.equal(error.errors[0], error.cause);
      assert.equal(error.errors[1], cleanupError);
    }
    assert.deepEqual(events, [
      "audio joined",
      "output removed",
      "input disposed",
      "input disposed",
    ]);
  });

test(
  "WebM remux without fps preserves CFR and VFR packet timing",
  { skip: !process.env.VELOCAST_WEBCODECS_TEST_BINARY, timeout: 30000 },
  async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "velocast-webm-packet-timing-"),
    );
    let session;
    try {
      const framePath = path.join(directory, "frame.bmp"),
        bmp = Buffer.alloc(54 + 64 * 64 * 3);
      bmp.write("BM");
      bmp.writeUInt32LE(bmp.length, 2);
      bmp.writeUInt32LE(54, 10);
      bmp.writeUInt32LE(40, 14);
      bmp.writeInt32LE(64, 18);
      bmp.writeInt32LE(64, 22);
      bmp.writeUInt16LE(1, 26);
      bmp.writeUInt16LE(24, 28);
      for (let index = 54; index < bmp.length; index += 3)
        bmp[index + 2] = 255;
      fs.writeFileSync(framePath, bmp);
      const audioPath = path.join(directory, "audio.wav");
      fs.writeFileSync(
        audioPath,
        Buffer.concat([wavHeader(24000, 48000, 1), Buffer.alloc(24000 * 4)]),
      );
      session = await createMediaSession({
        electronBinary: process.env.VELOCAST_WEBCODECS_TEST_BINARY,
        timeoutMs: 10000,
      });
      for (const [label, timestamps] of [
        ["cfr", undefined],
        ["vfr", [0, 1 / 30, 3 / 30, 4 / 30, 7 / 30, 9 / 30, 10 / 30]],
      ]) {
        const source = path.join(directory, `${label}-source.webm`),
          output = path.join(directory, `${label}-output.webm`);
        await session.run({
          kind: "encode-frames",
          framePaths: Array(7).fill(framePath),
          timestamps,
          width: 64,
          height: 64,
          fps: 30,
          codec: "vp9",
          bitrate: 1000000,
          outputPath: source,
        });
        const before = await session.run({
          kind: "probe",
          path: source,
          frames: true,
        });
        await session.run({
          kind: "mux-audio",
          videoPath: source,
          audioPath,
          outputPath: output,
        });
        const after = await session.run({
          kind: "probe",
          path: output,
          frames: true,
        });
        assert.equal(after.video.frames.length, 7);
        assert.deepEqual(
          before.video.frames.map((frame) => frame.pts),
          label === "cfr"
            ? [0, 33, 67, 100, 133, 167, 200]
            : [0, 33, 100, 133, 233, 300, 333],
        );
        assert.deepEqual(after.video.timeBase, before.video.timeBase);
        assert.deepEqual(after.video.frames, before.video.frames);
        assert.ok(after.video.frames.at(-1).duration > 0);
        assert.equal(after.video.duration, before.video.duration);
        const decoded = await session.run({
          kind: "frame-hashes",
          path: output,
        });
        assert.equal(decoded.frameCount, 7);
      }
    } finally {
      await session?.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

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

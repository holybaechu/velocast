"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "../media-session.cjs"),
  "utf8",
);
const settings = {
  outputPath: "movie.mp4",
  codec: "h264",
  width: 160,
  height: 100,
  fps: 30,
  bitrate: 1_000_000,
};

function fixture({ supported = true, configureError } = {}) {
  const events = [];
  class Encoder {
    static async isConfigSupported(config) {
      events.push(["probe", config.codec]);
      return { supported };
    }
    constructor() {
      events.push(["webcodecs-create"]);
    }
    configure() {
      if (configureError) throw configureError;
    }
    close() {
      events.push(["webcodecs-close"]);
    }
  }
  class NativeVideoClient {
    constructor() {
      events.push(["native-create"]);
    }
    async open(value) {
      events.push(["native-open", value.mediaBackend]);
      return { backend: "native", logicalCodec: value.codec };
    }
  }
  const module = { exports: {} };
  const actualCodec = require("../webcodecs-codec.cjs");
  const dependencies = {
    "./media-io.cjs": {
      mb: {},
      outputFile() {},
      probe() {},
      absolute: (value) => value,
    },
    "./media-settings.cjs": require("../media-settings.cjs"),
    "./native-media.cjs": { registerNativeMedia() {} },
    "./native-video-client.cjs": { NativeVideoClient },
    "./webcodecs-codec.cjs": actualCodec,
  };
  const load = vm.runInNewContext(
    `(function(require,module,exports){${source}\n})`,
    { process: { versions: { electron: "44" } }, VideoEncoder: Encoder },
  );
  load((name) => dependencies[name] ?? require(name), module, module.exports);
  return { MediaSession: module.exports.MediaSession, events };
}

test("auto starts WebCodecs without a native client when supported", async () => {
  const f = fixture();
  const config = await new f.MediaSession().open(settings);
  assert.equal(config.backend, "webcodecs");
  assert.equal(config.backendFallbackReason, undefined);
  assert.equal(config.cpuReadback, false);
  assert.ok(f.events.some(([event]) => event === "webcodecs-create"));
  assert.ok(!f.events.some(([event]) => event === "native-create"));
});

test("auto starts native after an unsupported WebCodecs probe", async () => {
  const f = fixture({ supported: false });
  const config = await new f.MediaSession().open(settings);
  assert.equal(config.backend, "native");
  assert.match(config.backendFallbackReason, /webcodecs.unsupported_config/);
  assert.equal(config.cpuReadback, true);
  assert.ok(f.events.some(([event]) => event === "native-create"));
  assert.ok(!f.events.some(([event]) => event === "webcodecs-create"));
});

test("auto retries native only for a support failure during encoder open", async () => {
  const unsupported = new Error("hardware encoder unavailable");
  unsupported.name = "NotSupportedError";
  const f = fixture({ configureError: unsupported });
  const config = await new f.MediaSession().open(settings);
  assert.equal(config.backend, "native");
  assert.match(config.backendFallbackReason, /hardware encoder unavailable/);
  assert.ok(f.events.some(([event]) => event === "webcodecs-close"));
  assert.ok(f.events.some(([event]) => event === "native-create"));
});

test("auto preserves unrelated encoder-open failures", async () => {
  const f = fixture({ configureError: new Error("output path denied") });
  await assert.rejects(
    new f.MediaSession().open(settings),
    /output path denied/,
  );
  assert.ok(!f.events.some(([event]) => event === "native-create"));
});

test("explicit WebCodecs failure never opens native", async () => {
  const unsupported = new Error("unsupported");
  unsupported.name = "NotSupportedError";
  const f = fixture({ configureError: unsupported });
  await assert.rejects(
    new f.MediaSession().open({ ...settings, mediaBackend: "webcodecs" }),
    /unsupported/,
  );
  assert.ok(!f.events.some(([event]) => event === "native-create"));
});

test("explicit native and ProRes auto skip browser support probes", async () => {
  const f = fixture();
  assert.equal(
    (await new f.MediaSession().open({ ...settings, mediaBackend: "native" }))
      .backend,
    "native",
  );
  assert.equal(
    (
      await new f.MediaSession().open({
        ...settings,
        codec: "prores",
        outputPath: "movie.mov",
      })
    ).backend,
    "native",
  );
  assert.ok(!f.events.some(([event]) => event === "probe"));
});

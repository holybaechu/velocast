// Actual OfflineAudioContext PCM evidence, not real-time player or codec-decode acceptance.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [dependencyProject, browserExecutable, outputDirectory] =
  process.argv.slice(2);
assert.ok(
  dependencyProject && browserExecutable && outputDirectory,
  "usage: verify-web-audio-clock.mjs EXISTING_REMOTION_PROJECT|--cdp BROWSER OUTPUT_DIRECTORY",
);
const output = resolve(outputDirectory);
await mkdir(output, { recursive: true });

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/") {
      response.setHeader("content-type", "text/html");
      response.end(
        '<!doctype html><script type="importmap">{"imports":{"@velocast/core":"/core/index.js"}}</script><p>Offline audio clock verification</p>',
      );
      return;
    }
    const relative =
      pathname === "/clock.js"
        ? "packages/preview/dist/web-audio-clock.js"
        : /^\/core\/[a-zA-Z0-9_/-]+\.js$/.test(pathname)
          ? `packages/core/dist/${pathname.slice(6)}`
          : null;
    if (!relative) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("content-type", "text/javascript");
    response.end(await readFile(join(repo, relative)));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((yes, no) => {
  server.once("error", no);
  server.listen(0, "127.0.0.1", yes);
});
let browser;
try {
  let page;
  const url = `http://127.0.0.1:${server.address().port}/`;
  if (dependencyProject === "--cdp") {
    const { launchCdpBrowser } = await import(
      pathToFileURL(join(repo, "packages/cli/dist/browser-cdp.js")).href
    );
    const cdp = await launchCdpBrowser(url, {
      executable: resolve(browserExecutable),
    });
    browser = { close: () => cdp.close() };
    page = {
      evaluate: (callback) => cdp.evaluate(`(${callback.toString()})()`),
    };
  } else {
    const require = createRequire(
      join(resolve(dependencyProject), "package.json"),
    );
    const { openBrowser } = require("@remotion/renderer");
    browser = await openBrowser("chrome", {
      browserExecutable: resolve(browserExecutable),
      logLevel: "error",
    });
    page = await browser.newPage(() => null, "error", false);
    await page.goto({ url, timeout: 10000 });
  }
  const result = await page.evaluate(async () => {
    const { prepareWebAudioClock } = await import("/clock.js");
    const { sliceAudioPlan, evaluateAudioEnvelope } =
      await import("/core/index.js");
    const source = Float32Array.from(
      { length: 512 },
      (_, index) => ((index % 13) - 6) / 16,
    );
    async function render(plan, channels = 1) {
      const offline = new OfflineAudioContext(
        channels,
        plan.durationSamples,
        plan.sampleRate,
      );
      const context = new Proxy(offline, {
        get(target, property) {
          if (property === "state") return "running";
          if (property === "resume" || property === "close")
            return async () => {};
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const clock = await prepareWebAudioClock(plan, {
        createContext: () => context,
        loadBuffer: async () => {
          const decoded = offline.createBuffer(
            1,
            source.length,
            plan.sampleRate,
          );
          decoded.copyToChannel(source, 0);
          return decoded;
        },
      });
      await clock.play();
      const rendered = await offline.startRendering();
      await clock.dispose();
      return Array.from({ length: channels }, (_, channel) =>
        Array.from(rendered.getChannelData(channel)),
      );
    }
    const clip = {
      source: "immutable-pcm",
      startSample: 8,
      sourceStartSample: 9,
      durationSamples: 100,
      gain: 0.5,
    };
    const cases = [
      { name: "trim-offset", clips: [clip] },
      {
        name: "fade-duck-preroll",
        clips: [
          {
            ...clip,
            startSample: -13,
            volumeEnvelope: [
              { sample: 0, gain: 0 },
              { sample: 23, gain: 1 },
              { sample: 41, gain: 0.2 },
              { sample: 57, gain: 0.2 },
              { sample: 79, gain: 1 },
              { sample: 100, gain: 0 },
            ],
          },
        ],
      },
      { name: "preroll", clips: [{ ...clip, startSample: -8 }] },
      { name: "tail-padding", clips: [{ ...clip, sourceStartSample: 510 }] },
      {
        name: "overlap-no-normalization",
        clips: [
          { ...clip, gain: 2 },
          { ...clip, gain: 2 },
        ],
      },
      { name: "stereo-silence", clips: [], channels: 2 },
    ];
    const results = [];
    for (const item of cases) {
      const plan = {
        sampleRate: 48000,
        durationSamples: 256,
        clips: item.clips,
      };
      const channels = await render(plan, item.channels ?? 1);
      let error = 0;
      let peak = 0;
      for (const output of channels)
        for (let sample = 0; sample < output.length; sample++) {
          let expected = 0;
          for (const item of plan.clips) {
            const position = sample - item.startSample;
            if (position >= 0 && position < item.durationSamples)
              expected +=
                (source[item.sourceStartSample + position] ?? 0) *
                item.gain *
                evaluateAudioEnvelope(item.volumeEnvelope, position);
          }
          error = Math.max(error, Math.abs(output[sample] - expected));
          peak = Math.max(peak, Math.abs(output[sample]));
        }
      results.push({
        name: item.name,
        samples: channels[0].length,
        channels: channels.length,
        maxAbsoluteError: error,
        peak,
      });
    }
    const fullPlan = { sampleRate: 48000, durationSamples: 256, clips: [clip] };
    const full = (await render(fullPlan))[0];
    const partial = (await render(sliceAudioPlan(fullPlan, 60, 200)))[0];
    results.push({
      name: "full-versus-range",
      samples: partial.length,
      maxAbsoluteError: Math.max(
        ...partial.map((sample, index) => Math.abs(sample - full[index + 60])),
      ),
    });
    const envelopePlan = {
      ...fullPlan,
      clips: cases.find((item) => item.name === "fade-duck-preroll").clips,
    };
    const envelopeFull = (await render(envelopePlan))[0];
    const envelopeRange = (
      await render(sliceAudioPlan(envelopePlan, 19, 91))
    )[0];
    results.push({
      name: "envelope-full-versus-range",
      samples: envelopeRange.length,
      maxAbsoluteError: Math.max(
        ...envelopeRange.map((sample, index) =>
          Math.abs(sample - envelopeFull[index + 19]),
        ),
      ),
    });
    return { cases: results, userAgent: navigator.userAgent };
  });
  for (const resultCase of result.cases) {
    if (
      resultCase.name.includes("envelope") ||
      resultCase.name === "fade-duck-preroll"
    )
      assert.ok(
        resultCase.maxAbsoluteError < 1e-7,
        `${resultCase.name}: ${resultCase.maxAbsoluteError}`,
      );
    else assert.equal(resultCase.maxAbsoluteError, 0, resultCase.name);
  }
  result.scope =
    "Actual offline Web Audio nodes and PCM only; real-time clock, playback gesture, encoded input and official preview integration remain separate gates.";
  result.sourceSha256 = createHash("sha256")
    .update(
      await readFile(join(repo, "packages/preview/dist/web-audio-clock.js")),
    )
    .digest("hex");
  await writeFile(
    join(output, "verification.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  console.log(JSON.stringify(result));
} finally {
  await browser?.close(true, "error", false);
  await new Promise((resolve) => server.close(resolve));
}

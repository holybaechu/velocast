import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [mode, rendererArg, outputArg] = process.argv.slice(2);
assert(
  ["prepare", "run", "browser"].includes(mode) && rendererArg && outputArg,
  "usage: verify-remotion-media-native.mjs prepare|run|browser RENDERER OUTPUT [--browser PATH]",
);
const renderer = resolve(rendererArg),
  output = resolve(outputArg),
  project = join(output, "project"),
  dist = join(project, "dist");
await mkdir(join(project, "public"), { recursive: true });
const executions = [];
async function command(name, exe, args) {
  const record = {
    name,
    command: [exe, ...args],
    startedAt: new Date().toISOString(),
    stdout: "",
    stderr: "",
  };
  const child = spawn(exe, args, {
    cwd: root,
    windowsHide: true,
    env: process.env,
  });
  child.stdout.on("data", (bytes) => (record.stdout += bytes));
  child.stderr.on("data", (bytes) => (record.stderr += bytes));
  record.exitStatus = await new Promise((done, reject) => {
    child.on("error", reject);
    child.on("close", done);
  });
  record.finishedAt = new Date().toISOString();
  executions.push(record);
  await writeFile(
    join(output, "executions.json"),
    JSON.stringify(executions, null, 2),
  );
  assert.equal(record.exitStatus, 0, `${name}: ${record.stderr.slice(-5000)}`);
  return record;
}
const asset = join(project, "public/clip.mp4");
if (mode === "prepare") {
  await command("source-video", "ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x96:rate=30:duration=2",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=719:sample_rate=48000:duration=2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-g",
    "30",
    "-bf",
    "0",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-shortest",
    asset,
  ]);
  await writeFile(
    join(project, "index.html"),
    '<!doctype html><html><head><style>html,body{margin:0}canvas{display:block}</style></head><body><div id="official"></div><div id="compat"></div><script type="module" src="/scene.jsx"></script></body></html>',
  );
  await writeFile(
    join(project, "scene.jsx"),
    `
import React from 'react';
import {createMediaTimeline,registerReactComposition} from '@velocast/react';
import {registerRemotionComposition} from '@velocast/remotion';
import {OffthreadVideo,Sequence} from 'remotion';
const config={width:160,height:96,fps:30,durationFrames:36};
const timeline=createMediaTimeline(config,[{id:'clip',kind:'video',src:'/clip.mp4',from:4,durationFrames:24,trimBeforeFrames:6,fadeInFrames:8,fadeOutFrames:8}]);
registerReactComposition('official',{...config,target:'#official',audio:timeline.audio,component:timeline.Timeline});
const volume=frame=>frame<8?frame/8:frame>16?(24-frame)/8:1;
function Original(){return <Sequence from={4} durationInFrames={24} layout="none"><OffthreadVideo src="/clip.mp4" trimBefore={6} trimAfter={30} volume={volume}/></Sequence>;}
registerRemotionComposition('compat',{width:160,height:96,fps:30,durationInFrames:36,target:'#compat',component:Original,audio:{sampleRate:48000,tracks:[{src:'/clip.mp4',from:4,durationInFrames:24,trimBefore:6,trimAfter:30,volume}]}});
`,
  );
  const packageRequire = createRequire(
    join(root, "packages/remotion-compat/package.json"),
  );
  const viteRequire = createRequire(
    packageRequire.resolve("vitest/package.json"),
  );
  const { build } = await import(
    pathToFileURL(viteRequire.resolve("vite")).href
  );
  await build({
    root: project,
    configFile: false,
    base: "./",
    resolve: {
      alias: [
        {
          find: /^remotion$/,
          replacement: join(root, "packages/remotion-compat/dist/remotion.js"),
        },
        {
          find: /^@velocast\/remotion$/,
          replacement: join(root, "packages/remotion-compat/dist/index.js"),
        },
        {
          find: /^@velocast\/react$/,
          replacement: join(root, "packages/react/dist/index.js"),
        },
        {
          find: /^@velocast\/core$/,
          replacement: join(root, "packages/core/dist/index.js"),
        },
        {
          find: "react",
          replacement: join(
            root,
            "packages/remotion-compat/node_modules/react",
          ),
        },
        {
          find: /^react-dom(.*)$/,
          replacement:
            join(root, "packages/remotion-compat/node_modules/react-dom") +
            "$1",
        },
      ],
    },
    build: { outDir: "dist", emptyOutDir: true },
  });
  console.log(`REMOTION_MEDIA_PREPARED: ${dist}`);
  process.exit(0);
}
const load = (path) => import(pathToFileURL(join(root, path)).href);
const { createInputSnapshot } = await load(
  "packages/cli/dist/input-snapshot.js",
);
const { createVideoFrameHttp } = await load(
  "packages/cli/dist/video-frame-http.js",
);
const { renderAudioPlanPcm } = await load(
  "packages/cli/dist/audio-plan-render.js",
);
const { sliceAudioPlanByFrames } = await load("packages/core/dist/index.js");
const media = createVideoFrameHttp({ directory: join(output, "media-cache") });
const snapshot = await createInputSnapshot({
  root: dist,
  entryPath: "index.html",
  handleMediaRequest: (request, response, identity) =>
    media.handle(request, response, identity),
});
const variants = [
  { name: "full" },
  { name: "range", range: { startFrame: 7, endFrame: 23 } },
];
const evidence = [];
try {
  const fullPlan = {
    sampleRate: 48000,
    durationSamples: 57600,
    clips: [
      {
        source: join(dist, "clip.mp4"),
        startSample: 6400,
        sourceStartSample: 9600,
        durationSamples: 38400,
        gain: 1,
        volumeEnvelope: [
          { sample: 0, gain: 0 },
          { sample: 12800, gain: 1 },
          { sample: 25600, gain: 1 },
          { sample: 38400, gain: 0 },
        ],
      },
    ],
  };
  for (const variant of mode === "browser" ? [] : variants) {
    const selected = variant.range
      ? sliceAudioPlanByFrames(
          fullPlan,
          variant.range.startFrame,
          variant.range.endFrame,
          30,
          "round",
        )
      : fullPlan;
    const reference = await renderAudioPlanPcm(selected, {
      outputPath: join(output, `${variant.name}.reference.f32`),
      channelCount: 2,
      sourceChannelCounts: new Map([[join(dist, "clip.mp4"), 1]]),
    });
    const paired = [];
    for (const composition of ["official", "compat"]) {
      const name = `${composition}-${variant.name}`,
        destination = join(output, `${name}.mp4`),
        reportPath = join(output, `${name}.report.json`);
      const job = {
        mode: "composition",
        composition_id: composition,
        serve_url: snapshot.url,
        render_session: snapshot.session,
        output: destination,
        codec: "libx264",
        acceleration: "off",
        assembly_mode: "reference",
        concurrency: 1,
        report_path: reportPath,
        ...(variant.range ? { output_range: variant.range } : {}),
      };
      await command(name, renderer, ["--job-json", JSON.stringify(job)]);
      const report = JSON.parse(await readFile(reportPath, "utf8"));
      assert.equal(
        report.audio.pcm_sha256,
        reference.sha256,
        `${name} PCM reference`,
      );
      assert.equal(report.audio.duration_samples, selected.durationSamples);
      const frames = await command(`${name}-frames`, "ffmpeg", [
        "-v",
        "error",
        "-i",
        destination,
        "-map",
        "0:v:0",
        "-f",
        "framemd5",
        "-",
      ]);
      const audio = await command(`${name}-audio`, "ffmpeg", [
        "-v",
        "error",
        "-i",
        destination,
        "-map",
        "0:a:0",
        "-f",
        "md5",
        "-",
      ]);
      paired.push({
        name,
        pcmSha256: report.audio.pcm_sha256,
        frameMd5: frames.stdout,
        audioMd5: audio.stdout.trim(),
        durationSamples: report.audio.duration_samples,
      });
    }
    assert.equal(
      paired[0].frameMd5,
      paired[1].frameMd5,
      `${variant.name} decoded pixels`,
    );
    assert.equal(
      paired[0].audioMd5,
      paired[1].audioMd5,
      `${variant.name} decoded sound`,
    );
    evidence.push({
      variant: variant.name,
      referencePcmSha256: reference.sha256,
      paired,
    });
  }
  const browserIndex = process.argv.indexOf("--browser");
  if (browserIndex >= 0) {
    const { launchCdpBrowser } = await load("packages/cli/dist/browser-cdp.js");
    const results = [];
    for (const composition of ["official", "compat"]) {
      const browser = await launchCdpBrowser(snapshot.url, {
        executable: process.argv[browserIndex + 1],
      });
      try {
        const readyDeadline = Date.now() + 10000;
        while (true) {
          try {
            if (
              await browser.evaluate(
                'document.readyState === "complete" && typeof window.__velocast === "object"',
              )
            )
              break;
          } catch (error) {
            if (!String(error).includes("context was destroyed")) throw error;
          }
          assert(
            Date.now() < readyDeadline,
            "composition registration timeout",
          );
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        results.push(
          await browser.evaluate(
            `(async()=>{const deadline=Date.now()+10000;while(!window.__velocast){if(Date.now()>deadline)throw new Error("composition registration timeout");await new Promise(resolve=>setTimeout(resolve,20));}await window.__velocast.beginSession(${JSON.stringify(snapshot.session)});const results=[];for(const frame of [4,20,8,4]){await window.__velocast.seekFrame(${JSON.stringify(composition)},frame,{renderSession:${JSON.stringify(snapshot.session)}});const canvas=document.querySelector('#${composition} canvas');results.push({frame,pts:canvas.dataset.velocastVideoPts,pixels:canvas.toDataURL()});}return results;})()`,
          ),
        );
      } finally {
        await browser.close();
      }
    }
    assert.deepEqual(results[0], results[1]);
    evidence.push({
      variant: "reordered-real-browser-pixels",
      frames: results[0].map((item) => ({
        frame: item.frame,
        pts: item.pts,
        sha256: createHash("sha256").update(item.pixels).digest("hex"),
      })),
    });
  }
  if (mode !== "browser") {
    const full = await readFile(join(output, "full.reference.f32")),
      range = await readFile(join(output, "range.reference.f32"));
    let maxAbsoluteError = 0;
    const slice = full.subarray(7 * 1600 * 8, 23 * 1600 * 8);
    assert.equal(range.length, slice.length);
    for (let offset = 0; offset < range.length; offset += 4)
      maxAbsoluteError = Math.max(
        maxAbsoluteError,
        Math.abs(range.readFloatLE(offset) - slice.readFloatLE(offset)),
      );
    assert(
      maxAbsoluteError < 1e-7,
      `full/range envelope PCM: ${maxAbsoluteError}`,
    );
    evidence.push({
      variant: "full-versus-range-reference",
      maxAbsoluteError,
      threshold: 1e-7,
    });
  }
  const result = {
    status: "PASS",
    sourceSha256: createHash("sha256")
      .update(await readFile(join(dist, "clip.mp4")))
      .digest("hex"),
    rendererSha256:
      mode === "browser"
        ? null
        : createHash("sha256")
            .update(await readFile(renderer))
            .digest("hex"),
    evidence,
  };
  await writeFile(
    join(output, "verification.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(
    `REMOTION_MEDIA_${mode === "browser" ? "BROWSER" : "NATIVE"}_PASS: ${evidence.length} gates`,
  );
} finally {
  await media.close();
  await snapshot.close();
}

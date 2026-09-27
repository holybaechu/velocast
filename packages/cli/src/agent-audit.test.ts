import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { BROWSER_PROTOCOL_VERSION } from "@velocast/core";
import { auditComposition, validateAuditAssertions } from "./agent-audit.js";

const roots: string[] = [];
const exec = promisify(execFile);
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

it("validates selector and motion assertion schema", () => {
  expect(
    validateAuditAssertions({
      selectors: [
        {
          selector: "#hero",
          minContrast: 4.5,
          motion: { fromFrame: 0, toFrame: 9, minPixels: 10 },
        },
      ],
    }),
  ).toEqual({
    selectors: [
      {
        selector: "#hero",
        minContrast: 4.5,
        motion: { fromFrame: 0, toFrame: 9, minPixels: 10 },
      },
    ],
  });
  expect(() =>
    validateAuditAssertions({ selectors: [{ selector: "", minContrast: 50 }] }),
  ).toThrow("selector is required");
});

it("checks good and known-bad exact frames in a real browser with source identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "velocast-agent-audit-"));
  roots.push(root);
  const dist = join(root, "dist");
  await mkdir(dist);
  await writeFile(
    join(dist, "index.html"),
    `<!doctype html><style>*{box-sizing:border-box}html,body{margin:0}#root{position:relative;width:320px;height:180px;overflow:hidden;background:rgb(255,255,255)}#hero{position:absolute;left:10px;top:20px;width:80px;height:30px;color:rgb(80,80,80);background:rgb(255,255,255)}#gradient{position:absolute;left:10px;top:80px;color:white;background:linear-gradient(90deg,black,white)}#clipped{position:absolute;left:300px;top:130px;width:100px;color:black}</style><div id="root"><div id="hero">Supplied</div><div id="gradient">Complex background</div><div id="clipped" data-velocast-source="src/Fixture.tsx:12">Clipped text</div></div><script>window.__velocast={protocolVersion:${BROWSER_PROTOCOL_VERSION},session:null,ready:false,async beginSession(value){this.session=value},getSession(){return this.session},cancelPending(){},async destroy(){},async setInputProps(){},async waitForReady(){this.ready=true},async getCompositions(){return [{id:'fixture',width:320,height:180,fps:30,durationFrames:10,target:'#root'}]},async getDurationFrames(){return 10},async seekFrame(id,frame,context){if(!this.ready)throw Error('readiness was not awaited');if(context.renderSession.sourceVersion!==this.session.sourceVersion)throw Error('session mismatch');document.querySelector('#hero').style.left=(10+frame*5)+'px';}};</script>`,
  );

  const config = {
    entry: join(dist, "index.html"),
    renderer: { snapshotRoot: dist },
  };
  const good = join(root, "good.json");
  await writeFile(
    good,
    JSON.stringify({
      selectors: [
        {
          selector: "#hero",
          visible: true,
          insideComposition: true,
          noClipping: true,
          minContrast: 7,
          motion: { fromFrame: 0, toFrame: 9, minPixels: 40 },
        },
      ],
    }),
  );
  const report = await auditComposition(config, "fixture", {
    frames: "0,9",
    assertions: good,
  });
  expect(report.status).toBe("passed");
  expect(report.source.sourceVersion).toMatch(/^[a-f0-9]{64}$/);
  expect(report.sampledFrames.map((item) => item.frame)).toEqual([0, 9]);
  expect(report.motion[0]?.distancePixels).toBe(45);
  expect(report.sampledFrames[0]?.automaticTextAudit).toMatchObject({
    truncated: false,
    findings: expect.arrayContaining([
      expect.objectContaining({
        selector: "#clipped",
        source: "src/Fixture.tsx:12",
      }),
    ]),
  });
  const strictAutomatic = await auditComposition(config, "fixture", {
    frames: "0",
    strict: true,
  });
  expect(strictAutomatic.status).toBe("failed");
  expect(strictAutomatic.issues.map((item) => item.code)).toContain(
    "automatic.layout.clipped",
  );
  const bad = join(root, "bad.json");
  await writeFile(
    bad,
    JSON.stringify({
      selectors: [
        {
          selector: "#hero",
          minContrast: 10,
          motion: { fromFrame: 0, toFrame: 9, minPixels: 100 },
        },
        { selector: "#gradient", minContrast: 1 },
      ],
    }),
  );
  const failed = await auditComposition(config, "fixture", { assertions: bad });
  expect(failed.status).toBe("failed");
  expect(failed.issues.map((item) => item.code)).toEqual(
    expect.arrayContaining(["contrast.below_minimum", "motion.below_minimum"]),
  );
  expect(
    failed.sampledFrames[0]?.selectors.find(
      (item) => item.selector === "#gradient",
    )?.contrast,
  ).toBeNull();
}, 20_000);

it("checks a real generated video frame through the snapshot media endpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "velocast-agent-video-audit-"));
  roots.push(root);
  const dist = join(root, "dist");
  await mkdir(dist);
  await exec("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=64x64:d=1:r=30",
    "-pix_fmt",
    "yuv420p",
    join(dist, "clip.mp4"),
  ]);
  await writeFile(
    join(dist, "index.html"),
    `<!doctype html><style>html,body{margin:0}#root{width:64px;height:64px}canvas{display:block;width:64px;height:64px}</style><div id="root"><canvas id="frame" width="64" height="64"></canvas></div><script>window.__velocast={protocolVersion:${BROWSER_PROTOCOL_VERSION},session:null,async beginSession(value){this.session=value},getSession(){return this.session},cancelPending(){},async destroy(){},async setInputProps(){},async waitForReady(){},async getCompositions(){return [{id:'video',width:64,height:64,fps:30,durationFrames:30,target:'#root'}]},async getDurationFrames(){return 30},async seekFrame(id,frame,context){const query=new URLSearchParams({src:'clip.mp4',seconds:String(frame/30),sessionId:this.session.sessionId,sourceVersion:this.session.sourceVersion});const response=await fetch('/__velocast-media/frame?'+query);if(!response.ok)throw Error('media endpoint '+response.status+': '+await response.text());const width=Number(response.headers.get('X-Velocast-Frame-Width')),height=Number(response.headers.get('X-Velocast-Frame-Height'));const pixels=new Uint8ClampedArray(await response.arrayBuffer());document.querySelector('#frame').getContext('2d').putImageData(new ImageData(pixels,width,height),0,0);}};</script>`,
  );
  const assertions = join(root, "assertions.json");
  await writeFile(
    assertions,
    JSON.stringify({
      selectors: [
        {
          selector: "#frame",
          visible: true,
          insideComposition: true,
          noClipping: true,
        },
      ],
    }),
  );
  const report = await auditComposition(
    {
      entry: join(dist, "index.html"),
      renderer: { snapshotRoot: dist },
    },
    "video",
    { frames: "0,15", assertions },
  );
  expect(report.status).toBe("passed");
  expect(report.sampledFrames.map((sample) => sample.frame)).toEqual([0, 15]);
}, 30_000);

it("fails a frame when an already-complete authored image is broken", async () => {
  const root = await mkdtemp(join(tmpdir(), "velocast-agent-broken-image-"));
  roots.push(root);
  const dist = join(root, "dist");
  await mkdir(dist);
  await writeFile(
    join(dist, "index.html"),
    `<!doctype html><style>html,body{margin:0}#root{width:64px;height:64px}</style><div id="root"><img src="missing.png"></div><script>window.__velocast={protocolVersion:${BROWSER_PROTOCOL_VERSION},session:null,async beginSession(value){this.session=value},getSession(){return this.session},cancelPending(){},async destroy(){},async setInputProps(){},async waitForReady(){},async getCompositions(){return [{id:'broken',width:64,height:64,fps:30,durationFrames:1,target:'#root'}]},async getDurationFrames(){return 1},async seekFrame(){}};</script>`,
  );
  await expect(
    auditComposition(
      {
        entry: join(dist, "index.html"),
        renderer: { snapshotRoot: dist },
      },
      "broken",
      { frames: "0" },
    ),
  ).rejects.toThrow("VELOCAST_IMAGE_DECODE_FAILED");
}, 20_000);

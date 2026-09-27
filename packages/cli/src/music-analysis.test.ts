import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { analyzeMusic } from "./music-analysis.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

it("decodes real generated audio and reports measured energy plus uncertain onset candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "velocast-music-analysis-"));
  roots.push(root);
  const source = join(root, "pulses.wav");
  await exec("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc=if(lt(mod(t\\,0.5)\\,0.06)\\,0.8*sin(2*PI*440*t)\\,0):s=11025:d=2",
    "-ac",
    "1",
    source,
  ]);
  const report = await analyzeMusic(source, { maxDurationSeconds: 5 });
  expect(report.decoded).toMatchObject({
    sampleRate: 11025,
    channels: 1,
    truncated: false,
  });
  expect(report.decoded.analyzedSeconds).toBeCloseTo(2, 1);
  expect(report.energy.length).toBeGreaterThan(4);
  expect(
    Math.max(...report.energy.map((item) => item.normalized)),
  ).toBeGreaterThan(0.4);
  expect(report.beatCandidates.length).toBeGreaterThanOrEqual(2);
  expect(report.beatCandidates.every((item) => item.confidence < 1)).toBe(true);
  expect(report.method.limits.join(" ")).toContain("not tempo");
});

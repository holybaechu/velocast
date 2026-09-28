import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  link,
  access,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { renderAudioPlanPcm } from "./audio-plan-render.js";
import type { MediaRunner } from "./media-runtime.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "velocast-pcm-test-"));
  roots.push(root);
  const outputPath = join(root, "output.f32");
  await writeFile(outputPath, "original");
  return { root, outputPath };
}
const plan = { sampleRate: 48000, durationSamples: 4, clips: [] };
function runner(mode: string): MediaRunner {
  return async <T>(op: { [key: string]: unknown }): Promise<T> => {
    const bytes = Buffer.alloc(mode === "short" ? 3 : 16);
    if (mode === "nan") bytes.writeFloatLE(NaN);
    await writeFile(String(op.outputPath), bytes);
    if (mode === "fail") throw new Error("decode failed");
    return {} as T;
  };
}
it.each(["short", "nan", "fail"])(
  "preserves existing output and cleans staging after %s",
  async (mode) => {
    const f = await fixture();
    let stage = "";
    const mediaRunner: MediaRunner = async <T>(op: {
      kind: string;
      [key: string]: unknown;
    }): Promise<T> => {
      stage = String(op.outputPath);
      return runner(mode)<T>(op);
    };
    await expect(
      renderAudioPlanPcm(plan, {
        outputPath: f.outputPath,
        channelCount: 1,
        mediaRunner,
      }),
    ).rejects.toThrow();
    expect(await readFile(f.outputPath, "utf8")).toBe("original");
    await expect(access(stage)).rejects.toThrow();
  },
);
it("snapshots caller options and verifies exact finite PCM before publishing", async () => {
  const f = await fixture();
  const input = { ...plan };
  const options = {
    outputPath: f.outputPath,
    channelCount: 1 as 1 | 2,
    mediaRunner: runner("ok"),
  };
  const pending = renderAudioPlanPcm(input, options);
  input.durationSamples = 100;
  options.channelCount = 2;
  expect(await pending).toMatchObject({
    bytes: 16,
    channelCount: 1,
    durationSamples: 4,
  });
  expect(await readFile(f.outputPath)).toEqual(Buffer.alloc(16));
});
it("cancels pending media work and removes private partial bytes", async () => {
  const f = await fixture();
  const owner = new AbortController();
  let ready!: () => void,
    stage = "";
  const started = new Promise<void>((resolve) => (ready = resolve));
  const mediaRunner: MediaRunner = async <T>(
    op: { kind: string; [key: string]: unknown },
    options?: { signal?: AbortSignal },
  ): Promise<T> => {
    stage = String(op.outputPath);
    await writeFile(stage, "partial");
    ready();
    await new Promise((_, reject) =>
      options!.signal!.addEventListener(
        "abort",
        () => reject(options!.signal!.reason),
        { once: true },
      ),
    );
    return {} as T;
  };
  const pending = renderAudioPlanPcm(plan, {
    outputPath: f.outputPath,
    channelCount: 1,
    signal: owner.signal,
    mediaRunner,
  });
  const rejection = expect(pending).rejects.toMatchObject({
    name: "AbortError",
  });
  await started;
  owner.abort();
  await rejection;
  expect(await readFile(f.outputPath, "utf8")).toBe("original");
  await expect(access(stage)).rejects.toThrow();
});
it("protects source aliases and validates channel maps before rendering", async () => {
  const f = await fixture();
  const source = join(f.root, "source.wav");
  await link(f.outputPath, source);
  const input = {
    ...plan,
    clips: [
      {
        source,
        sourceStartSample: 0,
        startSample: 0,
        durationSamples: 4,
        gain: 1,
      },
    ],
  };
  await expect(
    renderAudioPlanPcm(input, { outputPath: f.outputPath, channelCount: 1 }),
  ).rejects.toThrow(/source file alias/);
  await expect(
    renderAudioPlanPcm(input, {
      outputPath: f.outputPath,
      channelCount: 1,
      sourceChannelCounts: new Map(),
    }),
  ).rejects.toThrow(/missing/);
  await expect(
    renderAudioPlanPcm(input, {
      outputPath: f.outputPath,
      channelCount: 1,
      sourceChannelCounts: new Map([[source, 3 as 1]]),
    }),
  ).rejects.toThrow(/1 or 2/);
});

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildCompositionRenderCommandJobFromSource,
  buildUrlRenderCommandJob,
  buildCaptureProbeCommandJobFromSource,
} from "./render-command-job.js";
import { validateComposition } from "@velocast/core";
import {
  validateCompositionManifest,
  validateRenderContext,
  validateRenderJob,
  validateAudioPlan,
} from "./generated/renderer-contracts.js";
import { parseRendererEventLog } from "./renderer-events.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
let fixtureExecutable: string;

beforeAll(() => {
  const output = execFileSync(
    "cargo",
    [
      "build",
      "--locked",
      "-p",
      "velocast-protocol",
      "--example",
      "wire-conformance",
      "--target-dir",
      resolve(repoRoot, "target/protocol-conformance"),
      "--message-format=json",
    ],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const artifact = output
    .split(/\r?\n/)
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          reason?: string;
          target?: { name: string };
          executable?: string;
        },
    )
    .find(
      (entry) =>
        entry.reason === "compiler-artifact" &&
        entry.target?.name === "wire-conformance",
    );
  if (!artifact?.executable)
    throw new Error("protocol conformance fixture was not built");
  fixtureExecutable = artifact.executable;
}, 120_000);

function native(command: string, value?: unknown): string {
  return execFileSync(fixtureExecutable, [command], {
    input: value === undefined ? undefined : JSON.stringify(value),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

describe("cross-language renderer wire", () => {
  it("round-trips sample audio plans and rejects unsafe numeric domains on both sides", () => {
    const clip = {
      source: "song.wav",
      startSample: -2,
      sourceStartSample: 4,
      durationSamples: 10,
      gain: 0.5,
    };
    const plan = { sampleRate: 48000, durationSamples: 10, clips: [clip] };
    validateAudioPlan(plan);
    expect(JSON.parse(native("audio-plans", [plan]))).toEqual([plan]);
    for (const invalid of [
      { ...plan, sampleRate: 0 },
      { ...plan, durationSamples: Number.MAX_SAFE_INTEGER + 1 },
      {
        ...plan,
        clips: [{ ...clip, startSample: Number.MIN_SAFE_INTEGER - 1 }],
      },
      { ...plan, clips: [{ ...clip, sourceStartSample: -1 }] },
      { ...plan, clips: [{ ...clip, durationSamples: 0.5 }] },
      { ...plan, clips: [{ ...clip, gain: -1 }] },
      { ...plan, clips: [{ ...clip, gain: Infinity }] },
      { ...plan, clips: [null] },
    ]) {
      expect(() => validateAudioPlan(invalid)).toThrow();
      expect(() => native("audio-plans", [invalid])).toThrow();
    }
  });
  it("preserves browser metadata names, omitted/null fields and native numeric widths", () => {
    const manifest = validateComposition("hero", {
      width: 1920,
      height: 1080,
      fps: 60,
      durationFrames: 120,
      target: "#hero",
      maxConcurrency: 3,
    });
    const decoded = JSON.parse(native("metadata", [manifest])) as unknown[];
    validateCompositionManifest(decoded[0]);
    expect(decoded).toEqual([{ ...manifest, url: null }]);

    const contexts = [
      {
        compositionId: "hero",
        width: 1920,
        height: 1080,
        fps: 60,
        durationFrames: 120,
        inputProps: { title: "hello" },
      },
      {
        compositionId: "hero",
        width: 0,
        height: 0xffff_ffff,
        fps: 0,
        durationFrames: 0,
        inputProps: null,
      },
    ];
    const decodedContexts = JSON.parse(
      native("contexts", contexts),
    ) as unknown[];
    decodedContexts.forEach(validateRenderContext);
    expect(decodedContexts[0]).toEqual({ ...contexts[0], target: null });
    expect(decodedContexts[1]).toEqual({
      compositionId: "hero",
      width: 0,
      height: 0xffff_ffff,
      fps: 0,
      durationFrames: 0,
      target: null,
    });
    expect(() =>
      validateCompositionManifest({ ...manifest, width: 0x1_0000_0000 }),
    ).toThrow("CompositionManifest.width");
    expect(() =>
      native("metadata", [{ ...manifest, width: 0x1_0000_0000 }]),
    ).toThrow();
  });

  it("agrees on defaults, null options, worker requirements and invalid integer domains", () => {
    const minimal = {
      mode: "composition",
      serve_url: "http://localhost:4545",
      output: "out.mp4",
      codec: "libx264",
    };
    const jobs = [
      minimal,
      {
        ...minimal,
        concurrency: null,
        bitrate_bps: null,
        extra_field: "future",
      },
      {
        ...minimal,
        mode: "composition_worker",
        frame_start: 0,
        frame_end: 10,
        frame_step: 2,
        chunk_output: "chunk.bgra",
      },
    ];
    const decoded = JSON.parse(native("jobs", jobs)) as unknown[];
    decoded.forEach(validateRenderJob);
    expect(decoded[0]).toMatchObject({
      acceleration: "auto",
      assembly_mode: "auto",
      verify_segments: false,
      concurrency: null,
    });
    for (const invalid of [
      { ...minimal, concurrency: 0 },
      { ...minimal, concurrency: 0x1_0000_0000 },
      { ...minimal, bitrate_bps: -1 },
      { ...minimal, acceleration: null },
      { ...minimal, mode: "url" },
      { ...minimal, frame_start: 0 },
      { ...minimal, mode: "composition_worker", frame_start: 0, frame_end: 10 },
    ]) {
      expect(() => validateRenderJob(invalid)).toThrow();
      expect(() => native("jobs", [invalid])).toThrow();
    }
  });

  it("validates serialized Rust events, including nullable fields and large counters", () => {
    const events = parseRendererEventLog(native("events"));
    expect(events.map((event) => event.event)).toEqual([
      "renderer_started",
      "pipeline_plan_resolved",
      "frame_rendered",
      "frame_encoded",
      "renderer_finished",
      "renderer_failed",
    ]);
    expect(events[1]).toMatchObject({
      route: "parallel_segments",
      effective_concurrency: 3,
    });
    expect(events[4]).toMatchObject({
      cpu_readback_frames: 4_294_967_296,
      fallback_reason: null,
    });
  });

  it("decodes actual CLI composition, URL and probe jobs using the browser-independent protocol crate", () => {
    const paths = { cwd: repoRoot };
    const jobs = [
      buildCompositionRenderCommandJobFromSource(
        {
          renderer: {
            bitrate: "60M",
            concurrency: 3,
            eventLogPath: "events.jsonl",
          },
        },
        "hero",
        "http://localhost:4545",
        resolve(repoRoot, "out.mp4"),
        {},
        paths,
      ),
      buildUrlRenderCommandJob(
        {},
        "https://example.com",
        "#hero",
        "url.mp4",
        {},
        paths,
      ),
      buildCaptureProbeCommandJobFromSource(
        {},
        "hero",
        "http://localhost:4545",
        { report: "probe.json" },
        paths,
      ),
    ];
    const decoded = JSON.parse(native("jobs", jobs)) as unknown[];
    jobs.forEach((job, index) => {
      expect(decoded[index]).toMatchObject(job);
      validateRenderJob(decoded[index]);
    });
    expect(decoded[0]).toMatchObject({
      bitrate_bps: 60_000_000,
      concurrency: 3,
      verify_segments: false,
    });
    expect(decoded[1]).toMatchObject({
      mode: "url",
      selector: "#hero",
      composition_id: null,
    });
    expect(decoded[2]).toMatchObject({
      acceleration: "required",
      capture_probe: "accelerated_paint",
    });
  });
});

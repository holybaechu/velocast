import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCaptureProbeCommandJob,
  buildCompositionRenderCommandJob,
  buildUrlRenderCommandJob,
  captureProbeOutputPath,
  resolveCaptureProbeOutputPath,
} from "./render-command-job.js";

const tempDirs: string[] = [];

function mkTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "velocast-render-command-job-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("buildCompositionRenderCommandJob", () => {
  it("accepts numeric CLI scalars and applies them before config defaults", () => {
    const job = buildCompositionRenderCommandJob(
      {
        serve: { url: "http://127.0.0.1:4545" },
        renderer: { concurrency: 2, bitrate: "40M" },
      },
      "product-hero",
      "renders/hero.mp4",
      { concurrency: 4, bitrate: 60_000_000 },
    );

    expect(job).toStrictEqual({
      mode: "composition",
      composition_id: "product-hero",
      serve_url: "http://127.0.0.1:4545",
      selector: null,
      output: "renders/hero.mp4",
      codec: "h264",
      pixel_format: "yuv420p",
      acceleration: "auto",
      assembly_mode: "auto",
      concurrency: 4,
      bitrate_bps: 60_000_000,
    });
  });

  it("defaults an unspecified codec to logical h264 and omits unset optional fields", () => {
    expect(
      buildCompositionRenderCommandJob(
        { serve: { url: "http://127.0.0.1:4545" } },
        "product-hero",
        "renders/hero.mp4",
      ),
    ).toStrictEqual({
      mode: "composition",
      composition_id: "product-hero",
      serve_url: "http://127.0.0.1:4545",
      selector: null,
      output: "renders/hero.mp4",
      codec: "h264",
      pixel_format: "yuv420p",
      acceleration: "auto",
      assembly_mode: "auto",
    });
  });

  it("builds composition jobs using shared renderer option precedence", () => {
    const cwd = mkTempDir();
    const inputPropsFile = join(cwd, "input-props.json");
    writeFileSync(inputPropsFile, '{"title":"Launch"}');

    const job = buildCompositionRenderCommandJob(
      {
        serve: { url: "http://127.0.0.1:4545" },
        renderer: {
          concurrency: 2,
          pixelFormat: "yuv420p",
          bitrate: "40M",
          acceleration: "required",
          assembly: "reference",
          reportPath: "config-report.json",
          eventLogPath: "config-events.jsonl",
          verifySegments: true,
        },
      },
      "product-hero",
      "/tmp/product-hero.mp4",
      {
        concurrency: "auto",
        bitrate: "60M",
        assembly: "segments",
        report: "cli-report.json",
        events: "cli-events.jsonl",
        inputPropsFile: "input-props.json",
      },
      { cwd, env: {} },
    );

    expect(job).toMatchObject({
      mode: "composition",
      composition_id: "product-hero",
      serve_url: "http://127.0.0.1:4545",
      output: "/tmp/product-hero.mp4",
      concurrency: "auto",
      pixel_format: "yuv420p",
      bitrate_bps: 60_000_000,
      acceleration: "required",
      assembly_mode: "segments",
      report_path: join(cwd, "cli-report.json"),
      event_log_path: join(cwd, "cli-events.jsonl"),
      verify_segments: true,
      input_props_path: inputPropsFile,
    });
  });

  it("builds composition jobs from entry-backed configs", () => {
    const cwd = mkTempDir();
    const entry = join(cwd, "index.html");
    writeFileSync(entry, "<!doctype html>");

    const job = buildCompositionRenderCommandJob(
      {
        entry: "index.html",
        renderer: { acceleration: "off" },
      },
      "product-hero",
      "/tmp/product-hero.mp4",
      {},
      { cwd, env: {} },
    );

    expect(job).toMatchObject({
      mode: "composition",
      composition_id: "product-hero",
      serve_url: pathToFileURL(entry).href,
      output: "/tmp/product-hero.mp4",
      acceleration: "off",
    });
  });

  it("keeps serve.url precedence over entry when both are configured", () => {
    const job = buildCompositionRenderCommandJob(
      {
        entry: "missing.html",
        serve: { url: "http://127.0.0.1:4545" },
      },
      "product-hero",
      "/tmp/product-hero.mp4",
    );

    expect(job.serve_url).toBe("http://127.0.0.1:4545");
  });

  it("rejects blank composition job inputs before building renderer JSON", () => {
    expect(() =>
      buildCompositionRenderCommandJob(
        {},
        "product-hero",
        "/tmp/product-hero.mp4",
      ),
    ).toThrow("config serve.url or entry is required for render");

    expect(() =>
      buildCompositionRenderCommandJob(
        { serve: { url: "http://127.0.0.1:4545" } },
        " ",
        "/tmp/product-hero.mp4",
      ),
    ).toThrow("compositionId must be a non-empty string");
  });

  it("keeps blank CLI report path errors tied to the CLI flag", () => {
    expect(() =>
      buildCompositionRenderCommandJob(
        { serve: { url: "http://127.0.0.1:4545" } },
        "product-hero",
        "/tmp/product-hero.mp4",
        { report: " " },
      ),
    ).toThrow("--report must be a non-empty string");
  });

  it("keeps blank CLI event path errors tied to the CLI flag", () => {
    expect(() =>
      buildCompositionRenderCommandJob(
        { serve: { url: "http://127.0.0.1:4545" } },
        "product-hero",
        "/tmp/product-hero.mp4",
        { events: " " },
      ),
    ).toThrow("--events must be a non-empty string");
  });

  it("keeps blank configured report path errors tied to renderer config", () => {
    expect(() =>
      buildCompositionRenderCommandJob(
        {
          serve: { url: "http://127.0.0.1:4545" },
          renderer: { reportPath: " " },
        },
        "product-hero",
        "/tmp/product-hero.mp4",
      ),
    ).toThrow("renderer.reportPath must be a non-empty string");
  });

  it("keeps blank configured event path errors tied to renderer config", () => {
    expect(() =>
      buildCompositionRenderCommandJob(
        {
          serve: { url: "http://127.0.0.1:4545" },
          renderer: { eventLogPath: " " },
        },
        "product-hero",
        "/tmp/product-hero.mp4",
      ),
    ).toThrow("renderer.eventLogPath must be a non-empty string");
  });

  it("uses CLI codec before configured renderer codec", () => {
    const job = buildCompositionRenderCommandJob(
      { serve: { url: "http://localhost:3000" }, renderer: { codec: "hevc" } },
      "product-hero",
      "renders/out.mp4",
      { codec: "av1" },
    );

    expect(job.codec).toBe("av1");
  });

  it("forwards explicit media format choices and leaves container inference to the runtime", () => {
    const job = buildCompositionRenderCommandJob(
      {
        serve: { url: "http://127.0.0.1:4545" },
        renderer: {
          container: "mov",
          audioCodec: "aac",
          mediaBackend: "webcodecs",
          videoProfile: "prores_ks",
        },
      },
      "product-hero",
      "renders/hero.mov",
      {
        container: "mkv",
        audioCodec: "flac",
        mediaBackend: "native",
        videoProfile: "prores_4444",
      },
    );
    expect(job).toMatchObject({
      container: "mkv",
      audio_codec: "flac",
      media_backend: "native",
      video_profile: "prores_4444",
    });
    const inferred = buildCompositionRenderCommandJob(
      { serve: { url: "http://127.0.0.1:4545" } },
      "product-hero",
      "renders/hero.webm",
    );
    expect(Object.hasOwn(inferred, "container")).toBe(false);
    expect(
      buildCompositionRenderCommandJob(
        { serve: { url: "http://127.0.0.1:4545" } },
        "product-hero",
        "renders/hero.mov",
        { codec: "prores" },
      ).pixel_format,
    ).toBe("yuv422p10le");
    expect(
      buildCompositionRenderCommandJob(
        { serve: { url: "http://127.0.0.1:4545" } },
        "product-hero",
        "renders/hero.webm",
      ).codec,
    ).toBe("vp9");
    expect(
      buildCompositionRenderCommandJob(
        { serve: { url: "http://127.0.0.1:4545" } },
        "product-hero",
        "renders/hero.webm",
        { codec: "h264" },
      ).codec,
    ).toBe("h264");
  });
});

describe("buildUrlRenderCommandJob", () => {
  it("normalizes numeric CLI scalars through the same URL job preparation", () => {
    const job = buildUrlRenderCommandJob(
      { renderer: { concurrency: "auto", bitrate: "12M" } },
      "http://127.0.0.1:4545/page",
      "#hero",
      "renders/hero.mp4",
      { concurrency: 3, bitrate: 40_000_000 },
    );

    expect(job).toMatchObject({
      mode: "url",
      composition_id: null,
      selector: "#hero",
      concurrency: 3,
      bitrate_bps: 40_000_000,
    });
  });

  it("builds URL jobs and lets CLI flags override config booleans", () => {
    const job = buildUrlRenderCommandJob(
      {
        renderer: {
          codec: "hevc",
          acceleration: "off",
          reportPath: "config-report.json",
          verifySegments: true,
        },
      },
      "http://127.0.0.1:4545/page",
      "#hero",
      "/tmp/hero.mp4",
      {
        codec: "av1",
        pixelFormat: "rgb24",
        report: undefined,
        verifySegments: false,
      },
      { cwd: "/workspace/project", env: {} },
    );

    expect(job).toMatchObject({
      mode: "url",
      composition_id: null,
      serve_url: "http://127.0.0.1:4545/page",
      selector: "#hero",
      output: "/tmp/hero.mp4",
      codec: "av1",
      acceleration: "off",
      pixel_format: "rgb24",
      report_path: "/workspace/project/config-report.json",
    });
    expect(Object.prototype.hasOwnProperty.call(job, "verify_segments")).toBe(
      false,
    );
  });

  it("uses configured URL job codec when CLI codec is absent", () => {
    const job = buildUrlRenderCommandJob(
      {
        serve: { url: "http://localhost:3000" },
        renderer: { codec: "hevc" },
      },
      "http://127.0.0.1:4545/page",
      "#hero",
      "/tmp/hero.mp4",
    );

    expect(job.codec).toBe("hevc");
  });

  it("lets CLI codec override configured URL job codec", () => {
    const job = buildUrlRenderCommandJob(
      {
        serve: { url: "http://localhost:3000" },
        renderer: { codec: "hevc" },
      },
      "http://127.0.0.1:4545/page",
      "#hero",
      "/tmp/hero.mp4",
      { codec: "av1" },
    );

    expect(job.codec).toBe("av1");
  });

  it("rejects blank URL render inputs before building renderer JSON", () => {
    expect(() =>
      buildUrlRenderCommandJob({}, " ", "#hero", "/tmp/hero.mp4"),
    ).toThrow("render-url url must be a non-empty string");

    expect(() =>
      buildUrlRenderCommandJob(
        {},
        "http://127.0.0.1:4545/page",
        " ",
        "/tmp/hero.mp4",
      ),
    ).toThrow("--selector must be a non-empty string");
  });
});

describe("buildCaptureProbeCommandJob", () => {
  it("exposes the same deterministic output path used by probe jobs", () => {
    expect(captureProbeOutputPath).toBe(
      ".velocast/tmp/capture-probe-unused.mp4",
    );
    expect(
      resolveCaptureProbeOutputPath({ cwd: "/workspace/app", env: {} }),
    ).toBe("/workspace/app/.velocast/tmp/capture-probe-unused.mp4");
  });

  it("builds accelerated paint probe jobs with deterministic paths", () => {
    const cwd = mkTempDir();
    const inputPropsFile = join(cwd, "probe-props.json");
    writeFileSync(inputPropsFile, '{"kind":"probe"}');

    const job = buildCaptureProbeCommandJob(
      {
        serve: { url: "http://127.0.0.1:4545" },
        renderer: {
          acceleration: "off",
          pixelFormat: "rgb24",
          assembly: "segments",
          reportPath: "ignored-config-report.json",
          eventLogPath: "ignored-config-events.jsonl",
          verifySegments: true,
        },
      },
      "product-hero",
      {
        report: "reports/capture.json",
        inputPropsFile: "probe-props.json",
      },
      { cwd, env: {} },
    );

    expect(job).toStrictEqual({
      mode: "composition",
      composition_id: "product-hero",
      serve_url: "http://127.0.0.1:4545",
      selector: null,
      output: join(cwd, ".velocast/tmp/capture-probe-unused.mp4"),
      codec: "h264",
      pixel_format: "nv12",
      acceleration: "required",
      assembly_mode: "reference",
      report_path: join(cwd, "reports/capture.json"),
      input_props_path: inputPropsFile,
      capture_probe: "accelerated_paint",
    });
  });

  it("builds accelerated paint probe jobs from entry-backed configs", () => {
    const cwd = mkTempDir();
    const entry = join(cwd, "index.html");
    writeFileSync(entry, "<!doctype html>");

    const job = buildCaptureProbeCommandJob(
      { entry: "index.html" },
      "product-hero",
      { report: "reports/capture.json" },
      { cwd, env: {} },
    );

    expect(job).toMatchObject({
      mode: "composition",
      composition_id: "product-hero",
      serve_url: pathToFileURL(entry).href,
      capture_probe: "accelerated_paint",
      report_path: join(cwd, "reports/capture.json"),
    });
  });

  it("keeps probe command validation errors explicit", () => {
    expect(() =>
      buildCaptureProbeCommandJob({}, "product-hero", {
        report: "reports/capture.json",
      }),
    ).toThrow("config serve.url or entry is required for render");

    expect(() =>
      buildCaptureProbeCommandJob(
        { serve: { url: "http://127.0.0.1:4545" } },
        "product-hero",
        {},
      ),
    ).toThrow("--report is required for probe-capture");

    expect(() =>
      buildCaptureProbeCommandJob(
        { serve: { url: "http://127.0.0.1:4545" } },
        "product-hero",
        { report: " " },
      ),
    ).toThrow("--report must be a non-empty string");

    expect(() =>
      buildCaptureProbeCommandJob(
        { serve: { url: "http://127.0.0.1:4545" } },
        "product-hero",
        { report: "" },
      ),
    ).toThrow("--report must be a non-empty string");

    expect(() =>
      buildCaptureProbeCommandJob({ serve: { url: " " } }, "product-hero", {
        report: "reports/capture.json",
      }),
    ).toThrow("config serve.url or entry is required for render");

    expect(() =>
      buildCaptureProbeCommandJob(
        { serve: { url: "http://127.0.0.1:4545" } },
        " ",
        { report: "reports/capture.json" },
      ),
    ).toThrow("compositionId must be a non-empty string");
  });
});

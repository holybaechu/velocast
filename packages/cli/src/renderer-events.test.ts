import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  RENDERER_BACKEND_DIAGNOSTIC_CODES,
  extractRendererEventFailure,
  extractRendererEventSuccessWarning,
  parseRendererEventLog,
} from "./renderer-events.js";

describe("renderer generated contract artifacts", () => {
  it("keeps generated Rust, TypeScript, and Python artifacts fresh", () => {
    const repoRoot = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../..",
    );

    expect(() =>
      execFileSync(
        process.execPath,
        [join(repoRoot, "scripts/generate-renderer-contracts.mjs"), "--check"],
        { cwd: repoRoot, stdio: "pipe" },
      ),
    ).not.toThrow();
  });

  it("exports backend diagnostic codes from the generated contract", () => {
    expect(RENDERER_BACKEND_DIAGNOSTIC_CODES).toContain(
      "gpu.import_unavailable",
    );
    expect(RENDERER_BACKEND_DIAGNOSTIC_CODES).toContain(
      "platform.target_unavailable",
    );
  });
});

describe("parseRendererEventLog", () => {
  it("rejects malformed known events while preserving unknown event extensions", () => {
    expect(() =>
      parseRendererEventLog(
        '{"event":"frame_encoded","frame":"3","frames_encoded":1}\n',
      ),
    ).toThrow("frame_encoded.frame");
    expect(
      parseRendererEventLog(
        '{"event":"future_event","payload":{"anything":true}}\n',
      ),
    ).toEqual([{ event: "future_event", payload: { anything: true } }]);
  });

  it("parses one renderer event per JSONL line", () => {
    const events = parseRendererEventLog(
      [
        JSON.stringify({
          event: "renderer_started",
          mode: "composition",
          output: "renders/hero.mp4",
        }),
        JSON.stringify({
          event: "frame_rendered",
          frame: 3,
          capture_backend: "electron_software_bgra",
        }),
        "",
      ].join("\n"),
    );

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ event: "renderer_started" });
    expect(events[1]).toMatchObject({ event: "frame_rendered", frame: 3 });
  });

  it("rejects invalid JSONL lines with line numbers", () => {
    expect(() =>
      parseRendererEventLog(
        '{"event":"renderer_started","mode":"composition","output":"out.mp4"}\nnot-json\n',
      ),
    ).toThrow("renderer event log line 2 is not valid JSON");
  });

  it("extracts the final structured renderer failure", () => {
    const events = parseRendererEventLog(
      [
        JSON.stringify({ event: "renderer_failed", error: "first failure" }),
        JSON.stringify({ event: "renderer_failed", error: "final failure" }),
      ].join("\n"),
    );

    expect(extractRendererEventFailure(events)).toBe("final failure");
  });

  it("formats warnings from renderer_finished CPU readback facts", () => {
    const events = parseRendererEventLog(
      `${JSON.stringify({ event: "renderer_finished", frames_rendered: 4, frames_encoded: 4, fallback_used: false, cpu_readback_frames: 3 })}\n`,
    );

    expect(extractRendererEventSuccessWarning(events)).toBe(
      "renderer completed using CPU readback for 3 frame(s)",
    );
  });

  it("formats warnings from renderer_finished fallback facts", () => {
    const events = parseRendererEventLog(
      `${JSON.stringify({ event: "renderer_finished", frames_rendered: 4, frames_encoded: 4, cpu_readback_frames: 0, fallback_used: true, fallback_reason: "hardware encoder unavailable" })}\n`,
    );

    expect(extractRendererEventSuccessWarning(events)).toBe(
      "renderer completed using fallback path: hardware encoder unavailable",
    );
  });
});

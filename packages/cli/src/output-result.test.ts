import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildCompositionRenderCommandJob } from "./render-command-job.js";
import { failedOutputResult, readOutputResult } from "./output-result.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
it("accepts correlated metadata and rejects another session or requested frame", () => {
  const directory = mkdtempSync(join(tmpdir(), "velocast-result-test-"));
  directories.push(directory);
  const path = join(directory, "result.json");
  const job = buildCompositionRenderCommandJob(
    { serve: { url: "http://localhost" } },
    "hero",
    join(directory, "frame.png"),
  );
  job.render_session = { sessionId: "one", sourceVersion: "source" };
  job.operation = "frame";
  job.output_frame = 12;
  const body = {
    ...failedOutputResult(job, "pending"),
    status: "success",
    error: null,
    composition: {
      id: "hero",
      width: 320,
      height: 180,
      fps: 30,
      durationFrames: 120,
    },
    compositions: [],
  };
  writeFileSync(path, JSON.stringify(body));
  expect(readOutputResult(path, job).request.frame).toBe(12);
  writeFileSync(
    path,
    JSON.stringify({
      ...body,
      composition: { ...body.composition, id: "other" },
    }),
  );
  expect(() => readOutputResult(path, job)).toThrow("output.result_mismatch");
  writeFileSync(
    path,
    JSON.stringify({
      ...body,
      renderSession: { sessionId: "other", sourceVersion: "source" },
    }),
  );
  expect(() => readOutputResult(path, job)).toThrow("output.result_mismatch");
  writeFileSync(
    path,
    JSON.stringify({ ...body, request: { ...body.request, frame: 13 } }),
  );
  expect(() => readOutputResult(path, job)).toThrow("output.result_mismatch");
  expect(() => readOutputResult(join(directory, "missing.json"), job)).toThrow(
    "output.result_missing",
  );
});

it("preserves the original requested range and explicitly labels unmanaged input", () => {
  const directory = mkdtempSync(join(tmpdir(), "velocast-result-range-"));
  directories.push(directory);
  const path = join(directory, "result.json");
  const job = buildCompositionRenderCommandJob(
    { serve: { url: "http://localhost" } },
    "hero",
    join(directory, "range.mp4"),
  );
  job.render_session = { sessionId: "unmanaged" };
  job.output_range = { startFrame: 12, endFrame: 20 };
  const body = {
    ...failedOutputResult(job, "pending"),
    status: "success",
    error: null,
    composition: {
      id: "hero",
      width: 320,
      height: 180,
      fps: 30,
      durationFrames: 120,
    },
    compositions: [],
  };
  writeFileSync(path, JSON.stringify(body));
  expect(readOutputResult(path, job).sourceMode).toBe("unversioned");
  writeFileSync(
    path,
    JSON.stringify({
      ...body,
      request: { ...body.request, range: { startFrame: 0, endFrame: 8 } },
    }),
  );
  expect(() => readOutputResult(path, job)).toThrow("output.result_mismatch");
});

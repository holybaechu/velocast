import { readFileSync } from "node:fs";
import { isObjectRecord } from "./internal/validation.js";
import {
  OUTPUT_API_VERSION,
  validateCompositionManifest,
  type CompositionManifest,
  type RenderSession,
  type OutputFrameRange,
  type RenderOperation,
} from "./generated/renderer-contracts.js";
import type { RustRenderJob } from "./render-command-job.js";

export interface OutputResult {
  apiVersion: number;
  status: "success" | "failure";
  operation: RenderOperation;
  renderSession: RenderSession | null;
  sourceMode: "snapshot" | "unversioned";
  composition: CompositionManifest | null;
  compositions: CompositionManifest[];
  request: {
    compositionId: string | null;
    frame: number | null;
    range: OutputFrameRange | null;
  };
  outputPath: string | null;
  error: { code: string; message: string } | null;
}

export class OutputFailureError extends Error {
  constructor(
    readonly result: OutputResult,
    cause: unknown,
    readonly reported: boolean,
  ) {
    super(result.error?.message ?? "renderer failed", { cause });
    this.name = "OutputFailureError";
  }
}

export function outputError(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const prefix = message.split(":", 1)[0] ?? "";
  const code =
    error instanceof Error && error.name === "RendererCancelledError"
      ? "renderer.cancelled"
      : /^[a-z][a-z0-9_]*\.[a-z0-9_.]+$/i.test(prefix)
        ? prefix
        : "renderer.failed";
  return { code, message };
}

export function failedOutputResult(
  job: Partial<RustRenderJob>,
  error: unknown,
): OutputResult {
  const session = job.render_session ?? null;
  return {
    apiVersion: OUTPUT_API_VERSION,
    status: "failure",
    operation: job.operation ?? "render",
    renderSession: session,
    sourceMode: session?.sourceVersion ? "snapshot" : "unversioned",
    composition: null,
    compositions: [],
    request: {
      compositionId: job.composition_id ?? null,
      frame: job.output_frame ?? null,
      range: job.output_range ?? null,
    },
    outputPath: job.operation === "inspect" ? null : (job.output ?? null),
    error: outputError(error),
  };
}

/** Bind the native result to this exact job, not merely any prior successful file. */
export function readOutputResult(
  path: string,
  job: RustRenderJob,
): OutputResult {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      "output.result_missing: native renderer did not return readable output metadata",
      { cause: error },
    );
  }
  if (
    !isObjectRecord(value) ||
    value.apiVersion !== OUTPUT_API_VERSION ||
    !["success", "failure"].includes(String(value.status)) ||
    value.operation !== (job.operation ?? "render") ||
    !isObjectRecord(value.request) ||
    !Array.isArray(value.compositions) ||
    !isObjectRecord(value.renderSession) ||
    value.renderSession.sessionId !== job.render_session?.sessionId ||
    (value.renderSession.sourceVersion ?? undefined) !==
      (job.render_session?.sourceVersion ?? undefined) ||
    value.sourceMode !==
      (job.render_session?.sourceVersion ? "snapshot" : "unversioned") ||
    value.request.compositionId !== (job.composition_id ?? null) ||
    value.request.frame !== (job.output_frame ?? null) ||
    value.outputPath !== (job.operation === "inspect" ? null : job.output)
  )
    throw new Error(
      "output.result_mismatch: native metadata does not match the requested job/session",
    );
  for (const composition of value.compositions)
    validateCompositionManifest(composition);
  if (value.composition !== null)
    validateCompositionManifest(value.composition);
  if (
    job.composition_id &&
    ((value.status === "success" && value.composition === null) ||
      (isObjectRecord(value.composition) &&
        value.composition.id !== job.composition_id))
  )
    throw new Error(
      "output.result_mismatch: native metadata selected a different composition",
    );
  if (
    job.operation === "inspect" &&
    job.composition_id == null &&
    value.composition !== null
  )
    throw new Error(
      "output.result_mismatch: composition listing unexpectedly selected one composition",
    );
  const expectedRange =
    job.operation === "inspect" || job.operation === "frame"
      ? null
      : (job.output_range ??
        (isObjectRecord(value.composition)
          ? { startFrame: 0, endFrame: value.composition.durationFrames }
          : null));
  const range = value.request.range;
  if (
    expectedRange === null
      ? range !== null
      : !isObjectRecord(range) ||
        range.startFrame !== expectedRange.startFrame ||
        range.endFrame !== expectedRange.endFrame
  )
    throw new Error(
      "output.result_mismatch: native metadata changed the requested output range",
    );
  if (
    value.status === "failure" &&
    (!isObjectRecord(value.error) ||
      typeof value.error.code !== "string" ||
      typeof value.error.message !== "string")
  )
    throw new Error(
      "output.result_invalid: native failure is missing its code/cause",
    );
  if (value.status === "success" && value.error !== null)
    throw new Error(
      "output.result_invalid: successful result contains an error",
    );
  return value as unknown as OutputResult;
}

export function printOutputResult(result: OutputResult, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (result.status === "failure") return;
  if (result.operation === "inspect") {
    const compositions = result.composition
      ? [result.composition]
      : result.compositions;
    for (const composition of compositions)
      process.stdout.write(
        `${composition.id}: ${composition.width}x${composition.height}, ${composition.fps}fps, ${composition.durationFrames} frames\n`,
      );
    return;
  }
  process.stdout.write(
    `${result.operation === "frame" ? "Frame" : "Video"} written: ${result.outputPath}\n`,
  );
}

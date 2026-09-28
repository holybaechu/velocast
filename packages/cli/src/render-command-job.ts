import type {
  Config,
  RendererAcceleration,
  RendererAssemblyMode,
} from "@velocast/core";
import {
  defaultRendererAcceleration,
  defaultRendererPixelFormat,
} from "./renderer-defaults.js";
import {
  resolveRendererAcceleration,
  resolveRendererAssemblyMode,
  resolveRendererBitrate,
  resolveRendererCodec,
  resolveRendererConcurrency,
  resolveRendererPixelFormat,
} from "./renderer-options.js";
import {
  assertNonEmptyString,
  resolveCliOutputPath,
  resolveCliInputPropsPath,
  resolveCliReportPath,
  type InvocationPathOptions,
} from "./paths.js";
import { resolveCompositionRenderSource } from "./render-source.js";

import {
  validateRenderJob,
  type RenderJob,
} from "./generated/renderer-contracts.js";

// Command preparation guarantees defaults and omits optional null values.
// All wire fields themselves come from the generated transport contract.
type NonNullWireFields = {
  [Field in keyof RenderJob]: Exclude<RenderJob[Field], null>;
};
export type RustRenderJob = Omit<
  NonNullWireFields,
  "mode" | "composition_id" | "selector"
> & {
  mode: "composition" | "url";
  composition_id: string | null;
  selector: string | null;
  pixel_format: string;
  acceleration: RendererAcceleration;
  assembly_mode: RendererAssemblyMode;
};

export interface RenderCommandOptions {
  json?: boolean;
  startFrame?: string | number;
  endFrame?: string | number;
  concurrency?: string | number;
  codec?: string;
  pixelFormat?: string;
  bitrate?: string | number;
  acceleration?: string;
  assembly?: string;
  report?: string;
  events?: string;
  verifySegments?: boolean;
  inputPropsFile?: string;
}

export interface ProbeCaptureCommandOptions {
  report?: string;
  inputPropsFile?: string;
}

export const captureProbeOutputPath = ".velocast/tmp/capture-probe-unused.mp4";

export function resolveCaptureProbeOutputPath(
  pathOptions: InvocationPathOptions = {},
): string {
  return resolveCliOutputPath(captureProbeOutputPath, pathOptions);
}

export function buildCompositionRenderCommandJob(
  config: Config,
  compositionId: string,
  resolvedOutput: string,
  options: RenderCommandOptions = {},
  pathOptions: InvocationPathOptions = {},
): RustRenderJob {
  const source = resolveCompositionRenderSource(config, pathOptions);
  return buildCompositionRenderCommandJobFromSource(
    config,
    compositionId,
    source.url,
    resolvedOutput,
    options,
    pathOptions,
  );
}

export function buildCompositionRenderCommandJobFromSource(
  config: Config,
  compositionId: string,
  sourceUrl: string,
  resolvedOutput: string,
  options: RenderCommandOptions = {},
  pathOptions: InvocationPathOptions = {},
): RustRenderJob {
  assertNonEmptyString(
    compositionId,
    "compositionId must be a non-empty string",
  );

  return prepareRenderCommandJob(config, options, pathOptions, {
    mode: "composition",
    composition_id: compositionId,
    serve_url: sourceUrl,
    output: resolvedOutput,
  });
}

export function buildUrlRenderCommandJob(
  config: Config,
  url: string,
  selector: string,
  resolvedOutput: string,
  options: RenderCommandOptions = {},
  pathOptions: InvocationPathOptions = {},
): RustRenderJob {
  assertNonEmptyString(url, "render-url url must be a non-empty string");
  assertNonEmptyString(selector, "--selector must be a non-empty string");

  return prepareRenderCommandJob(config, options, pathOptions, {
    mode: "url",
    serve_url: url,
    selector,
    output: resolvedOutput,
  });
}

export function buildCaptureProbeCommandJob(
  config: Config,
  compositionId: string,
  options: ProbeCaptureCommandOptions,
  pathOptions: InvocationPathOptions = {},
): RustRenderJob {
  const source = resolveCompositionRenderSource(config, pathOptions);
  return buildCaptureProbeCommandJobFromSource(
    config,
    compositionId,
    source.url,
    options,
    pathOptions,
  );
}

export function buildCaptureProbeCommandJobFromSource(
  config: Config,
  compositionId: string,
  sourceUrl: string,
  options: ProbeCaptureCommandOptions,
  pathOptions: InvocationPathOptions = {},
): RustRenderJob {
  if (options.report === undefined) {
    throw new Error("--report is required for probe-capture");
  }
  assertNonEmptyString(options.report, "--report must be a non-empty string");
  assertNonEmptyString(
    compositionId,
    "compositionId must be a non-empty string",
  );

  return finalizeRenderJob({
    mode: "composition",
    composition_id: compositionId,
    serve_url: sourceUrl,
    output: resolveCaptureProbeOutputPath(pathOptions),
    pixel_format: "nv12",
    acceleration: "required",
    assembly_mode: "reference",
    report_path: resolveCliReportPath(
      options.report,
      pathOptions,
      "--report must be a non-empty string",
    ),
    input_props_path: resolveCliInputPropsPath(
      options.inputPropsFile,
      pathOptions,
    ),
    capture_probe: "accelerated_paint",
  });
}

function prepareRenderCommandJob(
  config: Config,
  options: RenderCommandOptions,
  pathOptions: InvocationPathOptions,
  source: RenderJobFields,
): RustRenderJob {
  const acceleration = resolveRendererAcceleration(
    config,
    options.acceleration,
  );

  return finalizeRenderJob({
    ...source,
    codec: resolveRendererCodec(config, options.codec),
    pixel_format: resolveRendererPixelFormat(
      config,
      options.pixelFormat,
      acceleration,
    ),
    bitrate_bps: resolveRendererBitrate(
      config,
      normalizeCliScalar(options.bitrate),
    ),
    concurrency: resolveRendererConcurrency(
      config,
      normalizeCliScalar(options.concurrency),
    ),
    acceleration,
    assembly_mode: resolveRendererAssemblyMode(config, options.assembly),
    report_path:
      options.report !== undefined
        ? resolveCliReportPath(
            options.report,
            pathOptions,
            "--report must be a non-empty string",
          )
        : resolveCliReportPath(config.renderer?.reportPath, pathOptions),
    event_log_path:
      options.events !== undefined
        ? resolveCliReportPath(
            options.events,
            pathOptions,
            "--events must be a non-empty string",
          )
        : resolveCliReportPath(
            config.renderer?.eventLogPath,
            pathOptions,
            "renderer.eventLogPath must be a non-empty string",
          ),
    verify_segments: options.verifySegments ?? config.renderer?.verifySegments,
    input_props_path: resolveCliInputPropsPath(
      options.inputPropsFile,
      pathOptions,
    ),
  });
}

function normalizeCliScalar(
  value: string | number | undefined,
): string | undefined {
  return typeof value === "number" ? String(value) : value;
}

type RenderJobFields = Pick<RustRenderJob, "mode" | "serve_url" | "output"> &
  Partial<RustRenderJob>;

function finalizeRenderJob(fields: RenderJobFields): RustRenderJob {
  const acceleration = fields.acceleration ?? defaultRendererAcceleration;
  const job: RustRenderJob = {
    ...fields,
    composition_id: fields.composition_id ?? null,
    selector: fields.selector ?? null,
    codec: fields.codec ?? "h264",
    pixel_format:
      fields.pixel_format ?? defaultRendererPixelFormat(acceleration),
    acceleration,
    assembly_mode: fields.assembly_mode ?? "auto",
  };

  // Optional wire fields are omitted, including an explicitly disabled verification.
  for (const key of Object.keys(job) as Array<keyof RustRenderJob>) {
    if (job[key] === undefined) {
      delete job[key];
    }
  }
  if (job.verify_segments) {
    job.verify_segments = true;
  } else {
    delete job.verify_segments;
  }
  validateRenderJob(job);
  return job;
}

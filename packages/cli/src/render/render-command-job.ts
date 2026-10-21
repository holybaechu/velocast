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
  resolveRendererAudioCodec,
  resolveRendererAssemblyMode,
  resolveRendererBitrate,
  resolveRendererCodec,
  resolveRendererContainer,
  resolveRendererConcurrency,
  resolveRendererMediaBackend,
  resolveRendererPixelFormat,
  resolveRendererVideoProfile,
} from "./renderer-options.js";
import {
  assertNonEmptyString,
  resolveCliInputPropsPath,
  resolveCliReportPath,
  type InvocationPathOptions,
} from "../project/paths.js";

import {
  validateRenderJob,
  type RenderJob,
} from "../generated/renderer-contracts.js";
import { extname } from "node:path";

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
  container?: string;
  audioCodec?: string;
  mediaBackend?: string;
  videoProfile?: string;
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
  const configuredCodec = resolveRendererCodec(config, options.codec);
  const container = resolveRendererContainer(config, options.container);
  const inferredContainer =
    container ?? extname(source.output).slice(1).toLowerCase();
  const codec =
    configuredCodec ?? (inferredContainer === "webm" ? "vp9" : "h264");

  return finalizeRenderJob({
    ...source,
    codec,
    container,
    audio_codec: resolveRendererAudioCodec(config, options.audioCodec),
    media_backend: resolveRendererMediaBackend(config, options.mediaBackend),
    video_profile: resolveRendererVideoProfile(config, options.videoProfile),
    pixel_format: resolveRendererPixelFormat(
      config,
      options.pixelFormat,
      acceleration,
      codec,
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
      fields.pixel_format ??
      defaultRendererPixelFormat(acceleration, fields.codec),
    acceleration,
    assembly_mode: fields.assembly_mode ?? "auto",
  };

  // Optional wire fields are omitted, including an explicitly disabled verification.
  for (const key of Object.keys(job) as Array<keyof RustRenderJob>) {
    if (job[key] === undefined) {
      delete job[key];
    }
  }
  if (
    job.verify_segments !== undefined &&
    typeof job.verify_segments !== "boolean"
  )
    throw new Error(
      "verifySegments must be a boolean; use --verify-segments or --no-verify-segments on the CLI",
    );
  if (job.verify_segments === false) {
    delete job.verify_segments;
  }
  validateRenderJob(job);
  return job;
}

import type {
  Config,
  RendererAcceleration,
  RendererConcurrency,
} from "@velocast/core";
import {
  defaultRendererAcceleration,
  defaultRendererPixelFormat,
} from "./renderer-defaults.js";
import { isPositiveSafeInteger } from "./internal/validation.js";

type RendererAssemblyMode = Exclude<
  NonNullable<Config["renderer"]>["assembly"],
  undefined
>;

const bitrateSuffixMultipliers: Record<string, number> = {
  g: 1_000_000_000,
  m: 1_000_000,
  k: 1_000,
};

function validateRendererConcurrency(
  value: unknown,
  errorMessage: string,
): RendererConcurrency | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "auto") {
    return "auto";
  }

  if (!isPositiveSafeInteger(value)) {
    throw new Error(errorMessage);
  }

  return value;
}

export function parseCliConcurrency(
  value: string | undefined,
): RendererConcurrency | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error("--concurrency must be a positive integer or auto");
  }

  const normalized = value.trim();
  if (normalized === "auto") {
    return "auto";
  }

  if (!/^\d+$/.test(normalized)) {
    throw new Error("--concurrency must be a positive integer or auto");
  }

  const parsed = Number(normalized);
  return validateRendererConcurrency(
    parsed,
    "--concurrency must be a positive integer or auto",
  );
}

export function resolveRendererConcurrency(
  config: Config,
  cliValue?: string,
): RendererConcurrency | undefined {
  return (
    parseCliConcurrency(cliValue) ??
    validateRendererConcurrency(
      config.renderer?.concurrency,
      "renderer.concurrency must be a positive integer or auto",
    )
  );
}

function validateRendererBitrate(
  value: unknown,
  errorMessage: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  let bitrate: number;
  if (typeof value === "number") {
    bitrate = value;
  } else if (typeof value === "string") {
    const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*([kmg])?(?:bps)?$/i);
    if (!match) {
      throw new Error(errorMessage);
    }
    const scalar = Number(match[1]);
    const suffix = match[2]?.toLowerCase();
    const multiplier =
      suffix === undefined ? 1 : bitrateSuffixMultipliers[suffix];
    if (multiplier === undefined) {
      throw new Error(errorMessage);
    }
    bitrate = scalar * multiplier;
  } else {
    throw new Error(errorMessage);
  }

  if (!isPositiveSafeInteger(bitrate)) {
    throw new Error(errorMessage);
  }

  return bitrate;
}

export function parseCliBitrate(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(
      "--bitrate must be a positive bitrate such as 60M or 12000k",
    );
  }

  return validateRendererBitrate(
    value,
    "--bitrate must be a positive bitrate such as 60M or 12000k",
  );
}

export function resolveRendererBitrate(
  config: Config,
  cliValue?: string,
): number | undefined {
  return (
    parseCliBitrate(cliValue) ??
    validateRendererBitrate(
      config.renderer?.bitrate,
      "renderer.bitrate must be a positive bitrate such as 60M or 12000k",
    )
  );
}

function validateRendererCodec(
  value: unknown,
  errorMessage: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(errorMessage);
  }

  const normalized = value.trim();
  if (!normalized) {
    throw new Error(errorMessage);
  }

  if (/^(h264|hevc|av1)_vaapi$/i.test(normalized)) {
    throw new Error(
      `encoder.codec_unavailable: ${normalized} is no longer supported; select h264, hevc, or av1`,
    );
  }

  return normalized;
}

export function parseCliCodec(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error("--codec must be a non-empty string");
  }

  return validateRendererCodec(value, "--codec must be a non-empty string");
}

export function resolveRendererCodec(
  config: Config,
  cliValue?: string,
): string | undefined {
  return (
    parseCliCodec(cliValue) ??
    validateRendererCodec(
      config.renderer?.codec,
      "renderer.codec must be a non-empty string",
    )
  );
}

function validateRendererAcceleration(
  value: unknown,
  errorMessage: string,
): RendererAcceleration | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "required" || value === "auto" || value === "off") {
    return value;
  }

  throw new Error(errorMessage);
}

export function parseCliAcceleration(
  value: string | undefined,
): RendererAcceleration | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error("--acceleration must be required, auto, or off");
  }

  return validateRendererAcceleration(
    value.trim(),
    "--acceleration must be required, auto, or off",
  );
}

export function resolveRendererAcceleration(
  config: Config,
  cliValue?: string,
): RendererAcceleration {
  return (
    parseCliAcceleration(cliValue) ??
    validateRendererAcceleration(
      config.renderer?.acceleration,
      "renderer.acceleration must be required, auto, or off",
    ) ??
    defaultRendererAcceleration
  );
}

export function parseCliAssemblyMode(
  value: string | undefined,
): RendererAssemblyMode | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error("--assembly must be auto, reference, or segments");
  }

  const normalized = value.trim();
  if (
    normalized === "auto" ||
    normalized === "reference" ||
    normalized === "segments"
  ) {
    return normalized;
  }

  throw new Error("--assembly must be auto, reference, or segments");
}

export function resolveRendererAssemblyMode(
  config: Config,
  cliValue?: string,
): RendererAssemblyMode {
  const value =
    parseCliAssemblyMode(cliValue) ?? config.renderer?.assembly ?? "auto";
  if (value === "auto" || value === "reference" || value === "segments") {
    return value;
  }

  throw new Error("renderer.assembly must be auto, reference, or segments");
}

function isHardwareCompatiblePixelFormat(pixelFormat: string): boolean {
  const normalized = pixelFormat.toLowerCase();
  return normalized === "nv12" || normalized === "yuv420p";
}

function normalizeHardwarePixelFormat(pixelFormat: string): string {
  return pixelFormat.toLowerCase();
}

export function resolveRendererPixelFormat(
  config: Config,
  cliValue: string | undefined,
  acceleration: RendererAcceleration,
): string {
  const defaultPixelFormat = defaultRendererPixelFormat(acceleration);
  const rawValue: unknown =
    cliValue !== undefined
      ? cliValue
      : (config.renderer?.pixelFormat ?? defaultPixelFormat);
  const value =
    typeof rawValue === "string" && cliValue !== undefined
      ? rawValue.trim()
      : rawValue;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("renderer.pixelFormat must be a non-empty string");
  }

  if (acceleration === "required" && !isHardwareCompatiblePixelFormat(value)) {
    throw new Error(
      `accelerated rendering currently supports nv12/yuv420p output, but ${value} was requested.\nUse --pixel-format nv12, or use --acceleration off for the software BGRA path.`,
    );
  }

  return acceleration === "required"
    ? normalizeHardwarePixelFormat(value)
    : value;
}

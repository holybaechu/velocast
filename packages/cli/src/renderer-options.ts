import type {
  Config,
  RendererAudioCodec,
  RendererAcceleration,
  RendererContainer,
  RendererConcurrency,
  RendererMediaBackend,
  RendererVideoCodec,
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
): RendererVideoCodec | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(errorMessage);
  }

  const trimmed = value.trim().toLowerCase();
  const normalized = trimmed === "h265" ? "hevc" : trimmed;
  if (!normalized) {
    throw new Error(errorMessage);
  }

  if (/^(h264|hevc|av1)_vaapi$/i.test(normalized)) {
    throw new Error(
      `encoder.codec_unavailable: ${normalized} is no longer supported; select a logical video codec`,
    );
  }

  if (!["h264", "hevc", "av1", "vp8", "vp9", "prores"].includes(normalized)) {
    throw new Error(
      `${errorMessage}; expected h264, hevc, av1, vp8, vp9, or prores`,
    );
  }

  return normalized as RendererVideoCodec;
}

export function parseCliCodec(
  value: string | undefined,
): RendererVideoCodec | undefined {
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
): RendererVideoCodec | undefined {
  return (
    parseCliCodec(cliValue) ??
    validateRendererCodec(
      config.renderer?.codec,
      "renderer.codec must be a non-empty string",
    )
  );
}

function validateChoice<T extends string>(
  value: unknown,
  choices: readonly T[],
  errorMessage: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !choices.includes(value as T))
    throw new Error(`${errorMessage}; expected ${choices.join(", ")}`);
  return value as T;
}

function resolveChoice<T extends string>(
  configValue: unknown,
  cliValue: string | undefined,
  choices: readonly T[],
  cliError: string,
  configError: string,
): T | undefined {
  return (
    validateChoice(cliValue?.trim(), choices, cliError) ??
    validateChoice(configValue, choices, configError)
  );
}

export function resolveRendererContainer(
  config: Config,
  cliValue?: string,
): RendererContainer | undefined {
  return resolveChoice(
    config.renderer?.container,
    cliValue,
    ["mp4", "mov", "webm", "mkv"] as const,
    "--container must be mp4, mov, webm, or mkv",
    "renderer.container must be mp4, mov, webm, or mkv",
  );
}

export function resolveRendererAudioCodec(
  config: Config,
  cliValue?: string,
): RendererAudioCodec | undefined {
  return resolveChoice(
    config.renderer?.audioCodec,
    cliValue,
    [
      "auto",
      "aac",
      "opus",
      "mp3",
      "flac",
      "vorbis",
      "pcm-s16",
      "pcm-s24",
      "pcm-f32",
    ] as const,
    "--audio-codec must be auto, aac, opus, mp3, flac, vorbis, pcm-s16, pcm-s24, or pcm-f32",
    "renderer.audioCodec must be auto, aac, opus, mp3, flac, vorbis, pcm-s16, pcm-s24, or pcm-f32",
  );
}

export function resolveRendererMediaBackend(
  config: Config,
  cliValue?: string,
): RendererMediaBackend | undefined {
  return resolveChoice(
    config.renderer?.mediaBackend,
    cliValue,
    ["auto", "webcodecs", "native"] as const,
    "--media-backend must be auto, webcodecs, or native",
    "renderer.mediaBackend must be auto, webcodecs, or native",
  );
}

function validateVideoProfile(
  value: unknown,
  errorMessage: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(errorMessage);
  return value.trim();
}

export function resolveRendererVideoProfile(
  config: Config,
  cliValue?: string,
): string | undefined {
  return (
    validateVideoProfile(
      cliValue,
      "--video-profile must be a non-empty string",
    ) ??
    validateVideoProfile(
      config.renderer?.videoProfile,
      "renderer.videoProfile must be a non-empty string",
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
  codec?: RendererVideoCodec,
): string {
  const defaultPixelFormat = defaultRendererPixelFormat(acceleration, codec);
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

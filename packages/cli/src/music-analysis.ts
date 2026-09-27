import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { writeJsonOutput } from "./atomic-json-output.js";

export interface MusicAnalysis {
  schemaVersion: 1;
  source: string;
  decoded: {
    sampleRate: number;
    channels: 1;
    analyzedSeconds: number;
    sourceDurationSeconds: number | null;
    truncated: boolean;
  };
  energy: Array<{ timeSeconds: number; normalized: number; rms: number }>;
  beatCandidates: Array<{
    timeSeconds: number;
    strength: number;
    confidence: number;
  }>;
  method: {
    energy: string;
    beatCandidates: string;
    limits: string[];
  };
}

interface ProcessResult {
  stdout: Buffer;
  stderr: string;
}

async function runBounded(
  command: string,
  args: string[],
  maxBytes: number,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<ProcessResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let size = 0;
    let errorSize = 0;
    let forcedError: Error | undefined;
    let closed = false;
    const stop = (error: Error) => {
      if (!forcedError) forcedError = error;
      child.kill();
    };
    const timeout = setTimeout(
      () =>
        stop(
          new Error(
            `audio.analysis_timeout: ${command} exceeded ${options.timeoutMs}ms`,
          ),
        ),
      options.timeoutMs,
    );
    const abort = () =>
      stop(
        new Error("audio.analysis_cancelled", {
          cause: options.signal?.reason,
        }),
      );
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.once("error", (error) =>
      stop(
        new Error(`audio.tool_failed: ${command}: ${error.message}`, {
          cause: error,
        }),
      ),
    );
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        stop(
          new Error(`audio.analysis_limit: decoder exceeded ${maxBytes} bytes`),
        );
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = 64 * 1024 - errorSize;
      if (remaining > 0) {
        const bounded = chunk.subarray(0, remaining);
        errors.push(bounded);
        errorSize += bounded.length;
      }
    });
    child.once("close", (code, signal) => {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      const stderr = Buffer.concat(errors).toString("utf8").trim();
      if (forcedError) reject(forcedError);
      else if (code !== 0)
        reject(
          new Error(
            `audio.tool_failed: ${command} exited ${code ?? signal}: ${stderr}`,
          ),
        );
      else resolveResult({ stdout: Buffer.concat(chunks), stderr });
    });
  });
}

function samplesFromBuffer(buffer: Buffer): Float32Array {
  if (buffer.length % 4)
    throw new Error(
      "audio.invalid_decode: FFmpeg returned partial float samples",
    );
  const samples = new Float32Array(buffer.length / 4);
  for (let index = 0; index < samples.length; index++) {
    const sample = buffer.readFloatLE(index * 4);
    if (!Number.isFinite(sample))
      throw new Error("audio.invalid_decode: non-finite PCM sample");
    samples[index] = sample;
  }
  return samples;
}

function rmsWindows(
  samples: Float32Array,
  windowSize: number,
  hop: number,
): number[] {
  const result: number[] = [];
  for (let offset = 0; offset < samples.length; offset += hop) {
    const end = Math.min(offset + windowSize, samples.length);
    let square = 0;
    for (let index = offset; index < end; index++)
      square += samples[index]! * samples[index]!;
    result.push(end === offset ? 0 : Math.sqrt(square / (end - offset)));
  }
  return result;
}

function round(value: number, digits = 6): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export async function analyzeMusic(
  input: string,
  options: {
    ffmpeg?: string;
    ffprobe?: string;
    maxDurationSeconds?: number;
    sampleRate?: number;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<MusicAnalysis> {
  const source = resolve(input);
  if (!(await stat(source)).isFile())
    throw new Error(`audio.invalid_source: ${source}`);
  const maxDurationSeconds = options.maxDurationSeconds ?? 900;
  const sampleRate = options.sampleRate ?? 11_025;
  if (
    !Number.isFinite(maxDurationSeconds) ||
    maxDurationSeconds <= 0 ||
    maxDurationSeconds > 3600
  )
    throw new Error("audio.invalid_limit: max duration must be in (0, 3600]");
  if (
    !Number.isSafeInteger(sampleRate) ||
    sampleRate < 4_000 ||
    sampleRate > 48_000
  )
    throw new Error(
      "audio.invalid_sample_rate: sample rate must be 4000..48000",
    );
  if (
    options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) ||
      options.timeoutMs < 1_000 ||
      options.timeoutMs > 600_000)
  )
    throw new Error(
      "audio.invalid_timeout: timeout must be 1000..600000 milliseconds",
    );
  let sourceDurationSeconds: number | null = null;
  try {
    const probe = await runBounded(
      options.ffprobe ?? "ffprobe",
      [
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-show_entries",
        "format=duration",
        "-of",
        "default=nw=1:nk=1",
        source,
      ],
      4096,
      {
        timeoutMs: Math.min(options.timeoutMs ?? 30_000, 30_000),
        signal: options.signal,
      },
    );
    const parsed = Number(probe.stdout.toString("utf8").trim());
    if (Number.isFinite(parsed) && parsed >= 0) sourceDurationSeconds = parsed;
  } catch (error) {
    if (
      options.signal?.aborted ||
      (error instanceof Error &&
        (error.message.startsWith("audio.analysis_timeout") ||
          error.message.startsWith("audio.analysis_cancelled")))
    )
      throw error;
    // Duration is advisory; the bounded decoder remains authoritative.
  }
  const maxBytes = Math.ceil(sampleRate * maxDurationSeconds * 4) + 4096;
  const decoded = await runBounded(
    options.ffmpeg ?? "ffmpeg",
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-t",
      String(maxDurationSeconds),
      "-i",
      source,
      "-map",
      "0:a:0",
      "-vn",
      "-ac",
      "1",
      "-ar",
      String(sampleRate),
      "-f",
      "f32le",
      "pipe:1",
    ],
    maxBytes,
    { timeoutMs: options.timeoutMs ?? 120_000, signal: options.signal },
  );
  const samples = samplesFromBuffer(decoded.stdout);
  if (!samples.length)
    throw new Error("audio.no_samples: source decoded to no audio samples");
  const hop = 512;
  const rms = rmsWindows(samples, 1024, hop);
  const peak = Math.max(...rms, Number.EPSILON);
  const energy: MusicAnalysis["energy"] = [];
  const markerStride = Math.max(1, Math.round((sampleRate * 0.25) / hop));
  for (let index = 0; index < rms.length; index += markerStride) {
    const slice = rms.slice(index, Math.min(rms.length, index + markerStride));
    const value = slice.reduce((sum, item) => sum + item, 0) / slice.length;
    energy.push({
      timeSeconds: round((index * hop) / sampleRate, 4),
      normalized: round(value / peak),
      rms: round(value),
    });
  }
  const flux = rms.map((value, index) =>
    Math.max(0, value - (rms[index - 1] ?? value)),
  );
  const mean = flux.reduce((sum, value) => sum + value, 0) / flux.length;
  const deviation = Math.sqrt(
    flux.reduce((sum, value) => sum + (value - mean) ** 2, 0) / flux.length,
  );
  const threshold = mean + deviation * 1.5;
  const beatCandidates: MusicAnalysis["beatCandidates"] = [];
  const minimumGap = Math.max(1, Math.round((sampleRate * 0.2) / hop));
  let last = -minimumGap;
  for (let index = 1; index < flux.length - 1; index++) {
    if (
      flux[index]! < threshold ||
      flux[index]! < flux[index - 1]! ||
      flux[index]! < flux[index + 1]! ||
      index - last < minimumGap
    )
      continue;
    const z = deviation > 0 ? (flux[index]! - mean) / deviation : 0;
    beatCandidates.push({
      timeSeconds: round((index * hop) / sampleRate, 4),
      strength: round(flux[index]! / Math.max(...flux, Number.EPSILON)),
      confidence: round(Math.min(0.95, Math.max(0.05, 0.25 + z * 0.12)), 3),
    });
    last = index;
  }
  const analyzedSeconds = samples.length / sampleRate;
  return {
    schemaVersion: 1,
    source,
    decoded: {
      sampleRate,
      channels: 1,
      analyzedSeconds: round(analyzedSeconds, 4),
      sourceDurationSeconds:
        sourceDurationSeconds === null ? null : round(sourceDurationSeconds, 4),
      truncated:
        sourceDurationSeconds !== null &&
        sourceDurationSeconds > analyzedSeconds + 0.05,
    },
    energy,
    beatCandidates,
    method: {
      energy:
        "mono PCM RMS over 1024-sample windows, emitted at approximately 250 ms",
      beatCandidates:
        "local positive RMS flux peaks above mean + 1.5 standard deviations, separated by at least 200 ms",
      limits: [
        "Beat candidates are onset heuristics, not tempo, meter, downbeat, or musical-beat ground truth.",
        "Mono downmix and RMS omit frequency-specific rhythm and may miss soft or sustained attacks.",
        "Review markers against the source audio before timing edits or lyrics.",
      ],
    },
  };
}

export interface AnalyzeMusicCommandOptions {
  output: string;
  ffmpeg?: string;
  ffprobe?: string;
  maxDuration?: string | number;
  json?: boolean;
  overwrite?: boolean;
  write?: (text: string) => void;
}

export async function analyzeMusicCommand(
  input: string,
  options: AnalyzeMusicCommandOptions,
): Promise<MusicAnalysis> {
  const report = await analyzeMusic(input, {
    ffmpeg: options.ffmpeg,
    ffprobe: options.ffprobe,
    maxDurationSeconds:
      options.maxDuration === undefined
        ? undefined
        : Number(options.maxDuration),
  });
  const output = resolve(options.output);
  await writeJsonOutput(
    output,
    `${JSON.stringify(report, null, 2)}\n`,
    options.overwrite === true,
  );
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  write(
    options.json
      ? `${JSON.stringify({ output, ...report }, null, 2)}\n`
      : `Analyzed ${report.decoded.analyzedSeconds}s of audio: ${report.energy.length} energy markers, ${report.beatCandidates.length} heuristic onset candidates\nWritten: ${output}\n`,
  );
  return report;
}

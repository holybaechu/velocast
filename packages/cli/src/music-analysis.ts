import { runMediaOperation, type MediaProbe } from "./media-runtime.js";
import { mediaWorkspace } from "./media-workspace.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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

function samplesFromBuffer(buffer: Buffer): Float32Array {
  if (buffer.length % 4)
    throw new Error(
      "audio.invalid_decode: WebCodecs returned partial float samples",
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
  const runtimeOptions = {
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? 120_000,
  };
  const probe = await runMediaOperation<MediaProbe>(
    { kind: "probe", path: source },
    runtimeOptions,
  );
  const sourceDurationSeconds = probe.audio?.duration ?? probe.duration;
  const workspace = await mediaWorkspace();
  let samples: Float32Array;
  try {
    const outputPath = join(workspace.path, "audio.f32");
    await runMediaOperation(
      {
        kind: "decode-audio",
        path: source,
        outputPath,
        sampleRate,
        channels: 1,
        duration: maxDurationSeconds,
        format: "f32",
      },
      runtimeOptions,
    );
    const bytes = await readFile(outputPath);
    if (bytes.length > Math.ceil(sampleRate * maxDurationSeconds) * 4)
      throw new Error("audio.analysis_limit: decoder exceeded sample budget");
    samples = samplesFromBuffer(bytes);
  } finally {
    await workspace.close();
  }
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

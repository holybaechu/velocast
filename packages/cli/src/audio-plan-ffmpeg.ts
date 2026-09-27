import path from "node:path";
import { normalizeAudioPlan } from "@velocast/core";
import type { AudioPlan, AudioClip } from "@velocast/core";

export interface AudioPlanFfmpegOptions {
  /** Caller-resolved local destination. This builder never uses a shell. */
  readonly outputPath: string;
  readonly channelCount: 1 | 2;
  /** Optional discovered input layouts. A known mono source is duplicated explicitly for stereo preview parity. */
  readonly sourceChannelCounts?: ReadonlyMap<string, 1 | 2>;
}

export interface AudioPlanFfmpegCommand {
  readonly args: readonly string[];
  readonly filterGraph: string;
  readonly outputPath: string;
  readonly sourcePaths: readonly string[];
  readonly sampleRate: number;
  readonly channelCount: 1 | 2;
  readonly durationSamples: number;
  readonly expectedBytes: number;
  readonly format: "f32le";
}

function absolutePath(value: string, name: string): void {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    /[\0\r\n]/.test(value)
  )
    throw new TypeError(
      `${name} must be a caller-resolved absolute path without NUL/newlines`,
    );
}

function comparisonPath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
function sourceChannels(
  source: string,
  counts: ReadonlyMap<string, 1 | 2> | undefined,
): 1 | 2 | undefined {
  if (!counts) return undefined;
  for (const [path, channels] of counts)
    if (comparisonPath(path) === comparisonPath(source)) return channels;
  return undefined;
}

/**
 * Produce raw interleaved float32 PCM; byte length is exactly samples*channels*4.
 * The fixed-duration silence input makes missing source tails/empty trims pad
 * correctly. Gains are explicit, amix normalization is OFF, and float output
 * does not silently clip to [-1,1]. Source sample indices follow resampling;
 * container PTS are rebased after decoder priming, before sample-index trimming.
 * No source filename is interpolated into the filter graph.
 */
export function buildAudioPlanFfmpegCommand(
  plan: AudioPlan,
  options: AudioPlanFfmpegOptions,
): AudioPlanFfmpegCommand {
  const normalized = normalizeAudioPlan(plan);
  if (normalized.durationSamples === 0)
    throw new RangeError(
      "Cannot stream an empty audio plan; handle the empty slice without launching FFmpeg",
    );
  if (options.channelCount !== 1 && options.channelCount !== 2)
    throw new RangeError("channelCount must be 1 or 2");
  absolutePath(options.outputPath, "outputPath");
  const expectedBytes = normalized.durationSamples * options.channelCount * 4;
  if (!Number.isSafeInteger(expectedBytes))
    throw new RangeError("PCM output byte count must be a safe integer");
  const layout = options.channelCount === 1 ? "mono" : "stereo";
  const format = `aformat=sample_fmts=flt:sample_rates=${normalized.sampleRate}:channel_layouts=${layout}`;
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-xerror",
    "-nostdin",
    "-n",
  ];
  const filters = [
    `anullsrc=r=${normalized.sampleRate}:cl=${layout},atrim=end_sample=${normalized.durationSamples},asetpts=N/SR/TB,${format}[base]`,
  ];
  const labels = ["[base]"];
  const sourcePaths: string[] = [];
  for (const [index, clip] of normalized.clips.entries()) {
    absolutePath(clip.source, "clip source");
    if (comparisonPath(clip.source) === comparisonPath(options.outputPath))
      throw new Error("Audio output must not replace a source file");
    args.push("-i", clip.source);
    sourcePaths.push(clip.source);
    const label = `[clip${index}]`;
    labels.push(label);
    // FFmpeg's implicit mono→stereo matrix applies -3 dB per output channel.
    // Web Audio duplicates a mono AudioBufferSourceNode at unity gain instead.
    const rematrix =
      options.channelCount === 2 &&
      sourceChannels(clip.source, options.sourceChannelCounts) === 1
        ? "pan=stereo|c0=c0|c1=c0,"
        : "";
    filters.push(
      `[${index}:a:0]asetpts=PTS-STARTPTS,aresample=${normalized.sampleRate}:async=0:first_pts=0,${rematrix}${format},atrim=start_sample=${clip.sourceStartSample}:end_sample=${clip.sourceStartSample + clip.durationSamples},asetpts=N/SR/TB,${audioGainFilter(clip, options.channelCount)},adelay=delays=${clip.startSample}S:all=1,apad=whole_len=${normalized.durationSamples},atrim=end_sample=${normalized.durationSamples},asetpts=N/SR/TB${label}`,
    );
  }
  if (labels.length === 1) filters.push("[base]anull[pcm]");
  else
    filters.push(
      `${labels.join("")}amix=inputs=${labels.length}:duration=first:dropout_transition=0:normalize=0,atrim=end_sample=${normalized.durationSamples},asetpts=N/SR/TB,${format}[pcm]`,
    );
  const filterGraph = filters.join(";");
  args.push(
    "-filter_complex",
    filterGraph,
    "-map",
    "[pcm]",
    "-vn",
    "-sn",
    "-dn",
    "-map_metadata",
    "-1",
    "-ar",
    String(normalized.sampleRate),
    "-ac",
    String(options.channelCount),
    "-c:a",
    "pcm_f32le",
    "-f",
    "f32le",
    options.outputPath,
  );
  return Object.freeze({
    args: Object.freeze(args),
    filterGraph,
    outputPath: options.outputPath,
    sourcePaths: Object.freeze(sourcePaths),
    sampleRate: normalized.sampleRate,
    channelCount: options.channelCount,
    durationSamples: normalized.durationSamples,
    expectedBytes,
    format: "f32le",
  });
}

/** aeval's n is a sample index; volume eval=frame would quantize fades to decoder blocks. */
function audioGainFilter(clip: AudioClip, channels: number): string {
  const points = clip.volumeEnvelope;
  if (!points) return `volume=${clip.gain}:precision=double`;
  const segment = (first: number, last: number): string => {
    if (first === last) {
      const left = points[first]!,
        right = points[first + 1]!;
      return `${left.gain}+(${right.gain}-${left.gain})*((n-${left.sample})/${right.sample - left.sample})`;
    }
    const middle = Math.floor((first + last) / 2);
    return `if(lt(n,${points[middle + 1]!.sample}),${segment(first, middle)},${segment(middle + 1, last)})`;
  };
  const expression =
    points.length === 1
      ? String(points[0]!.gain)
      : `if(lt(n,${points[0]!.sample}),${points[0]!.gain},if(gte(n,${points.at(-1)!.sample}),${points.at(-1)!.gain},${segment(0, points.length - 2)}))`;
  return `aeval=exprs='${Array.from({ length: channels }, (_, channel) => `val(${channel})*${clip.gain}*(${expression})`).join("|")}'`;
}

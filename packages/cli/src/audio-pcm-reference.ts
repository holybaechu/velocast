import { normalizeAudioPlan, evaluateAudioEnvelope } from "@velocast/core";
import type { AudioPlan } from "@velocast/core";

export interface PlanarPcm {
  readonly sampleRate: number;
  readonly channels: readonly Float32Array[];
}

export interface PcmReferenceOptions {
  /** Per-channel sample-frame allocation bound; default is 10 minutes at 48kHz. */
  readonly maxOutputSamples?: number;
}

/**
 * Bounded offline oracle, NOT the production mixer. Production uses FFmpeg's
 * streaming graph. Sources must already be decoded, resampled and explicitly
 * converted to the requested channel count. No resampling, normalization,
 * limiting, or silent gain changes occur here; the input arrays are never changed.
 */
export function mixAudioPlanPcm(
  plan: AudioPlan,
  sources: ReadonlyMap<string, PlanarPcm>,
  channelCount: 1 | 2,
  options: PcmReferenceOptions = {},
): PlanarPcm {
  const normalized = normalizeAudioPlan(plan);
  if (channelCount !== 1 && channelCount !== 2)
    throw new RangeError("channelCount must be 1 or 2");
  const maximum = options.maxOutputSamples ?? 28_800_000;
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 0 ||
    normalized.durationSamples > maximum
  )
    throw new RangeError("PCM reference output sample budget exceeded");
  const usedSources = new Map<string, PlanarPcm>();
  for (const clip of normalized.clips) {
    if (usedSources.has(clip.source)) continue;
    const source = sources.get(clip.source);
    if (!source) throw new Error(`Missing decoded PCM source: ${clip.source}`);
    if (source.sampleRate !== normalized.sampleRate)
      throw new RangeError(
        "PCM sources must be pre-resampled to the plan sampleRate",
      );
    if (
      !Array.isArray(source.channels) ||
      source.channels.length !== channelCount
    )
      throw new RangeError(
        "PCM source channel count must match the explicit output channel count",
      );
    const length = source.channels[0]?.length;
    for (const channel of source.channels) {
      if (!(channel instanceof Float32Array) || channel.length !== length)
        throw new TypeError(
          "PCM channels must be equal-length Float32Array buffers",
        );
      for (const sample of channel)
        if (!Number.isFinite(sample))
          throw new RangeError("PCM source samples must be finite");
    }
    usedSources.set(clip.source, source);
  }
  const channels = Array.from(
    { length: channelCount },
    () => new Float32Array(normalized.durationSamples),
  );
  for (const clip of normalized.clips) {
    const source = usedSources.get(clip.source)!;
    const length = Math.min(
      clip.durationSamples,
      Math.max(0, source.channels[0]!.length - clip.sourceStartSample),
    );
    for (let index = 0; index < length; index++) {
      for (let channel = 0; channel < channelCount; channel++) {
        const scaled = Math.fround(
          source.channels[channel]![clip.sourceStartSample + index]! *
            (clip.gain * evaluateAudioEnvelope(clip.volumeEnvelope, index)),
        );
        const sum = Math.fround(
          channels[channel]![clip.startSample + index]! + scaled,
        );
        if (!Number.isFinite(sum))
          throw new RangeError("PCM gain/mix exceeds finite Float32 output");
        channels[channel]![clip.startSample + index] = sum;
      }
    }
  }
  return Object.freeze({
    sampleRate: normalized.sampleRate,
    channels: Object.freeze(channels),
  });
}

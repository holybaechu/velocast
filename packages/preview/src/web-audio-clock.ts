import {
  normalizeAudioPlan,
  sliceAudioEnvelope,
  secondsToSamples,
  samplesToSeconds,
  type AudioPlan,
} from "@velocast/core";
import type { AudioPlanClock } from "./types.js";

export interface WebAudioClockOptions {
  /** Returns source PCM decoded at context.sampleRate; caller owns immutable-source resolution. */
  loadBuffer(
    source: string,
    context: AudioContext,
    signal: AbortSignal,
  ): Promise<AudioBuffer>;
  /** The clock takes ownership and closes this context, including preparation failure. */
  createContext?(sampleRate: number): AudioContext;
  /** Bounds retained decoded buffers; the loader must separately bound decoding allocation. */
  maxDecodedBytes?: number;
  /** Cancels preparation. After preparation, the controller owns dispose(). */
  signal?: AbortSignal;
}

function cancelled(): Error {
  const error = new Error(
    "preview.audio_cancelled: audio operation was superseded",
  );
  error.name = "AbortError";
  return error;
}

/**
 * Prepared sample clock. Shared plan normalization supplies trim/offset/gain;
 * AudioContext.currentTime is the playback clock, never a second JS timer.
 * Source start(when, offset, duration) uses decoded-source seconds at rate 1.
 * https://www.w3.org/TR/webaudio-1.0/#dom-audiobuffersourcenode-start
 */
export async function prepareWebAudioClock(
  plan: AudioPlan,
  options: WebAudioClockOptions,
): Promise<AudioPlanClock> {
  const normalized = normalizeAudioPlan(plan);
  const maxBytes = options.maxDecodedBytes ?? 128 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new RangeError(
      "preview.audio_limit: maxDecodedBytes must be a positive safe integer",
    );
  options.signal?.throwIfAborted();
  const context =
    options.createContext?.(normalized.sampleRate) ??
    new AudioContext({ sampleRate: normalized.sampleRate });
  const preparation = new AbortController();
  const abort = () => preparation.abort(options.signal?.reason ?? cancelled());
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const buffers = new Map<string, AudioBuffer>();
  let decodedBytes = 0;
  try {
    if (context.sampleRate !== normalized.sampleRate)
      throw new Error(
        "preview.audio_rate_mismatch: context must use the shared plan sample rate",
      );
    for (const clip of normalized.clips) {
      if (buffers.has(clip.source)) continue;
      preparation.signal.throwIfAborted();
      // Await the loader even after abort, so unabortable decode work cannot outlive cleanup.
      const buffer = await options.loadBuffer(
        clip.source,
        context,
        preparation.signal,
      );
      preparation.signal.throwIfAborted();
      const bytes = buffer.length * buffer.numberOfChannels * 4;
      if (
        buffer.sampleRate !== normalized.sampleRate ||
        ![1, 2].includes(buffer.numberOfChannels) ||
        !Number.isSafeInteger(buffer.length) ||
        buffer.length < 0 ||
        !Number.isSafeInteger(bytes)
      )
        throw new Error(
          "preview.audio_format: expected mono/stereo PCM at the plan sample rate",
        );
      decodedBytes += bytes;
      if (decodedBytes > maxBytes)
        throw new Error(
          "preview.audio_limit: decoded sources exceed retained-buffer limit",
        );
      buffers.set(clip.source, buffer);
    }
    preparation.signal.throwIfAborted();
    return makeClock(normalized, context, buffers);
  } catch (error) {
    buffers.clear();
    try {
      await context.close();
    } catch {
      /* Preserve the preparation failure. */
    }
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}

function makeClock(
  plan: AudioPlan,
  context: AudioContext,
  buffers: Map<string, AudioBuffer>,
): AudioPlanClock {
  let position = 0;
  let originTime = 0;
  let playing = false;
  let revision = 0;
  let disposed = false;
  let closing: Promise<void> | undefined;
  const active = new Map<AudioBufferSourceNode, GainNode>();
  const assertOpen = () => {
    if (disposed)
      throw new Error("preview.audio_closed: audio clock has been disposed");
  };
  const validatePosition = (sample: number) => {
    if (
      !Number.isSafeInteger(sample) ||
      sample < 0 ||
      sample > plan.durationSamples
    )
      throw new RangeError(
        "preview.audio_position: sample must be inside the closed playback boundary",
      );
  };
  const disconnect = (source: AudioBufferSourceNode, gain: GainNode) => {
    source.onended = null;
    source.disconnect();
    gain.disconnect();
    active.delete(source);
  };
  const stopSources = () => {
    for (const [source, gain] of active) {
      try {
        source.stop();
      } catch {
        /* Already-ended source nodes may reject stop(). */
      }
      disconnect(source, gain);
    }
  };
  const currentSample = () => {
    assertOpen();
    if (!playing) return position;
    return Math.min(
      plan.durationSamples,
      position +
        secondsToSamples(
          Math.max(0, context.currentTime - originTime),
          plan.sampleRate,
          "floor",
        ),
    );
  };
  const pause = () => {
    assertOpen();
    position = currentSample();
    playing = false;
    ++revision;
    stopSources();
  };
  const schedule = () => {
    originTime = context.currentTime;
    if (position === plan.durationSamples) return;
    try {
      for (const clip of plan.clips) {
        const start = Math.max(position, clip.startSample);
        const duration = clip.startSample + clip.durationSamples - start;
        if (duration <= 0) continue;
        const offset = clip.sourceStartSample + start - clip.startSample;
        const buffer = buffers.get(clip.source)!;
        const available = Math.min(duration, buffer.length - offset);
        if (available <= 0) continue; // A missing source tail is silence, not stretched audio.
        const source = context.createBufferSource();
        const gain = context.createGain();
        active.set(source, gain);
        source.buffer = buffer;
        source.playbackRate.value = 1;
        gain.gain.value = clip.gain;
        if (clip.volumeEnvelope) {
          const when =
            originTime + samplesToSeconds(start - position, plan.sampleRate);
          const points = sliceAudioEnvelope(
            clip.volumeEnvelope,
            start - clip.startSample,
            start - clip.startSample + available,
          );
          gain.gain.setValueAtTime(clip.gain * points[0]!.gain, when);
          for (const point of points.slice(1))
            gain.gain.linearRampToValueAtTime(
              clip.gain * point.gain,
              when + samplesToSeconds(point.sample, plan.sampleRate),
            );
        }
        source.connect(gain);
        gain.connect(context.destination);
        source.onended = () => disconnect(source, gain);
        source.start(
          originTime + samplesToSeconds(start - position, plan.sampleRate),
          samplesToSeconds(offset, plan.sampleRate),
          samplesToSeconds(available, plan.sampleRate),
        );
      }
      playing = true;
    } catch (error) {
      stopSources();
      playing = false;
      throw error;
    }
  };
  const seek = (sample: number) => {
    assertOpen();
    validatePosition(sample);
    const wasPlaying = playing;
    pause();
    position = sample;
    if (wasPlaying) schedule();
  };
  return {
    sampleRate: plan.sampleRate,
    durationSamples: plan.durationSamples,
    currentSample,
    pause,
    seek,
    async play(sample) {
      assertOpen();
      if (sample !== undefined) seek(sample);
      if (playing || position === plan.durationSamples) return;
      const request = ++revision;
      await context.resume();
      assertOpen();
      if (request !== revision) throw cancelled();
      if (context.state !== "running")
        throw new Error(
          "preview.audio_suspended: resume audio from a user playback gesture",
        );
      schedule();
    },
    dispose() {
      if (closing) return closing;
      pause();
      disposed = true;
      buffers.clear();
      closing = context.close();
      return closing;
    },
  };
}

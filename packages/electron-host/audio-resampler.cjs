"use strict";

/** Streaming windowed-sinc resampling for interleaved mono/stereo PCM.
 * Bounded lookahead preserves source sample timing without an output delay.
 * Input timestamps are rebased to sourceOrigin. The fixed ring retains only a
 * filter window and an input block; onData receives borrowed output blocks.
 * No output normalization, clipping, or implicit channel attenuation is applied.
 */
class StreamingAudioResampler {
  constructor({
    sourceRate,
    targetRate,
    sourceChannels,
    targetChannels,
    totalFrames,
    sourceOrigin = 0,
    onData,
  }) {
    if (
      ![sourceRate, targetRate].every(
        (rate) => Number.isSafeInteger(rate) && rate >= 4000 && rate <= 384000,
      ) ||
      ![1, 2].includes(sourceChannels) ||
      ![1, 2].includes(targetChannels) ||
      !Number.isSafeInteger(totalFrames) ||
      totalFrames < 0 ||
      !Number.isFinite(sourceOrigin) ||
      typeof onData !== "function"
    )
      throw new Error("media.invalid_resampler_format");
    this.sourceRate = sourceRate;
    this.targetRate = targetRate;
    this.sourceChannels = sourceChannels;
    this.targetChannels = targetChannels;
    this.totalFrames = totalFrames;
    this.sourceOrigin = sourceOrigin;
    this.onData = onData;
    this.radius =
      sourceRate === targetRate
        ? 0
        : Math.ceil(32 / Math.min(1, targetRate / sourceRate));
    this.cutoff = 0.94 * Math.min(1, targetRate / sourceRate);
    this.capacity = 2 * this.radius + 4098;
    this.ring = new Float32Array(this.capacity * sourceChannels);
    this.output = new Float32Array(4096 * targetChannels);
    this.inputFrames = 0;
    this.outputFrames = 0;
    this.pendingFrames = 0;
    this.first = new Float32Array(sourceChannels);
    this.last = new Float32Array(sourceChannels);
    this.phases = new Map();
    this.finished = false;
    this.lastPacketStart = -Infinity;
  }
  get lookaheadSeconds() {
    return this.radius / this.sourceRate;
  }
  get done() {
    return this.outputFrames >= this.totalFrames;
  }
  get stats() {
    return {
      capacityFrames: this.capacity,
      filterRadius: this.radius,
      phaseCacheEntries: this.phases.size,
      outputFrames: this.outputFrames,
    };
  }
  weights(remainder) {
    let weights = this.phases.get(remainder);
    if (weights) {
      this.phases.delete(remainder);
      this.phases.set(remainder, weights);
      return weights;
    }
    weights = new Float64Array(2 * this.radius + 1);
    const fraction = remainder / this.targetRate;
    let sum = 0;
    for (let offset = -this.radius; offset <= this.radius; offset++) {
      const distance = offset - fraction;
      if (Math.abs(distance) >= this.radius) continue;
      const phase = (Math.PI * distance) / this.radius;
      const window = 0.42 + 0.5 * Math.cos(phase) + 0.08 * Math.cos(2 * phase);
      const x = Math.PI * this.cutoff * distance;
      const weight =
        this.cutoff * (Math.abs(x) < 1e-12 ? 1 : Math.sin(x) / x) * window;
      weights[offset + this.radius] = weight;
      sum += weight;
    }
    for (let i = 0; i < weights.length; i++) weights[i] /= sum;
    this.phases.set(remainder, weights);
    if (this.phases.size > 512)
      this.phases.delete(this.phases.keys().next().value);
    return weights;
  }
  value(frame, channel) {
    if (frame < 0) return this.first[channel];
    if (frame >= this.inputFrames) return this.last[channel];
    if (frame < this.inputFrames - this.capacity)
      throw new Error("media.resampler_history_lost");
    return this.ring[(frame % this.capacity) * this.sourceChannels + channel];
  }
  flush() {
    if (!this.pendingFrames) return;
    this.onData(
      this.outputFrames - this.pendingFrames,
      this.output.subarray(0, this.pendingFrames * this.targetChannels),
    );
    this.pendingFrames = 0;
  }
  drain(final = false) {
    while (!this.done) {
      const position = this.outputFrames * this.sourceRate;
      if (!Number.isSafeInteger(position))
        throw new Error("media.resampler_timestamp_limit");
      const center = Math.floor(position / this.targetRate),
        remainder = position % this.targetRate;
      if (!final && center + this.radius >= this.inputFrames) break;
      const weights = this.radius ? this.weights(remainder) : null;
      let left = 0,
        right = 0;
      if (final && center >= this.inputFrames) {
        left = 0;
        right = 0;
      } else if (!weights) {
        left = this.value(center, 0);
        right = this.sourceChannels === 2 ? this.value(center, 1) : left;
      } else {
        for (let index = 0; index < weights.length; index++) {
          const frame = center + index - this.radius,
            weight = weights[index];
          left += this.value(frame, 0) * weight;
          if (this.sourceChannels === 2) right += this.value(frame, 1) * weight;
        }
        if (this.sourceChannels === 1) right = left;
      }
      const outputIndex = this.pendingFrames * this.targetChannels;
      this.output[outputIndex] =
        this.targetChannels === 1 && this.sourceChannels === 2
          ? (left + right) * 0.5
          : left;
      if (this.targetChannels === 2) this.output[outputIndex + 1] = right;
      if (
        !Number.isFinite(this.output[outputIndex]) ||
        (this.targetChannels === 2 &&
          !Number.isFinite(this.output[outputIndex + 1]))
      )
        throw new Error("media.nonfinite_audio");
      this.outputFrames++;
      this.pendingFrames++;
      if (this.pendingFrames === 4096) this.flush();
    }
  }
  append(data, offset, frames) {
    for (let frame = 0; frame < frames; frame++) {
      const slot = (this.inputFrames % this.capacity) * this.sourceChannels;
      for (let channel = 0; channel < this.sourceChannels; channel++) {
        const value = data
          ? data[(offset + frame) * this.sourceChannels + channel]
          : 0;
        if (!Number.isFinite(value)) throw new Error("media.nonfinite_audio");
        this.ring[slot + channel] = value;
        this.last[channel] = value;
        if (this.inputFrames === 0) this.first[channel] = value;
      }
      this.inputFrames++;
      if (frame % 4096 === 4095) this.drain();
    }
    this.drain();
  }
  push({ data, frames, rate, timestamp }) {
    if (this.finished) throw new Error("media.resampler_closed");
    if (rate !== this.sourceRate)
      throw new Error("media.audio_sample_rate_changed");
    if (
      !(data instanceof Float32Array) ||
      !Number.isSafeInteger(frames) ||
      frames < 0 ||
      data.length !== frames * this.sourceChannels ||
      !Number.isFinite(timestamp)
    )
      throw new Error("media.invalid_audio_sample");
    const start = Math.round((timestamp - this.sourceOrigin) * this.sourceRate);
    if (!Number.isSafeInteger(start) || start < this.lastPacketStart)
      throw new Error("media.audio_pts_out_of_order");
    this.lastPacketStart = start;
    if (this.done) return;
    if (start > this.inputFrames)
      this.append(null, 0, start - this.inputFrames);
    const skip = Math.max(0, this.inputFrames - start);
    if (skip < frames) this.append(data, skip, frames - skip);
  }
  finish() {
    if (this.finished) return;
    this.drain(true);
    this.flush();
    this.finished = true;
  }
}
module.exports = { StreamingAudioResampler };

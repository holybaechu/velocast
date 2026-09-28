"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { StreamingAudioResampler } = require("../audio-resampler.cjs");
function resample(
  input,
  sourceRate,
  targetRate,
  sourceChannels = 1,
  targetChannels = sourceChannels,
  chunkFrames = 997,
) {
  const totalFrames = Math.round(
      ((input.length / sourceChannels) * targetRate) / sourceRate,
    ),
    result = new Float32Array(totalFrames * targetChannels);
  const resampler = new StreamingAudioResampler({
    sourceRate,
    targetRate,
    sourceChannels,
    targetChannels,
    totalFrames,
    onData(start, data) {
      assert.ok(data.length <= 4096 * targetChannels);
      result.set(data, start * targetChannels);
    },
  });
  for (
    let offset = 0;
    offset < input.length / sourceChannels;
    offset += chunkFrames
  ) {
    const frames = Math.min(
      chunkFrames,
      input.length / sourceChannels - offset,
    );
    resampler.push({
      data: input.subarray(
        offset * sourceChannels,
        (offset + frames) * sourceChannels,
      ),
      rate: sourceRate,
      timestamp: offset / sourceRate,
      frames,
    });
  }
  resampler.finish();
  return { result, resampler };
}
function rms(data, start = 256, end = data.length - 256) {
  let energy = 0;
  for (let i = start; i < end; i++) energy += data[i] ** 2;
  return Math.sqrt(energy / (end - start));
}
test("96 kHz to 48 kHz rejects 30 kHz aliases while preserving passband amplitude", () => {
  const high = Float32Array.from({ length: 96000 }, (_, i) =>
    Math.sin((2 * Math.PI * 30000 * i) / 96000),
  );
  const naive = Float32Array.from({ length: 48000 }, (_, i) => high[i * 2]);
  assert.ok(
    rms(naive) > 0.7,
    "linear integer downsampling aliases 30 kHz to 18 kHz at full amplitude",
  );
  const filtered = resample(high, 96000, 48000).result;
  assert.ok(rms(filtered) < 0.0001, `aliased RMS ${rms(filtered)}`);
  const low = Float32Array.from({ length: 96000 }, (_, i) =>
    Math.sin((2 * Math.PI * 1000 * i) / 96000),
  );
  assert.ok(
    Math.abs(rms(resample(low, 96000, 48000).result) - Math.SQRT1_2) < 0.001,
  );
});
test("44100 to48000 preserves exact duration, impulse timing and independent stereo channels", () => {
  const input = new Float32Array(44100 * 2);
  input[22050 * 2] = 1;
  input[11025 * 2 + 1] = 0.5;
  const { result, resampler } = resample(input, 44100, 48000, 2);
  assert.equal(result.length, 48000 * 2);
  let left = 0,
    right = 0;
  for (let frame = 0; frame < 48000; frame++) {
    if (result[frame * 2] > result[left * 2]) left = frame;
    if (result[frame * 2 + 1] > result[right * 2 + 1]) right = frame;
  }
  assert.equal(left, 24000);
  assert.equal(right, 12000);
  assert.ok(Math.abs(result[12000 * 2]) < 1e-10);
  assert.ok(Math.abs(result[24000 * 2 + 1]) < 1e-10);
  assert.ok(resampler.stats.capacityFrames < 4300);
  assert.ok(resampler.stats.phaseCacheEntries <= 512);
});
test("packet partitioning does not alter output or reset filter history", () => {
  const input = Float32Array.from(
    { length: 12000 },
    (_, i) => Math.sin(i * 0.719) * 0.7 + Math.cos(i * 0.03) * 0.1,
  );
  const whole = resample(input, 44100, 48000, 1, 1, 12000).result;
  for (const block of [1, 17, 997, 4096])
    assert.deepEqual(resample(input, 44100, 48000, 1, 1, block).result, whole);
});
test("equal-rate conversion is bit exact, duplicates mono at unity, and preserves timeline gaps", () => {
  const mono = new Float32Array([0.25, -0.5, 1.25, 0]);
  const { result } = resample(mono, 48000, 48000, 1, 2, 2);
  assert.deepEqual([...result], [0.25, 0.25, -0.5, -0.5, 1.25, 1.25, 0, 0]);
  const output = new Float32Array(6);
  const stream = new StreamingAudioResampler({
    sourceRate: 48000,
    targetRate: 48000,
    sourceChannels: 2,
    targetChannels: 1,
    totalFrames: 6,
    onData(start, data) {
      output.set(data, start);
    },
  });
  stream.push({
    data: new Float32Array([0.5, 0.25, 1, 0]),
    frames: 2,
    rate: 48000,
    timestamp: 0,
  });
  stream.push({
    data: new Float32Array([1, -1]),
    frames: 1,
    rate: 48000,
    timestamp: 5 / 48000,
  });
  stream.finish();
  assert.deepEqual([...output], [0.375, 0.5, 0, 0, 0, 0]);
});
test("finishing does not extend the last sample across an unfilled timeline tail", () => {
  const output = new Float32Array(6);
  const stream = new StreamingAudioResampler({
    sourceRate: 48000,
    targetRate: 48000,
    sourceChannels: 1,
    targetChannels: 1,
    totalFrames: 6,
    onData(start, data) {
      output.set(data, start);
    },
  });
  stream.push({
    data: new Float32Array([0.5]),
    frames: 1,
    rate: 48000,
    timestamp: 0,
  });
  stream.finish();
  assert.deepEqual([...output], [0.5, 0, 0, 0, 0, 0]);
});

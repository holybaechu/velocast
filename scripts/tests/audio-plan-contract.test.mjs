import assert from "node:assert/strict";
import { test } from "node:test";
import {
  framesToSamples,
  sliceAudioPlan,
  sliceAudioPlanByFrames,
} from "../../packages/core/dist/index.js";

test("preroll advances source trim and partial slices retain source positions", () => {
  const plan = {
    sampleRate: 48000,
    durationSamples: 10,
    clips: [
      {
        source: "song.wav",
        startSample: -2,
        sourceStartSample: 4,
        durationSamples: 10,
        gain: 0.5,
      },
    ],
  };
  assert.deepEqual(sliceAudioPlan(plan, 0, 10), {
    sampleRate: 48000,
    durationSamples: 10,
    clips: [
      {
        source: "song.wav",
        startSample: 0,
        sourceStartSample: 6,
        durationSamples: 8,
        gain: 0.5,
      },
    ],
  });
  assert.deepEqual(sliceAudioPlan(plan, 3, 9), {
    sampleRate: 48000,
    durationSamples: 6,
    clips: [
      {
        source: "song.wav",
        startSample: 0,
        sourceStartSample: 9,
        durationSamples: 5,
        gain: 0.5,
      },
    ],
  });
  assert.deepEqual(sliceAudioPlan(plan, 5, 5), {
    sampleRate: 48000,
    durationSamples: 0,
    clips: [],
  });
});

test("44.1 kHz frame boundaries round independently with positive ties", () => {
  const plan = {
    sampleRate: 44100,
    durationSamples: 44100,
    clips: [
      {
        source: "song.wav",
        startSample: 0,
        sourceStartSample: 0,
        durationSamples: 44100,
        gain: 1,
      },
    ],
  };
  assert.deepEqual(
    [1, 2].map((frame) => framesToSamples(frame, 24, 44100, "round")),
    [1838, 3675],
  );
  assert.deepEqual(sliceAudioPlanByFrames(plan, 1, 2, 24, "round"), {
    sampleRate: 44100,
    durationSamples: 1837,
    clips: [
      {
        source: "song.wav",
        startSample: 0,
        sourceStartSample: 1838,
        durationSamples: 1837,
        gain: 1,
      },
    ],
  });
});

test("exclusive boundaries drop muted and outside clips", () => {
  const plan = {
    sampleRate: 48000,
    durationSamples: 10,
    clips: [
      {
        source: "one.wav",
        startSample: 0,
        sourceStartSample: 0,
        durationSamples: 10,
        gain: 0,
      },
      {
        source: "two.wav",
        startSample: 7,
        sourceStartSample: 0,
        durationSamples: 3,
        gain: 1,
      },
      {
        source: "three.wav",
        startSample: 2,
        sourceStartSample: 30,
        durationSamples: 20,
        gain: 2,
      },
    ],
  };
  assert.deepEqual(sliceAudioPlan(plan, 3, 7), {
    sampleRate: 48000,
    durationSamples: 4,
    clips: [
      {
        source: "three.wav",
        startSample: 0,
        sourceStartSample: 31,
        durationSamples: 4,
        gain: 2,
      },
    ],
  });
});

test("preroll fade and ducking interpolate slice boundary gains", () => {
  const plan = {
    sampleRate: 48000,
    durationSamples: 200,
    clips: [
      {
        source: "voice.wav",
        startSample: -10,
        sourceStartSample: 4,
        durationSamples: 160,
        gain: 0.5,
        volumeEnvelope: [
          { sample: 0, gain: 0 },
          { sample: 40, gain: 1 },
          { sample: 80, gain: 0.25 },
          { sample: 120, gain: 1 },
          { sample: 160, gain: 0 },
        ],
      },
    ],
  };
  assert.deepEqual(sliceAudioPlan(plan, 10, 90), {
    sampleRate: 48000,
    durationSamples: 80,
    clips: [
      {
        source: "voice.wav",
        startSample: 0,
        sourceStartSample: 24,
        durationSamples: 80,
        gain: 0.5,
        volumeEnvelope: [
          { sample: 0, gain: 0.5 },
          { sample: 20, gain: 1 },
          { sample: 60, gain: 0.25 },
          { sample: 80, gain: 0.625 },
        ],
      },
    ],
  });
});

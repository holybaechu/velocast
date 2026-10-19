import { expect, it } from "vitest";
import {
  evaluateAudioEnvelope,
  fadeAudioEnvelope,
  normalizeAudioPlan,
  sliceAudioEnvelope,
  sliceAudioPlan,
  validateAudioPlan,
} from "./audio-plan.js";

it("fades and ducks continuously through preroll and independently rounded slices", () => {
  const points = [
    { sample: 0, gain: 0 },
    { sample: 17, gain: 1 },
    { sample: 31, gain: 0.2 },
    { sample: 39, gain: 1 },
    { sample: 70, gain: 0 },
  ];
  const plan = {
    sampleRate: 48000,
    durationSamples: 100,
    clips: [
      {
        source: "a",
        startSample: -4,
        sourceStartSample: 9,
        durationSamples: 70,
        gain: 0.7,
        volumeEnvelope: points,
      },
    ],
  };
  const sliced = sliceAudioPlan(plan, 13, 51).clips[0]!;
  expect(sliced.sourceStartSample).toBe(26);
  for (let sample = 0; sample < sliced.durationSamples; sample++)
    expect(evaluateAudioEnvelope(sliced.volumeEnvelope, sample)).toBeCloseTo(
      evaluateAudioEnvelope(points, sample + 17),
      14,
    );
  expect(fadeAudioEnvelope(100, 20, 30)).toEqual([
    { sample: 0, gain: 0 },
    { sample: 20, gain: 1 },
    { sample: 70, gain: 1 },
    { sample: 100, gain: 0 },
  ]);
  expect(() => fadeAudioEnvelope(10, 8, 8)).toThrow(/fit/);
  for (const volumeEnvelope of [
    [],
    [
      { sample: 1, gain: 1 },
      { sample: 1, gain: 0 },
    ],
    [{ sample: 71, gain: 1 }],
    [{ sample: 0, gain: NaN }],
  ])
    expect(() =>
      validateAudioPlan({
        ...plan,
        clips: [{ ...plan.clips[0]!, volumeEnvelope }],
      }),
    ).toThrow(/envelope|volumeEnvelope/);
});

it("normalizes a maximum-size envelope without adding extrapolation endpoints", () => {
  const points = Array.from({ length: 10000 }, (_, index) => ({
    sample: index * 2 + 2,
    gain: index % 2,
  }));
  const plan = validateAudioPlan({
    sampleRate: 48000,
    durationSamples: 20002,
    clips: [
      {
        source: "voice.wav",
        startSample: 0,
        sourceStartSample: 0,
        durationSamples: 20002,
        gain: 1,
        volumeEnvelope: points,
      },
    ],
  });
  const normalized = normalizeAudioPlan(plan);
  expect(normalized).toEqual(plan);
  expect(normalizeAudioPlan(normalized)).toEqual(normalized);
  const sliced = sliceAudioPlan(plan, 3, 19999).clips[0]!;
  expect(sliced.volumeEnvelope!.length).toBeLessThanOrEqual(10000);
  for (const sample of [0, 1, 9997, sliced.durationSamples - 1])
    expect(evaluateAudioEnvelope(sliced.volumeEnvelope, sample)).toBe(
      evaluateAudioEnvelope(points, sample + 3),
    );
});

it("clips crossing ramps while preserving constant prefixes, tails and windows", () => {
  const points = [
    { sample: 2, gain: 0.25 },
    { sample: 5, gain: 1 },
    { sample: 8, gain: 1 },
    { sample: 10, gain: 0 },
  ];
  expect(sliceAudioEnvelope(points, 0, 12)).toEqual(points);
  expect(sliceAudioEnvelope(points, 6, 7)).toEqual([{ sample: 0, gain: 1 }]);
  expect(sliceAudioEnvelope(points, 11, 12)).toEqual([{ sample: 0, gain: 0 }]);
  for (const [start, end] of [
    [0, 4],
    [3, 9],
    [6, 7],
    [9, 12],
    [4, 4],
  ] as const) {
    const sliced = sliceAudioEnvelope(points, start, end);
    for (let sample = 0; sample <= end - start; sample++)
      expect(evaluateAudioEnvelope(sliced, sample)).toBeCloseTo(
        evaluateAudioEnvelope(points, sample + start),
        14,
      );
  }
});

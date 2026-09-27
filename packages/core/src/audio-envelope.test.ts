import { expect, it } from "vitest";
import {
  evaluateAudioEnvelope,
  fadeAudioEnvelope,
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

import { describe, expect, it } from "vitest";
import { sliceAudioPlan } from "@velocast/core";
import { mixAudioPlanPcm } from "./audio-pcm-reference.js";

describe("PCM audio-plan reference", () => {
  it("preserves impulses, trims, offsets and exact silence padding across slicing", () => {
    const samples = new Float32Array([1, 2, 3, 4, 5]);
    const sources = new Map([
      ["tone.wav", { sampleRate: 48000, channels: [samples] }],
    ]);
    const plan = {
      sampleRate: 48000,
      durationSamples: 8,
      clips: [
        {
          source: "tone.wav",
          startSample: 2,
          sourceStartSample: 1,
          durationSamples: 5,
          gain: 0.5,
        },
      ],
    };
    const full = mixAudioPlanPcm(plan, sources, 1);
    expect([...full.channels[0]!]).toEqual([0, 0, 1, 1.5, 2, 2.5, 0, 0]);
    const sliced = mixAudioPlanPcm(sliceAudioPlan(plan, 3, 7), sources, 1);
    expect([...sliced.channels[0]!]).toEqual([
      ...full.channels[0]!.slice(3, 7),
    ]);
    expect([...samples]).toEqual([1, 2, 3, 4, 5]);
  });

  it("sums gains without normalization/clipping and preserves independent stereo channels", () => {
    const source = {
      sampleRate: 48000,
      channels: [new Float32Array([1, -1]), new Float32Array([-0.5, 0.5])],
    };
    const clip = {
      source: "tone",
      startSample: 0,
      sourceStartSample: 0,
      durationSamples: 2,
      gain: 1,
    };
    const result = mixAudioPlanPcm(
      {
        sampleRate: 48000,
        durationSamples: 3,
        clips: [clip, { ...clip, gain: 2 }],
      },
      new Map([["tone", source]]),
      2,
    );
    expect([...result.channels[0]!]).toEqual([3, -3, 0]);
    expect([...result.channels[1]!]).toEqual([-1.5, 1.5, 0]);
  });

  it("matches full-vs-sliced preroll and synthesizes only requested silence for missing tails", () => {
    const sources = new Map([
      ["tone", { sampleRate: 48000, channels: [new Float32Array([1, 2, 3])] }],
    ]);
    const plan = {
      sampleRate: 48000,
      durationSamples: 6,
      clips: [
        {
          source: "tone",
          startSample: -1,
          sourceStartSample: 0,
          durationSamples: 6,
          gain: 1,
        },
      ],
    };
    const full = mixAudioPlanPcm(plan, sources, 1);
    expect([...full.channels[0]!]).toEqual([2, 3, 0, 0, 0, 0]);
    expect([
      ...mixAudioPlanPcm(sliceAudioPlan(plan, 1, 5), sources, 1).channels[0]!,
    ]).toEqual([3, 0, 0, 0]);
    expect([
      ...mixAudioPlanPcm(
        { ...plan, clips: [{ ...plan.clips[0]!, sourceStartSample: 100 }] },
        sources,
        1,
      ).channels[0]!,
    ]).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("rejects invalid decoded source data, Float32 overflow and unbounded allocations", () => {
    const plan = {
      sampleRate: 48000,
      durationSamples: 4,
      clips: [
        {
          source: "tone",
          startSample: 0,
          sourceStartSample: 0,
          durationSamples: 4,
          gain: 1,
        },
      ],
    };
    expect(() => mixAudioPlanPcm(plan, new Map(), 1)).toThrow(/Missing/);
    expect(() =>
      mixAudioPlanPcm(
        plan,
        new Map([
          ["tone", { sampleRate: 44100, channels: [new Float32Array(4)] }],
        ]),
        1,
      ),
    ).toThrow(/resampled/);
    expect(() =>
      mixAudioPlanPcm(
        plan,
        new Map([
          ["tone", { sampleRate: 48000, channels: [new Float32Array([NaN])] }],
        ]),
        1,
      ),
    ).toThrow(/finite/);
    expect(() =>
      mixAudioPlanPcm(
        plan,
        new Map([
          [
            "tone",
            { sampleRate: 48000, channels: [new Float32Array([Infinity])] },
          ],
        ]),
        1,
      ),
    ).toThrow(/finite/);
    expect(() =>
      mixAudioPlanPcm(
        plan,
        new Map([
          [
            "tone",
            {
              sampleRate: 48000,
              channels: [new Float32Array(4), new Float32Array(3)],
            },
          ],
        ]),
        2,
      ),
    ).toThrow(/equal-length/);
    expect(() =>
      mixAudioPlanPcm(plan, new Map(), 1, { maxOutputSamples: 3 }),
    ).toThrow(/budget/);
    expect(() =>
      mixAudioPlanPcm(
        { ...plan, clips: [{ ...plan.clips[0]!, gain: Number.MAX_VALUE }] },
        new Map([
          ["tone", { sampleRate: 48000, channels: [new Float32Array([1])] }],
        ]),
        1,
      ),
    ).toThrow(/Float32/);
  });
});

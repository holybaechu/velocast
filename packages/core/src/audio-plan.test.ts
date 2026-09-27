import { describe, expect, it } from "vitest";
import {
  normalizeAudioPlan,
  sliceAudioPlan,
  sliceAudioPlanByFrames,
  validateAudioPlan,
} from "./index.js";

describe("sample-based audio plans", () => {
  it("clips preroll and rebases a half-open slice without changing source alignment", () => {
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
    expect(normalizeAudioPlan(plan)).toEqual({
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
    expect(sliceAudioPlan(plan, 3, 9)).toEqual({
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
    expect(validateAudioPlan(plan)).toEqual(plan);
    expect(plan.clips[0]!.startSample).toBe(-2);
  });

  it("snapshots caller data, normalizes idempotently and permits explicit empty/silent plans", () => {
    const plan = {
      sampleRate: 48000,
      durationSamples: 10,
      clips: [
        {
          source: "song.wav",
          startSample: 2,
          sourceStartSample: 0,
          durationSamples: 20,
          gain: 1,
        },
      ],
    };
    const snapshot = validateAudioPlan(plan);
    plan.clips[0]!.gain = 2;
    expect(snapshot.clips[0]!.gain).toBe(1);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.clips[0])).toBe(true);
    const normalized = normalizeAudioPlan(snapshot);
    expect(normalized.clips[0]!.durationSamples).toBe(8);
    expect(normalizeAudioPlan(normalized)).toEqual(normalized);
    expect(sliceAudioPlan(snapshot, 4, 4)).toEqual({
      sampleRate: 48000,
      durationSamples: 0,
      clips: [],
    });
    expect(
      normalizeAudioPlan({ sampleRate: 48000, durationSamples: 10, clips: [] })
        .clips,
    ).toEqual([]);
  });

  it("drops muted/outside clips and advances source trim exactly for nested slices", () => {
    const clip = {
      source: "song.wav",
      startSample: -2,
      sourceStartSample: 0,
      durationSamples: 20,
      gain: 1,
    };
    const plan = {
      sampleRate: 48000,
      durationSamples: 20,
      clips: [clip, { ...clip, gain: 0 }, { ...clip, startSample: 20 }],
    };
    expect(normalizeAudioPlan(plan).clips).toHaveLength(1);
    expect(sliceAudioPlan(sliceAudioPlan(plan, 3, 15), 2, 9)).toEqual(
      sliceAudioPlan(plan, 5, 12),
    );
    const sliced = sliceAudioPlan(plan, 5, 12);
    expect(sliced.clips[0]).toEqual({
      ...clip,
      startSample: 0,
      sourceStartSample: 7,
      durationSamples: 7,
    });
  });

  it("uses independently rounded frame boundaries for 44.1kHz/24fps slices", () => {
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
    const sliced = sliceAudioPlanByFrames(plan, 1, 2, 24, "round");
    expect(sliced.durationSamples).toBe(1837);
    expect(sliced.clips[0]!.sourceStartSample).toBe(1838);
  });

  it.each([NaN, Infinity, -Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects unsafe sample/rate fields: %s",
    (value) => {
      const clip = {
        source: "song.wav",
        startSample: 0,
        sourceStartSample: 0,
        durationSamples: 10,
        gain: 1,
      };
      const plan = { sampleRate: 48000, durationSamples: 10, clips: [clip] };
      expect(() => validateAudioPlan({ ...plan, sampleRate: value })).toThrow();
      expect(() =>
        validateAudioPlan({ ...plan, durationSamples: value }),
      ).toThrow();
      for (const field of [
        "startSample",
        "sourceStartSample",
        "durationSamples",
      ] as const) {
        expect(() =>
          validateAudioPlan({ ...plan, clips: [{ ...clip, [field]: value }] }),
        ).toThrow();
      }
    },
  );

  it("rejects invalid gains, negative source positions, paths, ranges and endpoint overflow", () => {
    const clip = {
      source: "song.wav",
      startSample: 0,
      sourceStartSample: 0,
      durationSamples: 10,
      gain: 1,
    };
    const plan = { sampleRate: 48000, durationSamples: 10, clips: [clip] };
    for (const gain of [NaN, Infinity, -1])
      expect(() =>
        validateAudioPlan({ ...plan, clips: [{ ...clip, gain }] }),
      ).toThrow(/gain/);
    for (const source of ["", " ", "a\0b", "a\nb"])
      expect(() =>
        validateAudioPlan({ ...plan, clips: [{ ...clip, source }] }),
      ).toThrow(/source/);
    expect(() => validateAudioPlan({ ...plan, sampleRate: 0 })).toThrow();
    expect(() =>
      validateAudioPlan({
        ...plan,
        clips: [{ ...clip, sourceStartSample: -1 }],
      }),
    ).toThrow();
    expect(() =>
      validateAudioPlan({
        ...plan,
        clips: [{ ...clip, sourceStartSample: Number.MAX_SAFE_INTEGER }],
      }),
    ).toThrow(/end/);
    expect(() =>
      validateAudioPlan({
        ...plan,
        clips: [{ ...clip, startSample: Number.MAX_SAFE_INTEGER }],
      }),
    ).toThrow(/end/);
    expect(() => sliceAudioPlan(plan, -1, 5)).toThrow();
    expect(() => sliceAudioPlan(plan, 0, 11)).toThrow();
    expect(() => sliceAudioPlan(plan, 5, 4)).toThrow();
    expect(() => normalizeAudioPlan(null as unknown as typeof plan)).toThrow(
      /plan/,
    );
  });
});

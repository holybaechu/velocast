import { expect, it } from "vitest";
import { remotionAudioPlan, type RemotionMediaAsset } from "./audio-plan.js";
const asset: RemotionMediaAsset = {
  type: "audio",
  id: "clip",
  src: "song.wav",
  frame: 0,
  mediaFrame: 3,
  volume: 0.25,
  playbackRate: 1,
  toneFrequency: null,
};
it("maps fractional fps boundaries, sequence trims, looping offsets and frame gains without gaps", async () => {
  const result = await remotionAudioPlan(
    [
      [asset],
      [{ ...asset, mediaFrame: 4, volume: 0.5 }],
      [{ ...asset, mediaFrame: 0 }],
    ],
    29.97,
    48000,
    async (source) => `/tmp/${source}`,
  );
  expect(result.durationSamples).toBe(Math.round((3 * 48000) / 29.97));
  expect(
    result.clips[0]!.durationSamples +
      result.clips[1]!.durationSamples +
      result.clips[2]!.durationSamples,
  ).toBe(result.durationSamples);
  expect(result.clips.map((clip) => clip.sourceStartSample)).toEqual([
    Math.round((3 * 48000) / 29.97),
    Math.round((4 * 48000) / 29.97),
    0,
  ]);
  expect(result.clips.map((clip) => clip.gain)).toEqual([0.25, 0.5, 0.25]);
});
it.each([{ playbackRate: 2 }, { toneFrequency: 1.2 }])(
  "diagnoses unsupported pitch/tempo instead of changing it silently",
  async (change) => {
    await expect(
      remotionAudioPlan(
        [[{ ...asset, ...change }]],
        30,
        48000,
        async (source) => source,
      ),
    ).rejects.toThrow("remotion.audio_transform_unsupported");
  },
);
it("coalesces continuous fixed-gain clips without changing source samples", async () => {
  const frames = Array.from({ length: 100 }, (_, frame) => [
    { ...asset, frame, mediaFrame: frame },
  ]);
  const result = await remotionAudioPlan(
    frames,
    30,
    48000,
    async (source) => source,
  );
  expect(result.clips).toHaveLength(1);
  expect(result.clips[0]).toMatchObject({
    sourceStartSample: 0,
    startSample: 0,
    durationSamples: 160000,
    gain: 0.25,
  });
});
it("omits video tracks without audio even when their visual playbackRate changes", async () => {
  expect(
    (
      await remotionAudioPlan(
        [[{ ...asset, type: "video", playbackRate: 2 }]],
        30,
        48000,
        async () => null,
      )
    ).clips,
  ).toEqual([]);
});

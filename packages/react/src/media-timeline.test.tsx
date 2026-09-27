import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { clearFrameAdaptersForTest } from "@velocast/core/testing";
import {
  createMediaTimeline,
  registerReactComposition,
  Sequence,
} from "./index.js";
const config = { width: 16, height: 16, fps: 24, durationFrames: 40 };
const expectedError = (event: ErrorEvent) => {
  if (String(event.error).includes("VELOCAST_MEDIA_")) event.preventDefault();
};
beforeEach(() => {
  window.addEventListener("error", expectedError);
  clearFrameAdaptersForTest();
  window.__velocast = undefined;
  document.body.innerHTML = "";
});

it("rejects a changed composition clock instead of silently shifting sound against picture", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const sourceConfig = { ...config };
  const timeline = createMediaTimeline(sourceConfig, []);
  sourceConfig.fps = 30;
  const protocol = registerReactComposition("scene", {
    ...sourceConfig,
    audio: timeline.audio,
    component: timeline.Timeline,
  });
  await expect(protocol.seekFrame("scene", 0)).rejects.toThrow(
    "VELOCAST_MEDIA_CONFIG",
  );
});

it("rejects nesting a composition-wide timeline in a locally shifted sequence", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const timeline = createMediaTimeline(config, []);
  const protocol = registerReactComposition("scene", {
    ...config,
    audio: timeline.audio,
    component: () => (
      <Sequence from={3} durationFrames={10}>
        <timeline.Timeline />
      </Sequence>
    ),
  });
  await expect(protocol.seekFrame("scene", 3)).rejects.toThrow(
    "VELOCAST_MEDIA_SCOPE",
  );
});
afterEach(async () => {
  window.removeEventListener("error", expectedError);
  await window.__velocast?.destroy();
  vi.restoreAllMocks();
});
it("one media descriptor supplies matching trimmed sound and deterministic video at reordered frames", async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    clearRect() {},
    createImageData: () => ({ data: new Uint8ClampedArray(4) }),
    putImageData() {},
  } as unknown as CanvasRenderingContext2D);
  const timeline = createMediaTimeline(
    config,
    [
      {
        id: "speech",
        kind: "video",
        src: "/speech.mp4",
        from: 3,
        durationFrames: 12,
        trimBeforeFrames: 7,
        fadeInFrames: 2,
        fadeOutFrames: 3,
      },
    ],
    44100,
  );
  const getFrame = vi.fn(async (_src: string, seconds: number) => ({
    width: 1,
    height: 1,
    rgba: new Uint8Array(4),
    pts: Math.round(seconds * 24000),
    timeBase: { numerator: 1, denominator: 24000 },
  }));
  const protocol = registerReactComposition("scene", {
    ...config,
    audio: timeline.audio,
    component: () => <timeline.Timeline getFrame={getFrame} />,
  });
  const audio = await protocol.getAudioPlan!("scene");
  expect(audio!.clips[0]).toMatchObject({
    source: "/speech.mp4",
    startSample: 5513,
    sourceStartSample: 12863,
    durationSamples: 22050,
  });
  for (const frame of [3, 14, 7, 3]) {
    await protocol.seekFrame("scene", frame);
    expect(getFrame).toHaveBeenLastCalledWith(
      "/speech.mp4",
      (frame - 3 + 7) / 24,
      expect.any(AbortSignal),
    );
  }
  const calls = getFrame.mock.calls.length;
  await protocol.seekFrame("scene", 15);
  expect(getFrame).toHaveBeenCalledTimes(calls);
});

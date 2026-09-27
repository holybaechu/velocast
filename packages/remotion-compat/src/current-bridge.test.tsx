import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type * as current from "remotion-current";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
const require = createRequire(import.meta.url);
const currentRuntime = JSON.parse(
  execFileSync(
    process.execPath,
    [
      "-e",
      `const r=require(${JSON.stringify(require.resolve("remotion-current"))});process.stdout.write(JSON.stringify({version:r.VERSION,values:[5,20,8,5].map(frame=>r.spring({fps:60,frame}))}));`,
    ],
    { encoding: "utf8" },
  ),
);
import { clearFrameAdaptersForTest } from "@velocast/core/testing";
import { registerRemotionComposition } from "./index.js";
import { spring, Video } from "./remotion.js";
import {
  Html5Audio,
  Html5Video,
  OffthreadVideo,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

const currentVolume = (frame: number) => Math.min(1, frame / 10);
function CurrentStyle() {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  return (
    <>
      <span>
        {frame}:{durationInFrames}:{spring({ fps, frame })}
      </span>
      <Sequence from={5} durationInFrames={20} layout="none">
        <Html5Video
          src="/clip.mp4"
          trimBefore={3}
          trimAfter={23}
          volume={currentVolume}
        />
        <OffthreadVideo src="/silent.mp4" trimBefore={2} muted />
        <Html5Audio
          src="/music.wav"
          trimBefore={4}
          trimAfter={24}
          volume={currentVolume}
        />
      </Sequence>
    </>
  );
}
const modernProps: ComponentProps<typeof current.Html5Video> = {
  src: "/clip.mp4",
  trimBefore: 3,
  trimAfter: 23,
  volume: currentVolume,
};
const config = { width: 16, height: 16, fps: 60, durationInFrames: 40 };
beforeEach(() => {
  clearFrameAdaptersForTest();
  window.__velocast = undefined;
  document.body.innerHTML = "";
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    clearRect() {},
  } as unknown as CanvasRenderingContext2D);
});
afterEach(async () => {
  await window.__velocast?.destroy();
  vi.restoreAllMocks();
});
it("runs the 4.0.526 media API with trim aliases, spring and volume preparation", async () => {
  expect(currentRuntime.version).toBe("4.0.526");
  expect(modernProps.trimBefore).toBe(3);
  const put = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    clearRect() {},
    createImageData: () => ({ data: new Uint8ClampedArray(4) }),
    putImageData: put,
  } as unknown as CanvasRenderingContext2D);
  const getVideoFrame = vi.fn(async (_src: string, time: number) => ({
    width: 1,
    height: 1,
    rgba: new Uint8Array(4),
    pts: Math.round(time * 6000),
    timeBase: { numerator: 1, denominator: 6000 },
  }));
  const protocol = registerRemotionComposition("modern", {
    ...config,
    component: CurrentStyle,
    getVideoFrame,
    audio: {
      sampleRate: 48000,
      tracks: [
        {
          src: "/clip.mp4",
          from: 5,
          durationInFrames: 20,
          trimBefore: 3,
          trimAfter: 23,
          volume: currentVolume,
        },
        {
          src: "/music.wav",
          from: 5,
          durationInFrames: 20,
          trimBefore: 4,
          trimAfter: 24,
          volume: currentVolume,
        },
      ],
    },
  });
  const plan = await protocol.getAudioPlan!("modern");
  expect(
    plan!.clips[0]!.volumeEnvelope!.find((point) => point.sample === 8000),
  ).toEqual({
    sample: 8000,
    gain: 1,
  });
  for (const frame of [5, 20, 8, 5]) {
    await protocol.seekFrame("modern", frame);
    expect(document.body.textContent).toContain(`${frame}:40:`);
    expect(getVideoFrame).toHaveBeenCalledWith(
      "/clip.mp4",
      (frame - 5 + 3) / 60,
      expect.any(AbortSignal),
    );
    expect(spring({ fps: 60, frame })).toBe(
      currentRuntime.values[[5, 20, 8, 5].indexOf(frame)],
    );
  }
  expect(put).toHaveBeenCalledTimes(8);
  await protocol.seekFrame("modern", 25);
  expect(put).toHaveBeenCalledTimes(8);
});
it("frame readiness waits for Video pixels and decoder errors propagate", async () => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => (release = resolve));
  let entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const protocol = registerRemotionComposition("pending", {
    ...config,
    component: () => <Video src="/clip.mp4" muted />,
    getVideoFrame: async () => {
      entered();
      await ready;
      throw new Error("actual decoder failure");
    },
  });
  let complete = false;
  const pending = protocol
    .seekFrame("pending", 0)
    .finally(() => (complete = true));
  const rejected = expect(pending).rejects.toThrow("actual decoder failure");
  await started;
  expect(complete).toBe(false);
  release();
  await rejected;
});
it("provides an exact bundler alias and reports unsupported media instead of silently dropping options", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const protocol = registerRemotionComposition("invalid", {
    ...config,
    component: () => (
      <Video {...{ src: "/clip.mp4", muted: true, playbackRate: 2 }} />
    ),
  });
  await expect(protocol.seekFrame("invalid", 0)).rejects.toThrow(
    /Video.playbackRate/,
  );
});

it("prepares a three-minute 60fps fade and duck callback into a bounded exact curve", async () => {
  const { resolveAudioDeclaration } = await import("./audio.js");
  const volume = (frame: number) =>
    frame < 60
      ? frame / 60
      : frame < 600
        ? 1
        : frame < 660
          ? 1 - (frame - 600) / 80
          : frame < 6000
            ? 0.25
            : frame < 6060
              ? 0.25 + (frame - 6000) / 80
              : frame < 10740
                ? 1
                : (10800 - frame) / 60;
  const declaration = resolveAudioDeclaration(
    {
      sampleRate: 48000,
      tracks: [{ src: "/long.wav", durationInFrames: 10800, volume }],
    },
    { width: 1920, height: 1080, fps: 60, durationFrames: 10800 },
  );
  const points = declaration.plan!.clips[0]!.volumeEnvelope!;
  expect(points.length).toBeLessThan(300);
  const { evaluateAudioEnvelope } = await import("@velocast/core");
  for (let frame = 0; frame <= 10800; frame++)
    expect(evaluateAudioEnvelope(points, frame * 800)).toBeCloseTo(
      volume(frame),
      14,
    );
});

it("accepts host-owned sample automation for preroll with a numeric JSX base gain", async () => {
  const { Audio, Sequence } = await import("./remotion.js");
  const protocol = registerRemotionComposition("preroll-envelope", {
    ...config,
    audio: {
      sampleRate: 48000,
      durationSamples: 32000,
      clips: [
        {
          source: "/song.wav",
          startSample: 0,
          sourceStartSample: 1600,
          durationSamples: 14400,
          gain: 0.5,
          volumeEnvelope: [
            { sample: 0, gain: 0.2 },
            { sample: 14400, gain: 1 },
          ],
        },
      ],
    },
    component: () => (
      <Sequence from={-2} durationInFrames={20} layout="none">
        <Audio src="/song.wav" volume={0.5} />
      </Sequence>
    ),
  });
  await protocol.seekFrame("preroll-envelope", 3);
});

import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { clearFrameAdaptersForTest } from "@velocast/core/testing";
import { registerRemotionComposition } from "./index.js";
import { Audio, Loop, Sequence, Series, useCurrentFrame } from "./remotion.js";
const config = { width: 160, height: 96, fps: 30, durationInFrames: 16 };
beforeEach(() => {
  clearFrameAdaptersForTest();
  window.__velocast = undefined;
  document.body.innerHTML = "";
});
afterEach(async () => {
  await window.__velocast?.destroy();
  vi.restoreAllMocks();
});
function Local({ label }: { label: string }) {
  const frame = useCurrentFrame();
  const loop = Loop.useLoop();
  return (
    <span>
      {label}:{frame}:{loop?.iteration ?? "none"};
    </span>
  );
}
it("Series maps fragments, overlaps, gaps and final Infinity deterministically inside a parent Sequence", async () => {
  const protocol = registerRemotionComposition("series", {
    ...config,
    component: () => (
      <Sequence from={2} durationInFrames={12} layout="none">
        <Series>
          <Series.Sequence durationInFrames={4} layout="none">
            <Local label="a" />
          </Series.Sequence>
          <>
            <Series.Sequence durationInFrames={3} offset={-1} layout="none">
              <Local label="b" />
            </Series.Sequence>
          </>
          <Series.Sequence durationInFrames={Infinity} offset={2} layout="none">
            <Local label="c" />
          </Series.Sequence>
        </Series>
      </Sequence>
    ),
  });
  for (const [frame, text] of [
    [5, "a:3:none;b:0:none;"],
    [8, ""],
    [10, "c:0:none;"],
    [5, "a:3:none;b:0:none;"],
    [14, ""],
  ] as const) {
    await protocol.seekFrame("series", frame);
    expect(document.body.textContent).toBe(text);
  }
});
it("Loop only mounts the selected finite iteration and resets local audio callback timing", async () => {
  const volume = (frame: number) => frame / 4;
  const protocol = registerRemotionComposition("loop", {
    ...config,
    audio: {
      sampleRate: 48000,
      tracks: [0, 4, 8].map((from) => ({
        src: "/tone.wav",
        from,
        durationInFrames: 4,
        volume,
      })),
    },
    component: () => (
      <Loop durationInFrames={4} times={3} layout="none">
        <Local label="loop" />
        <Audio src="/tone.wav" volume={volume} />
      </Loop>
    ),
  });
  for (const [frame, text] of [
    [9, "loop:1:2;"],
    [3, "loop:3:0;"],
    [4, "loop:0:1;"],
    [9, "loop:1:2;"],
    [12, ""],
  ] as const) {
    await protocol.seekFrame("loop", frame);
    expect(document.body.textContent).toBe(text);
  }
  const plan = await protocol.getAudioPlan!("loop");
  expect(plan!.clips.map((clip) => clip.startSample)).toEqual([0, 6400, 12800]);
});
it("default Loop is composition-bounded and exposes the nearest nested iteration", async () => {
  const protocol = registerRemotionComposition("nested", {
    ...config,
    component: () => (
      <Loop durationInFrames={5} layout="none">
        <Local label="outer" />
        <Loop durationInFrames={2} layout="none">
          <Local label="inner" />
        </Loop>
      </Loop>
    ),
  });
  await protocol.seekFrame("nested", 13);
  expect(document.body.textContent).toBe("outer:3:2;inner:1:1;");
});
it("rejects fractional timings and malformed Series children with useful diagnostics", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const protocol = registerRemotionComposition("bad", {
    ...config,
    component: () => (
      <Loop durationInFrames={2.5}>
        <span />
      </Loop>
    ),
  });
  await expect(protocol.seekFrame("bad", 0)).rejects.toThrow(
    /Loop.durationInFrames/,
  );
  await protocol.destroy();
  clearFrameAdaptersForTest();
  const bad = registerRemotionComposition("bad-child", {
    ...config,
    component: () => (
      <Series>
        <div />
      </Series>
    ),
  });
  await expect(bad.seekFrame("bad-child", 0)).rejects.toThrow(/SERIES_CHILD/);
});

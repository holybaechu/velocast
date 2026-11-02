import { afterEach, beforeEach, expect, it } from "vitest";
import { clearFrameAdaptersForTest } from "@velocast/core/testing";
import { registerReactComposition } from "./index.js";
import {
  Sequence,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  Easing,
} from "./index.js";

function Emphasis() {
  const frame = useCurrentFrame();
  const width = interpolate(frame, [0, 11], [0, 240], {
    easing: Easing.inOut(Easing.linear),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return <div data-emphasis-frame={frame} style={{ width }} />;
}

function Line({ name, text }: { name: string; text: string }) {
  const frame = useCurrentFrame();
  return (
    <section data-text-line={name} data-line-frame={frame}>
      <h1>{text}</h1>
      <Sequence from={8} durationFrames={12}>
        <Emphasis />
      </Sequence>
    </section>
  );
}

function TextTransition({
  firstLine,
  secondLine,
}: {
  firstLine: string;
  secondLine: string;
}) {
  const { durationFrames } = useVideoConfig();
  return (
    <main data-text-scene data-composition-duration={durationFrames}>
      <Sequence from={10} durationFrames={40}>
        <Line name="first" text={firstLine} />
      </Sequence>
      <Sequence from={50} durationFrames={40}>
        <Line name="second" text={secondLine} />
      </Sequence>
    </main>
  );
}

beforeEach(() => {
  clearFrameAdaptersForTest();
  window.__velocast = undefined;
  document.body.innerHTML = "";
});
afterEach(async () => {
  await window.__velocast?.destroy();
  clearFrameAdaptersForTest();
  document.body.innerHTML = "";
});

it("commits text-line and nested emphasis boundaries using the React helper", async () => {
  const protocol = registerReactComposition("text", {
    component: TextTransition,
    width: 640,
    height: 360,
    fps: 60,
    durationFrames: 120,
    defaultProps: { firstLine: "첫 줄", secondLine: "다음 줄" },
  });
  for (const [frame, line, local, emphasis] of [
    [9, null, null, null],
    [10, "first", 0, null],
    [17, "first", 7, null],
    [18, "first", 8, 0],
    [29, "first", 19, 11],
    [30, "first", 20, null],
    [49, "first", 39, null],
    [50, "second", 0, null],
    [58, "second", 8, 0],
    [89, "second", 39, null],
    [90, null, null, null],
  ] as const) {
    await protocol.seekFrame("text", frame);
    const element = document.querySelector<HTMLElement>("[data-text-line]");
    expect(element?.dataset.textLine ?? null).toBe(line);
    expect(element ? Number(element.dataset.lineFrame) : null).toBe(local);
    const highlight = document.querySelector<HTMLElement>(
      "[data-emphasis-frame]",
    );
    expect(highlight ? Number(highlight.dataset.emphasisFrame) : null).toBe(
      emphasis,
    );
    expect(
      document.querySelector<HTMLElement>("[data-text-scene]")!.dataset
        .compositionDuration,
    ).toBe("120");
  }
  await protocol.seekFrame("text", 29);
  expect(
    document.querySelector<HTMLElement>("[data-emphasis-frame]")!.style.width,
  ).toBe("240px");
  const reference = document.querySelector("main")!.outerHTML;
  await protocol.seekFrame("text", 60);
  await protocol.seekFrame("text", 10);
  await protocol.seekFrame("text", 29);
  expect(document.querySelector("main")!.outerHTML).toBe(reference);
  await protocol.destroy();
  await protocol.seekFrame("text", 29);
  expect(document.querySelector("main")!.outerHTML).toBe(reference);
});

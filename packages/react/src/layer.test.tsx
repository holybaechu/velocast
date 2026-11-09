import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearFrameAdaptersForTest } from "@velocast/core/testing";
import {
  Layer,
  Sequence,
  registerReactComposition,
  useCurrentFrame,
  type LayerProps,
} from "./index.js";

const video = { width: 320, height: 180, fps: 30, durationFrames: 120 };
beforeEach(() => {
  clearFrameAdaptersForTest();
  window.__velocast = undefined;
  document.body.innerHTML = "";
});
afterEach(async () => {
  await window.__velocast?.destroy();
  clearFrameAdaptersForTest();
  vi.restoreAllMocks();
});

function LocalFrame() {
  return <span>Frame {useCurrentFrame()}</span>;
}

it("seeks declarative keyframes on the layer's local clock in any frame order", async () => {
  const protocol = registerReactComposition("animated", {
    ...video,
    component: () => (
      <Layer
        id="animated-title"
        from={30}
        durationFrames={60}
        x={10}
        animation={{
          x: {
            keyframes: [
              { frame: 0, value: 10 },
              { frame: 20, value: 90 },
            ],
          },
          opacity: {
            keyframes: [
              { frame: 0, value: 0 },
              { frame: 10, value: 1 },
            ],
          },
        }}
      >
        <LocalFrame />
      </Layer>
    ),
  });
  for (const [frame, x, opacity] of [
    [50, 90, 1],
    [30, 10, 0],
    [40, 50, 1],
    [35, 30, 0.5],
    [50, 90, 1],
  ]) {
    await protocol.seekFrame("animated", frame!);
    const layer = document.querySelector<HTMLElement>(
      '[data-velocast-layer="animated-title"]',
    )!;
    expect(layer.style.left).toBe(`${x}px`);
    expect(Number(layer.style.opacity)).toBe(opacity);
    expect(layer.textContent).toBe(`Frame ${frame! - 30}`);
  }
});

it("keeps ordinary React children on a parent-relative clock with stable layer identity and layout", async () => {
  const protocol = registerReactComposition("scene", {
    ...video,
    component: () => (
      <Sequence from={30} durationFrames={20}>
        <Layer
          id="title"
          name="Heading"
          from={3}
          x={12}
          y={24}
          width={200}
          height={50}
          rotation={15}
          opacity={0.8}
          style={{ color: "red", left: 90 }}
        >
          <LocalFrame />
        </Layer>
      </Sequence>
    ),
  });
  await protocol.seekFrame("scene", 32);
  expect(document.querySelector('[data-velocast-layer="title"]')).toBeNull();
  await protocol.seekFrame("scene", 33);
  const layer = document.querySelector<HTMLElement>(
    '[data-velocast-layer="title"]',
  )!;
  expect(layer.textContent).toBe("Frame 0");
  expect(layer.style.position).toBe("absolute");
  expect(layer.style.left).toBe("90px");
  expect(layer.style.top).toBe("24px");
  expect(layer.style.width).toBe("200px");
  expect(layer.style.transform).toBe("rotate(15deg)");
  expect(layer.style.opacity).toBe("0.8");
  for (const frame of [49, 38, 33, 49]) {
    await protocol.seekFrame("scene", frame);
    expect(
      document.querySelector('[data-velocast-layer="title"]')!.textContent,
    ).toBe(frame === 49 ? "Frame 16" : frame === 38 ? "Frame 5" : "Frame 0");
  }
  await protocol.seekFrame("scene", 50);
  expect(document.querySelector('[data-velocast-layer="title"]')).toBeNull();
});

it("rejects invalid layer identity, geometry, and timing before publishing a frame", async () => {
  const report = (event: ErrorEvent) => event.preventDefault();
  window.addEventListener("error", report);
  vi.spyOn(console, "error").mockImplementation(() => {});
  const invalid: Array<[Partial<LayerProps>, string]> = [
    [{ id: " " }, "id"],
    [{ x: NaN }, "x"],
    [{ width: -1 }, "width"],
    [{ opacity: 1.1 }, "opacity"],
    [{ from: 0.5 }, "from"],
    [{ durationFrames: -1 }, "durationFrames"],
    [
      {
        animation: {
          opacity: {
            keyframes: [
              { frame: 0, value: 0 },
              { frame: 10, value: 2 },
            ],
          },
        },
      },
      "animation",
    ],
    [
      {
        animation: {
          x: {
            keyframes: [
              { frame: 10, value: 0 },
              { frame: 10, value: 20 },
            ],
          },
        },
      },
      "animation",
    ],
  ];
  try {
    for (const [props, field] of invalid) {
      const protocol = registerReactComposition(`invalid-${field}`, {
        ...video,
        component: () => (
          <Layer id="invalid" {...props}>
            Not ready
          </Layer>
        ),
      });
      await expect(protocol.seekFrame(`invalid-${field}`, 0)).rejects.toThrow(
        new RegExp(
          field === "animation"
            ? "VELOCAST_LAYER_ANIMATION"
            : `VELOCAST_LAYER_INVALID.*${field}`,
        ),
      );
      await protocol.destroy();
      clearFrameAdaptersForTest();
      window.__velocast = undefined;
    }
  } finally {
    window.removeEventListener("error", report);
  }
});

it("uses composition defaults and retains empty and negative-start Sequence semantics", async () => {
  const protocol = registerReactComposition("defaults", {
    ...video,
    component: () => (
      <>
        <Layer id="whole">
          <LocalFrame />
        </Layer>
        <Layer id="preroll" from={-2} durationFrames={5} width={0} height={0}>
          <LocalFrame />
        </Layer>
        <Layer id="empty" durationFrames={0}>
          Never shown
        </Layer>
      </>
    ),
  });
  await protocol.seekFrame("defaults", 0);
  const whole = document.querySelector<HTMLElement>(
    '[data-velocast-layer="whole"]',
  )!;
  expect([
    whole.style.left,
    whole.style.top,
    whole.style.opacity,
    whole.style.transform,
  ]).toEqual(["0px", "0px", "1", "rotate(0deg)"]);
  expect(
    document.querySelector('[data-velocast-layer="preroll"]')!.textContent,
  ).toBe("Frame 2");
  expect(document.querySelector('[data-velocast-layer="empty"]')).toBeNull();
  await protocol.seekFrame("defaults", 3);
  expect(document.querySelector('[data-velocast-layer="preroll"]')).toBeNull();
  await protocol.seekFrame("defaults", 119);
  expect(
    document.querySelector('[data-velocast-layer="whole"]')!.textContent,
  ).toBe("Frame 119");
});

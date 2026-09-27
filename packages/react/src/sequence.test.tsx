import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLayoutEffect } from "react";
import { clearFrameAdaptersForTest } from "@velocast/core/testing";
import {
  interpolate as coreInterpolate,
  Easing as coreEasing,
} from "@velocast/core";
import * as ReactHelpers from "./index.js";
import {
  registerReactComposition,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
  useInputProps,
  interpolate,
  Easing,
} from "./index.js";

const config = { width: 320, height: 180, fps: 30, durationFrames: 120 };
function ReadFrame({ name }: { name: string }) {
  return (
    <output data-name={name}>
      {useCurrentFrame()}:{useVideoConfig().durationFrames}
    </output>
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

describe("public React sequence boundary", () => {
  it("exports a declarative Sequence without requiring an adapter", () => {
    expect("Sequence" in ReactHelpers).toBe(true);
  });

  it("renders start/end boundaries as a half-open interval in committed DOM", async () => {
    function Scene() {
      return (
        <main>
          <Sequence from={10} durationFrames={5}>
            <ReadFrame name="line" />
          </Sequence>
        </main>
      );
    }
    const protocol = registerReactComposition("scene", {
      ...config,
      component: Scene,
    });
    await protocol.seekFrame("scene", 9);
    expect(document.querySelector("output")).toBeNull();
    await protocol.seekFrame("scene", 10);
    expect(document.querySelector("output")!.textContent).toBe("0:120");
    await protocol.seekFrame("scene", 14);
    expect(document.querySelector("output")!.textContent).toBe("4:120");
    await protocol.seekFrame("scene", 15);
    expect(document.querySelector("output")).toBeNull();
    expect(document.querySelector("main")!.children).toHaveLength(0);
  });

  it("accumulates nested offsets without changing global video configuration", async () => {
    function Scene() {
      return (
        <main>
          <ReadFrame name="global" />
          <Sequence from={5} durationFrames={10}>
            <ReadFrame name="parent" />
            <Sequence from={2} durationFrames={4}>
              <ReadFrame name="child" />
            </Sequence>
          </Sequence>
        </main>
      );
    }
    const protocol = registerReactComposition("scene", {
      ...config,
      component: Scene,
    });
    await protocol.seekFrame("scene", 6);
    expect(document.querySelector('[data-name="child"]')).toBeNull();
    await protocol.seekFrame("scene", 7);
    expect(
      [...document.querySelectorAll("output")].map((node) => node.textContent),
    ).toEqual(["7:120", "2:120", "0:120"]);
    await protocol.seekFrame("scene", 10);
    expect(document.querySelector('[data-name="child"]')!.textContent).toBe(
      "3:120",
    );
    await protocol.seekFrame("scene", 11);
    expect(document.querySelector('[data-name="child"]')).toBeNull();
    expect(document.querySelector('[data-name="parent"]')!.textContent).toBe(
      "6:120",
    );
  });

  it("clips children at every ancestor and unmounts their layout effects", async () => {
    const mounted = vi.fn();
    const cleaned = vi.fn();
    function Child() {
      useLayoutEffect(() => {
        mounted();
        return cleaned;
      }, []);
      return <ReadFrame name="child" />;
    }
    function Scene() {
      return (
        <Sequence from={5} durationFrames={10}>
          <Sequence from={8} durationFrames={10}>
            <Child />
          </Sequence>
        </Sequence>
      );
    }
    const protocol = registerReactComposition("scene", {
      ...config,
      component: Scene,
    });
    await protocol.seekFrame("scene", 14);
    expect(document.querySelector("output")!.textContent).toBe("1:120");
    expect(mounted).toHaveBeenCalledOnce();
    await protocol.seekFrame("scene", 15);
    expect(document.querySelector("output")).toBeNull();
    expect(cleaned).toHaveBeenCalledOnce();
    await protocol.seekFrame("scene", 14);
    expect(document.querySelector("output")!.textContent).toBe("1:120");
    expect(mounted).toHaveBeenCalledTimes(2);
  });

  it("supports empty intervals and negative starts while isolating sibling frame scopes", async () => {
    function Scene() {
      return (
        <main>
          <Sequence from={-2} durationFrames={5}>
            <ReadFrame name="pre-roll" />
          </Sequence>
          <Sequence durationFrames={0}>
            <b>never</b>
          </Sequence>
          <Sequence durationFrames={10}>
            <ReadFrame name="sibling" />
          </Sequence>
        </main>
      );
    }
    const protocol = registerReactComposition("scene", {
      ...config,
      component: Scene,
    });
    await protocol.seekFrame("scene", 0);
    expect(
      [...document.querySelectorAll("output")].map((node) => node.textContent),
    ).toEqual(["2:120", "0:120"]);
    expect(document.querySelector("b")).toBeNull();
    await protocol.seekFrame("scene", 3);
    expect(document.querySelector('[data-name="pre-roll"]')).toBeNull();
    expect(document.querySelector('[data-name="sibling"]')!.textContent).toBe(
      "3:120",
    );
  });

  it("recomputes sequence-local frame and props on a same-global-frame update", async () => {
    type Props = { start: number; title: string };
    function Child() {
      return (
        <output>
          {useInputProps<Props>().title}:{useCurrentFrame()}:
          {useVideoConfig().durationFrames}
        </output>
      );
    }
    function Scene({ start }: Props) {
      return (
        <Sequence from={start} durationFrames={10}>
          <Sequence from={2} durationFrames={4}>
            <Child />
          </Sequence>
        </Sequence>
      );
    }
    const protocol = registerReactComposition("scene", {
      ...config,
      component: Scene,
      defaultProps: { start: 5, title: "before" },
    });
    await protocol.seekFrame("scene", 8);
    expect(document.querySelector("output")!.textContent).toBe("before:1:120");
    await protocol.setInputProps({ start: 6, title: "after" });
    await protocol.seekFrame("scene", 8);
    expect(document.querySelector("output")!.textContent).toBe("after:0:120");
  });

  it("uses the same numerical motion functions as ordinary JS adapters", async () => {
    expect(interpolate).toBe(coreInterpolate);
    expect(Easing).toBe(coreEasing);
    function Line() {
      const frame = useCurrentFrame();
      const width = interpolate(frame, [0, 4], [0, 100], {
        easing: Easing.inOut(Easing.linear),
        extrapolateRight: "clamp",
      });
      return (
        <div
          data-motion
          style={{
            width,
            opacity: interpolate(frame, [0, 4], [0, 1], {
              extrapolateRight: "clamp",
            }),
          }}
        />
      );
    }
    function Scene() {
      return (
        <Sequence from={10} durationFrames={6}>
          <Line />
        </Sequence>
      );
    }
    const protocol = registerReactComposition("scene", {
      ...config,
      component: Scene,
    });
    for (const [frame, width, opacity] of [
      [10, "0px", "0"],
      [12, "50px", "0.5"],
      [14, "100px", "1"],
      [15, "100px", "1"],
    ] as const) {
      await protocol.seekFrame("scene", frame);
      const element = document.querySelector<HTMLElement>("[data-motion]")!;
      expect(element.style.width).toBe(width);
      expect(element.style.opacity).toBe(opacity);
    }
  });

  it("produces identical DOM for direct, sequential, reverse, repeated and fresh seeks", async () => {
    function Line() {
      return (
        <p
          style={{
            transform: `translateY(${interpolate(useCurrentFrame(), [0, 9], [18, 0])}px)`,
          }}
        >
          line {useCurrentFrame()}
        </p>
      );
    }
    function Scene() {
      return (
        <main>
          <Sequence from={5} durationFrames={10}>
            <Line />
          </Sequence>
        </main>
      );
    }
    const protocol = registerReactComposition("scene", {
      ...config,
      component: Scene,
    });
    const domAt = async (frame: number) => {
      await protocol.seekFrame("scene", frame);
      return document.querySelector("main")!.outerHTML;
    };
    const direct = await domAt(12);
    for (let frame = 0; frame <= 12; frame++) await domAt(frame);
    expect(await domAt(12)).toBe(direct);
    await domAt(14);
    await domAt(6);
    expect(await domAt(12)).toBe(direct);
    expect(await domAt(12)).toBe(direct);
    await protocol.destroy();
    expect(await domAt(12)).toBe(direct);
  });
});

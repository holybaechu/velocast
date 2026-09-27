import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { createRef, useEffect, useLayoutEffect, useState } from "react";
import { clearFrameAdaptersForTest } from "@velocast/core/testing";
import { startVelocast } from "@velocast/core";
import * as pinned from "remotion-pinned";
import {
  AbsoluteFill as AliasedAbsoluteFill,
  interpolate as aliasedInterpolate,
  Easing as AliasedEasing,
  useCurrentFrame as useAliasedFrame,
  useVideoConfig as useAliasedVideoConfig,
} from "remotion";
import {
  defineRemotionComposition,
  registerRemotionComposition,
} from "./index.js";
import {
  AbsoluteFill,
  Img,
  Easing,
  interpolate,
  staticFile,
  Audio,
  VERSION,
  Sequence,
  delayRender,
  continueRender,
  Composition,
  registerRoot,
} from "./remotion.js";
import { useCurrentFrame as useCompatFrame } from "./remotion.js";

function OriginalStyle({ label }: { label: string }) {
  const frame = useAliasedFrame();
  const config = useAliasedVideoConfig();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <AliasedAbsoluteFill
      data-mounted={mounted}
      style={{
        opacity: aliasedInterpolate(frame, [0, 60], [0, 1], {
          easing: AliasedEasing.out(AliasedEasing.cubic),
          extrapolateRight: "clamp",
        }),
      }}
    >
      {label}:{frame}:{config.width}x{config.height}@{config.fps}:
      {config.durationInFrames}:{config.id}
    </AliasedAbsoluteFill>
  );
}

const config = { width: 320, height: 180, fps: 60, durationInFrames: 120 };
const originalDecode = Object.getOwnPropertyDescriptor(
  HTMLImageElement.prototype,
  "decode",
);
beforeEach(() => {
  clearFrameAdaptersForTest();
  window.__velocast = undefined;
  document.body.innerHTML = "";
  Object.defineProperty(HTMLImageElement.prototype, "decode", {
    configurable: true,
    writable: true,
    value: () => Promise.resolve(),
  });
});

it("defines a Remotion composition without registering until project start", async () => {
  const definition = defineRemotionComposition({
    id: "defined",
    ...config,
    component: OriginalStyle,
    defaultProps: { label: "catalog" },
    parseProps: (props) => ({ label: String(props.label).toUpperCase() }),
  });
  expect(window.__velocast).toBeUndefined();
  const protocol = startVelocast([definition]);
  await protocol.seekFrame("defined", 12);
  expect(document.body.textContent).toContain(
    "CATALOG:12:320x180@60:120:defined",
  );
});
afterEach(async () => {
  await window.__velocast?.destroy();
  clearFrameAdaptersForTest();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  if (originalDecode)
    Object.defineProperty(HTMLImageElement.prototype, "decode", originalDecode);
  else Reflect.deleteProperty(HTMLImageElement.prototype, "decode");
});

it("keeps frame and props deterministic across direct, reverse, and repeated seeks", async () => {
  const protocol = registerRemotionComposition("original", {
    ...config,
    component: OriginalStyle,
    defaultProps: { label: "한글" },
  });
  const seen = new Map<number, string>();
  for (const frame of [0, 90, 12, 90]) {
    await protocol.seekFrame("original", frame);
    // This CPU mount test settles passive effects explicitly. Actual browser
    // readiness/capture parity is a separate native acceptance gate.
    await vi.waitFor(() =>
      expect(
        document.querySelector("[data-mounted]")?.getAttribute("data-mounted"),
      ).toBe("true"),
    );
    expect(document.body.textContent).toContain(
      `한글:${frame}:320x180@60:120:original`,
    );
    const html = document.body.firstElementChild!.innerHTML;
    if (seen.has(frame)) expect(html).toBe(seen.get(frame));
    seen.set(frame, html);
    expect(
      document.querySelector("[data-mounted]")?.getAttribute("data-mounted"),
    ).toBe("true");
  }
  await protocol.setInputProps({ label: "changed" });
  await protocol.seekFrame("original", 90);
  expect(document.body.textContent).toContain("changed:90");
  await protocol.destroy();
  expect(document.body.children).toHaveLength(0);
  clearFrameAdaptersForTest();
  const fresh = registerRemotionComposition("original", {
    ...config,
    component: OriginalStyle,
    defaultProps: { label: "한글" },
  });
  await fresh.seekFrame("original", 90);
  await vi.waitFor(() =>
    expect(
      document.querySelector("[data-mounted]")?.getAttribute("data-mounted"),
    ).toBe("true"),
  );
  expect(document.body.firstElementChild!.innerHTML).toBe(seen.get(90));
});

it("uses exact pinned utility objects and one React instance, rather than approximate math", () => {
  expect(VERSION).toBe("4.0.244");
  expect(interpolate).toBe(pinned.interpolate);
  expect(Easing).toBe(pinned.Easing);
  expect(AbsoluteFill).toBe(pinned.AbsoluteFill);
  expect(staticFile).toBe(pinned.staticFile);
  const require = createRequire(import.meta.url);
  const react = require("react");
  expect(react.version).toBe("18.3.1");
  for (const name of ["react-dom", "remotion-pinned"])
    expect(createRequire(require.resolve(name))("react")).toBe(react);
  for (const value of [0, 0.1, 12, 1069, 1070])
    expect(
      interpolate(value, [0, 1070], [2, 17], {
        easing: Easing.bezier(0.4, 0, 0.2, 1),
      }),
    ).toBe(
      pinned.interpolate(value, [0, 1070], [2, 17], {
        easing: pinned.Easing.bezier(0.4, 0, 0.2, 1),
      }),
    );
});

it("waits for the actual mounted image's decode before frame readiness and forwards its ref", async () => {
  let complete!: () => void;
  const decoded = new Promise<void>((done) => (complete = done));
  const decode = vi.fn(function (this: HTMLImageElement) {
    expect(this.alt).toBe("owned");
    return decoded;
  });
  vi.spyOn(HTMLImageElement.prototype, "decode").mockImplementation(decode);
  const ref = createRef<HTMLImageElement>();
  const protocol = registerRemotionComposition("image", {
    ...config,
    component: () => <Img ref={ref} src="image.png" alt="owned" />,
  });
  let ready = false;
  const pending = protocol.seekFrame("image", 0).then(() => {
    ready = true;
  });
  await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
  expect(ready).toBe(false);
  expect(ref.current).toBe(document.querySelector("img"));
  complete();
  await pending;
  expect(ready).toBe(true);
});

it("propagates decode errors and explicitly rejects unsupported image behavior", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(HTMLImageElement.prototype, "decode").mockRejectedValue(
    new Error("fixture.decode_failed"),
  );
  const protocol = registerRemotionComposition("image", {
    ...config,
    component: () => <Img src="broken.png" />,
  });
  await expect(protocol.seekFrame("image", 0)).rejects.toThrow(
    /fixture.decode_failed/,
  );
  await protocol.destroy();
  clearFrameAdaptersForTest();
  const unsupported = registerRemotionComposition("unsupported", {
    ...config,
    component: () => <Img src="x.png" maxRetries={4} />,
  });
  await expect(unsupported.seekFrame("unsupported", 0)).rejects.toThrow(
    /VELOCAST_REMOTION_UNSUPPORTED.*maxRetries/,
  );
});

it("resolves one static Audio declaration before JSX and returns the native plan", async () => {
  const declaration = vi.fn(() => ({
    sampleRate: 48_000,
    tracks: [
      {
        src: "/song.mp4",
        source: "D:/fixture/song.m4a",
        from: 12,
        durationInFrames: 30,
        startFrom: 6,
        volume: 0.5,
      },
    ],
  }));
  const protocol = registerRemotionComposition("audio", {
    ...config,
    defaultProps: { variant: "same" },
    audio: declaration,
    component: () => (
      <Sequence from={12} durationInFrames={30} layout="none">
        <Audio src="/song.mp4" startFrom={6} volume={0.5} />
      </Sequence>
    ),
  });
  await expect(protocol.getAudioPlan!("audio")).resolves.toEqual({
    sampleRate: 48_000,
    durationSamples: 96_000,
    clips: [
      {
        source: "D:/fixture/song.m4a",
        startSample: 9_600,
        sourceStartSample: 4_800,
        durationSamples: 24_000,
        gain: 0.5,
      },
    ],
  });
  expect(declaration).toHaveBeenCalledOnce();
  await protocol.seekFrame("audio", 0);
  await protocol.seekFrame("audio", 12);
  expect(declaration).toHaveBeenCalledOnce();
  expect(document.querySelector("audio")).toBeNull();
  await protocol.setInputProps({ variant: "changed" });
  await protocol.getAudioPlan!("audio");
  await protocol.seekFrame("audio", 12);
  expect(declaration).toHaveBeenCalledTimes(2);
});

it("rejects missing, unplanned, and undeclared dynamic Audio instead of discovering JSX", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const missing = registerRemotionComposition("missing-audio", {
    ...config,
    audio: { sampleRate: 48_000, tracks: [{ src: "/song.mp4" }] },
    component: () => null,
  });
  await expect(missing.seekFrame("missing-audio", 0)).rejects.toThrow(
    /VELOCAST_REMOTION_AUDIO_MISSING/,
  );
  await missing.destroy();
  clearFrameAdaptersForTest();
  const unplanned = registerRemotionComposition("unplanned-audio", {
    ...config,
    component: () => <Audio src="/song.mp4" />,
  });
  await expect(unplanned.seekFrame("unplanned-audio", 0)).rejects.toThrow(
    /VELOCAST_REMOTION_AUDIO_UNPLANNED/,
  );
  await unplanned.destroy();
  clearFrameAdaptersForTest();
  const dynamic = registerRemotionComposition("dynamic-audio", {
    ...config,
    audio: { sampleRate: 48_000, tracks: [{ src: "/song.mp4" }] },
    component: () => <Audio src="/song.mp4" volume={() => 1} />,
  });
  await expect(dynamic.seekFrame("dynamic-audio", 0)).rejects.toThrow(
    /VELOCAST_REMOTION_AUDIO_UNPLANNED/,
  );
});

it("counts only committed Audio instances across rerenders and layout unmounts", async () => {
  function RerenderedAudio() {
    const [ready, setReady] = useState(false);
    useEffect(() => setReady(true), []);
    return (
      <>
        <Audio src="/song.mp4" />
        <span data-ready={ready} />
      </>
    );
  }
  const stable = registerRemotionComposition("stable-audio", {
    ...config,
    audio: { sampleRate: 48_000, tracks: [{ src: "/song.mp4" }] },
    component: RerenderedAudio,
  });
  await stable.seekFrame("stable-audio", 0);
  await vi.waitFor(() =>
    expect(
      document.querySelector("[data-ready]")?.getAttribute("data-ready"),
    ).toBe("true"),
  );
  await stable.destroy();
  clearFrameAdaptersForTest();

  vi.spyOn(console, "error").mockImplementation(() => {});
  function RemovedBeforeBarrier() {
    const [visible, setVisible] = useState(true);
    useLayoutEffect(() => setVisible(false), []);
    return visible ? <Audio src="/song.mp4" /> : null;
  }
  const removed = registerRemotionComposition("removed-audio", {
    ...config,
    audio: { sampleRate: 48_000, tracks: [{ src: "/song.mp4" }] },
    component: RemovedBeforeBarrier,
  });
  await expect(removed.seekFrame("removed-audio", 0)).rejects.toThrow(
    /VELOCAST_REMOTION_AUDIO_MISSING/,
  );
});

it("maps bounded Sequence timing and layout to the common frame store", async () => {
  function Local() {
    return <span>{useCompatFrame()}</span>;
  }
  const protocol = registerRemotionComposition("sequence", {
    ...config,
    component: () => (
      <Sequence from={3} durationInFrames={2}>
        <Local />
      </Sequence>
    ),
  });
  await protocol.seekFrame("sequence", 2);
  expect(document.body.textContent).toBe("");
  await protocol.seekFrame("sequence", 3);
  expect(document.body.textContent).toBe("0");
  expect(document.querySelector("span")?.parentElement?.style.position).toBe(
    "absolute",
  );
  await protocol.seekFrame("sequence", 4);
  expect(document.body.textContent).toBe("1");
  await protocol.seekFrame("sequence", 5);
  expect(document.body.textContent).toBe("");
});

it("waits for captured delay handles before the first frame commit", async () => {
  const handle = delayRender("fixture font", { timeoutInMilliseconds: 5_000 });
  const mounted = vi.fn();
  const protocol = registerRemotionComposition("font", {
    ...config,
    component: () => {
      mounted();
      return <div>ready</div>;
    },
  });
  const pending = protocol.seekFrame("font", 0);
  await Promise.resolve();
  expect(mounted).not.toHaveBeenCalled();
  continueRender(handle);
  await pending;
  expect(mounted).toHaveBeenCalledOnce();
});

it("binds unchanged registerRoot identity to an explicit host manifest", async () => {
  const Root = () => null;
  registerRoot(Root);
  expect(() => Composition({})).toThrow(/VELOCAST_REMOTION_MANIFEST_REQUIRED/);
  const protocol = registerRemotionComposition("root-bound", {
    ...config,
    root: Root,
    component: () => <div>explicit</div>,
  });
  await protocol.seekFrame("root-bound", 0);
  expect(document.body.textContent).toBe("explicit");
  expect(() =>
    registerRemotionComposition("wrong-root", {
      ...config,
      root: () => null,
      component: () => null,
    }),
  ).toThrow(/VELOCAST_REMOTION_ROOT_MISMATCH/);
});

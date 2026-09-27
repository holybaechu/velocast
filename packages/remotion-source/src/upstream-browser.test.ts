import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createUpstreamRemotionBridgeScript } from "./upstream-browser.js";

type RemotionWindow = Window & {
  remotion_setBundleMode?: (mode: unknown) => void;
  remotion_setFrame?: (frame: number, id: string, attempt: number) => void;
  remotion_renderReady?: boolean;
  remotion_inputProps?: string;
  remotion_proxyPort?: number;
};

const options = {
  composition: {
    id: "hero",
    width: 64,
    height: 32,
    fps: 30,
    durationInFrames: 12,
    serializedResolvedPropsWithCustomSchema: '{"title":"resolved"}',
  },
  inputProps: { title: "input" },
  serializedInputPropsWithCustomSchema: '{"title":"input"}',
  mediaProxyPort: 44321,
  timeoutInMilliseconds: 500,
  protocolVersion: 4,
} as const;

const remotionWindow = () => window as RemotionWindow;
const install = () => {
  new Function(createUpstreamRemotionBridgeScript(options))();
  return window.__velocast!;
};

beforeEach(() => {
  window.__velocast = undefined;
  document.body.innerHTML = "";
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { ready: Promise.resolve(), status: "loaded" },
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 0),
  );
});

afterEach(() => {
  Reflect.deleteProperty(remotionWindow(), "remotion_setBundleMode");
  Reflect.deleteProperty(remotionWindow(), "remotion_setFrame");
  vi.unstubAllGlobals();
});

it("drives the original render-entry globals with fixed props and stable session", async () => {
  const modes: unknown[] = [];
  const frames: number[] = [];
  const upstream = remotionWindow();
  const protocol = install();
  expect(protocol.protocolVersion).toBe(4);
  expect(upstream.remotion_inputProps).toBe(
    options.serializedInputPropsWithCustomSchema,
  );
  expect(upstream.remotion_proxyPort).toBe(options.mediaProxyPort);
  upstream.remotion_setBundleMode = (mode) => {
    modes.push(mode);
    const canvas = document.createElement("div");
    canvas.id = "remotion-canvas";
    document.body.append(canvas);
    upstream.remotion_setFrame = (frame) => {
      frames.push(frame);
      upstream.remotion_renderReady = false;
      requestAnimationFrame(() => {
        upstream.remotion_renderReady = true;
      });
    };
    requestAnimationFrame(() => {
      upstream.remotion_renderReady = true;
    });
  };
  await protocol.beginSession({ sessionId: "stable", sourceVersion: "v1" });
  await expect(protocol.getCompositions()).resolves.toEqual([
    {
      id: "hero",
      width: 64,
      height: 32,
      fps: 30,
      durationFrames: 12,
      target: "#remotion-canvas",
    },
  ]);
  expect(modes).toEqual([
    {
      type: "composition",
      compositionName: "hero",
      serializedResolvedPropsWithSchema:
        options.composition.serializedResolvedPropsWithCustomSchema,
      compositionDurationInFrames: 12,
      compositionFps: 30,
      compositionHeight: 32,
      compositionWidth: 64,
      compositionDefaultCodec: null,
    },
  ]);
  await protocol.seekFrame("hero", 99, {
    compositionId: "hero",
    width: 64,
    height: 32,
    fps: 30,
    durationFrames: 12,
    inputProps: { title: "input" },
    renderSession: { sessionId: "stable", sourceVersion: "v1" },
  });
  await protocol.waitForReady?.();
  expect(frames).toEqual([11]);
  await expect(
    protocol.getAudioPlan?.("hero", {
      compositionId: "hero",
      width: 64,
      height: 32,
      fps: 30,
      durationFrames: 12,
      renderSession: { sessionId: "stable", sourceVersion: "v1" },
    }),
  ).resolves.toBeNull();
  await expect(protocol.seekFrame("hero", 1)).rejects.toThrow(
    "VELOCAST_SESSION_MISMATCH",
  );
  await expect(protocol.getAudioPlan?.("hero")).rejects.toThrow(
    "VELOCAST_SESSION_MISMATCH",
  );
  await expect(protocol.setInputProps({ title: "different" })).rejects.toThrow(
    "VELOCAST_INPUT_PROPS_MISMATCH",
  );
  await expect(
    protocol.beginSession({ sessionId: "different" }),
  ).rejects.toThrow("VELOCAST_SESSION_MISMATCH");
  expect(protocol.getSession()).toEqual({
    sessionId: "stable",
    sourceVersion: "v1",
  });
});

it("cancels an in-flight wait and allows a later operation to select", async () => {
  const protocol = install();
  const pending = protocol.getCompositions();
  protocol.cancelPending();
  await expect(pending).rejects.toThrow("VELOCAST_CANCELLED");
  const upstream = remotionWindow();
  upstream.remotion_setBundleMode = () => {
    const canvas = document.createElement("div");
    canvas.id = "remotion-canvas";
    document.body.append(canvas);
    upstream.remotion_setFrame = () => undefined;
    upstream.remotion_renderReady = true;
  };
  await expect(protocol.getDurationFrames("hero")).resolves.toBe(12);
  await expect(protocol.waitForReady?.()).rejects.toThrow("VELOCAST_CANCELLED");
  await protocol.seekFrame("hero", 3);
  await expect(protocol.waitForReady?.()).resolves.toBeUndefined();
});

it("escapes hostile props before embedding the script in HTML", () => {
  const script = createUpstreamRemotionBridgeScript({
    ...options,
    inputProps: { title: "</script><script>alert(1)</script>" },
  });
  expect(script).not.toContain("</script>");
  expect(script).toContain("\\u003c/script>");
});

it("passes the modern composition defaults through to the original runtime", async () => {
  new Function(
    createUpstreamRemotionBridgeScript({
      ...options,
      profile: "modern-4",
      composition: {
        ...options.composition,
        defaultSampleRate: 44_100,
        defaultOutName: "intro",
        defaultPixelFormat: "yuv420p",
      },
    }),
  )();
  let selectedMode: unknown;
  const upstream = remotionWindow();
  upstream.remotion_setBundleMode = (mode) => {
    selectedMode = mode;
    document.body.innerHTML = '<div id="remotion-canvas"></div>';
    upstream.remotion_setFrame = () => undefined;
    upstream.remotion_renderReady = true;
  };
  await window.__velocast!.getCompositions();
  expect(selectedMode).toMatchObject({
    compositionDefaultSampleRate: 44_100,
    compositionDefaultOutName: "intro",
    compositionDefaultPixelFormat: "yuv420p",
    compositionDefaultVideoImageFormat: null,
  });
  expect(
    (window as unknown as Record<string, unknown>).remotion_sampleRate,
  ).toBe(44_100);
  await window.__velocast!.destroy?.();
});

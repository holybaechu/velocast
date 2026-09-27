import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLayoutEffect, useRef, useState } from "react";
import { clearFrameAdaptersForTest } from "@velocast/core/testing";
import {
  defineReactComposition,
  startVelocast,
  registerReactComposition,
  useCurrentFrame,
  useVideoConfig,
  useInputProps,
  preloadImage,
} from "./index.js";

const config = { width: 320, height: 180, fps: 30, durationFrames: 120 };
const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  clearFrameAdaptersForTest();
  window.__velocast = undefined;
  document.body.innerHTML = "";
});
afterEach(async () => {
  await window.__velocast?.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
  else Reflect.deleteProperty(document, "fonts");
  clearFrameAdaptersForTest();
  document.body.innerHTML = "";
});

describe("official React composition commit boundary", () => {
  it("defines a React composition without mounting, then opens its owned root through one project runtime", async () => {
    const definition = defineReactComposition({
      id: "declarative",
      video: config,
      component: ({ title }: { title: string }) => (
        <span>
          {title}:{useCurrentFrame()}
        </span>
      ),
      defaultProps: { title: "default" },
    });
    expect(window.__velocast).toBeUndefined();
    expect(document.body.children).toHaveLength(0);
    const protocol = startVelocast([definition]);
    const [manifest] = await protocol.getCompositions();
    expect(manifest).toMatchObject({ id: "declarative", ...config });
    expect(document.body.children).toHaveLength(0);
    await protocol.seekFrame("declarative", 7);
    expect(document.body.textContent).toBe("default:7");
    expect(document.querySelector(manifest!.target!)).not.toBeNull();
    await protocol.setInputProps({ title: "supplied" });
    await protocol.seekFrame("declarative", 7);
    expect(document.body.textContent).toBe("supplied:7");
    await protocol.destroy();
    expect(document.body.children).toHaveLength(0);
  });

  it("parses required external props before a declarative React frame", async () => {
    const definition = defineReactComposition({
      id: "parsed",
      video: config,
      component: ({ title }: { title: string }) => <b>{title}</b>,
      parseProps: (inputProps) => {
        if (typeof inputProps.title !== "string")
          throw new Error("title is required");
        return { title: inputProps.title };
      },
    });
    const protocol = startVelocast([definition]);
    await expect(protocol.seekFrame("parsed", 0)).rejects.toThrow(
      /title is required/,
    );
    await protocol.setInputProps({ title: "ready" });
    await protocol.seekFrame("parsed", 0);
    expect(document.body.textContent).toBe("ready");
  });

  it("resolves a whole-composition audio plan after mount using the same default and supplied props as frames", async () => {
    const seen: unknown[] = [];
    const protocol = registerReactComposition("scene", {
      ...config,
      defaultProps: { source: "default.wav", gain: 0.25 },
      component: (props: { source: string; gain: number }) => (
        <span>
          {props.source}/{props.gain}
        </span>
      ),
      audio: ({ inputProps, signal, config: audioConfig }) => {
        expect(document.body.children).toHaveLength(1);
        expect(signal.aborted).toBe(false);
        expect(audioConfig).toEqual(config);
        seen.push(inputProps);
        return {
          sampleRate: 48000,
          durationSamples: 192000,
          clips: [
            {
              source: inputProps.source,
              gain: inputProps.gain,
              startSample: 1200,
              sourceStartSample: 2400,
              durationSamples: 96000,
            },
          ],
        };
      },
    });
    await protocol.setInputProps({ source: "first.wav" });
    const first = await protocol.getAudioPlan!("scene");
    expect(first!.clips[0]).toMatchObject({ source: "first.wav", gain: 0.25 });
    await protocol.seekFrame("scene", 12);
    expect(document.body.textContent).toBe("first.wav/0.25");
    await protocol.setInputProps({ source: "second.wav", gain: 0.5 });
    const second = await protocol.getAudioPlan!("scene");
    expect(second!.durationSamples).toBe(192000);
    expect(second!.clips[0]).toMatchObject({ source: "second.wav", gain: 0.5 });
    expect(seen).toHaveLength(2);
    expect(Object.isFrozen(seen[0])).toBe(true);
    await protocol.seekFrame("scene", 12);
    expect(document.body.textContent).toBe("second.wav/0.5");
    await protocol.destroy();
    expect(document.body.children).toHaveLength(0);
  });

  it("returns null for a silent composition and propagates static plan validation", async () => {
    const silent = registerReactComposition("silent", {
      ...config,
      component: () => null,
    });
    await expect(silent.getAudioPlan!("silent")).resolves.toBeNull();
    await silent.destroy();
    clearFrameAdaptersForTest();
    const invalid = registerReactComposition("bad", {
      ...config,
      component: () => null,
      audio: { sampleRate: 0, durationSamples: 0, clips: [] },
    });
    await expect(invalid.getAudioPlan!("bad")).rejects.toThrow(
      /VELOCAST_AUDIO_PLAN_FAILED.*sampleRate/,
    );
  });
  it("rejects a generated target collision rather than capturing somebody else's DOM", async () => {
    const protocol = registerReactComposition("scene", {
      ...config,
      component: () => <b>new frame</b>,
    });
    const [manifest] = await protocol.getCompositions();
    const node = document.createElement("div");
    node.id = manifest!.target!.slice(1);
    node.textContent = "original";
    document.body.appendChild(node);
    await expect(protocol.seekFrame("scene", 0)).rejects.toThrow(
      /capture root already exists/,
    );
    expect(document.body.textContent).toBe("original");
    expect(document.body.children).toHaveLength(1);
  });
  it("registers without exposing an adapter and resolves only after actual DOM commit", async () => {
    function Scene() {
      const frame = useCurrentFrame();
      const video = useVideoConfig();
      return (
        <div
          data-frame={frame}
        >{`${video.width}x${video.height}@${video.fps}/${video.durationFrames}`}</div>
      );
    }
    const protocol = registerReactComposition("scene", {
      ...config,
      component: Scene,
    });
    const [manifest] = await protocol.getCompositions();
    expect(manifest).toMatchObject({ id: "scene", ...config });
    expect(document.body.children).toHaveLength(0);
    await protocol.seekFrame("scene", 90);
    expect(document.querySelector('[data-frame="90"]')?.textContent).toBe(
      "320x180@30/120",
    );
    expect(
      document.querySelector<HTMLElement>(manifest!.target!)?.style.width,
    ).toBe("320px");
    await protocol.seekFrame("scene", 12);
    expect(document.querySelector('[data-frame="12"]')).not.toBeNull();
    await protocol.seekFrame("scene", 90);
    expect(document.querySelector('[data-frame="90"]')).not.toBeNull();
  });

  it("updates component props and hooks at the same frame with documented shallow defaults", async () => {
    type Props = {
      title?: string;
      shade?: string;
      nested?: { left?: number; right?: number };
    };
    function Scene(props: Props) {
      const hooked = useInputProps<Props>();
      return (
        <output>
          {JSON.stringify({ frame: useCurrentFrame(), props, hooked })}
        </output>
      );
    }
    const protocol = registerReactComposition("scene", {
      ...config,
      component: Scene,
      defaultProps: { title: "default", shade: "blue", nested: { left: 1 } },
    });
    await protocol.seekFrame("scene", 12);
    expect(
      JSON.parse(document.querySelector("output")!.textContent!).props,
    ).toEqual({ title: "default", shade: "blue", nested: { left: 1 } });
    await protocol.setInputProps({
      title: "new",
      shade: undefined,
      nested: { right: 2 },
    });
    await protocol.seekFrame("scene", 12);
    const state = JSON.parse(document.querySelector("output")!.textContent!);
    expect(state).toEqual({
      frame: 12,
      props: { title: "new", nested: { right: 2 } },
      hooked: { title: "new", nested: { right: 2 } },
    });
    await protocol.setInputProps({});
    await protocol.seekFrame("scene", 12);
    expect(
      JSON.parse(document.querySelector("output")!.textContent!).props.title,
    ).toBe("default");
  });

  it("loads owned fonts before any layout effect and includes layout-effect state in the committed DOM", async () => {
    const loading = deferred<void>();
    const faces = new Set<unknown>();
    const started = vi.fn();
    class FakeFontFace {
      status = "unloaded";
      load() {
        started();
        this.status = "loading";
        return loading.promise.then(() => {
          this.status = "loaded";
          return this;
        });
      }
    }
    vi.stubGlobal("FontFace", FakeFontFace);
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: {
        add: (face: unknown) => faces.add(face),
        delete: (face: unknown) => faces.delete(face),
      },
    });
    const layouts: number[] = [];
    // jsdom does not lay out text; control the browser measurement seam while
    // still checking that the real React layout effect runs after font load.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      height: 42,
    } as DOMRect);
    function Scene() {
      const label = useRef<HTMLDivElement>(null);
      const [height, setHeight] = useState(0);
      useLayoutEffect(() => {
        layouts.push(faces.size);
        setHeight(label.current!.getBoundingClientRect().height);
      }, []);
      return (
        <div ref={label} data-measured-height={height}>
          한글
        </div>
      );
    }
    const protocol = registerReactComposition("scene", {
      ...config,
      component: Scene,
      fonts: [{ family: "Korean", source: 'url("korean.woff2")' }],
    });
    const seek = protocol.seekFrame("scene", 90);
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    expect(document.querySelector("[data-measured-height]")).toBeNull();
    expect(layouts).toEqual([]);
    loading.resolve();
    await seek;
    expect(layouts).toEqual([1]);
    expect(
      document.querySelector('[data-measured-height="42"]'),
    ).not.toBeNull();
    await protocol.destroy();
    expect(faces.size).toBe(0);
  });

  it("runs props-aware preload before commit, including same-frame prop changes", async () => {
    const gate = deferred<void>();
    let wait = true;
    const preload = vi.fn(
      async ({
        inputProps,
        signal,
      }: {
        inputProps: Readonly<{ title: string }>;
        signal: AbortSignal;
      }) => {
        expect(signal.aborted).toBe(false);
        if (inputProps.title === "second" && wait) await gate.promise;
      },
    );
    function Scene({ title }: { title: string }) {
      return <div>{title}</div>;
    }
    const protocol = registerReactComposition("scene", {
      ...config,
      component: Scene,
      defaultProps: { title: "first" },
      preload,
    });
    await protocol.seekFrame("scene", 4);
    expect(document.body.textContent).toBe("first");
    await protocol.setInputProps({ title: "second" });
    const seek = protocol.seekFrame("scene", 4);
    await vi.waitFor(() => expect(preload).toHaveBeenCalledTimes(2));
    expect(document.body.textContent).toBe("first");
    wait = false;
    gate.resolve();
    await seek;
    expect(document.body.textContent).toBe("second");
  });

  it("cancels in-flight preload, prevents its late commit, and cleans up before reinitializing", async () => {
    const gate = deferred<void>();
    let shouldWait = true;
    let observedSignal: AbortSignal | undefined;
    function Scene() {
      return <div>frame {useCurrentFrame()}</div>;
    }
    const protocol = registerReactComposition("scene", {
      ...config,
      component: Scene,
      async preload({ signal }) {
        observedSignal = signal;
        if (shouldWait) await gate.promise;
      },
    });
    const pending = protocol.seekFrame("scene", 90);
    const cancelled = expect(pending).rejects.toThrow(/cancelled/i);
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    protocol.cancelPending();
    await cancelled;
    expect(observedSignal!.aborted).toBe(true);
    let cleaned = false;
    const cleanup = protocol.destroy().then(() => {
      cleaned = true;
    });
    await Promise.resolve();
    expect(cleaned).toBe(false);
    shouldWait = false;
    gate.resolve();
    await cleanup;
    expect(document.body.children).toHaveLength(0);
    await protocol.seekFrame("scene", 12);
    expect(document.body.textContent).toBe("frame 12");
  });

  it("unmounts layout effects and owned roots, then mounts fresh state after destroy", async () => {
    const listener = vi.fn();
    const cleanup = vi.fn();
    function Scene() {
      const frame = useCurrentFrame();
      useLayoutEffect(() => {
        window.addEventListener("fixture", listener);
        return () => {
          window.removeEventListener("fixture", listener);
          cleanup();
        };
      }, []);
      return <div>frame {frame}</div>;
    }
    const protocol = registerReactComposition("scene", {
      ...config,
      component: Scene,
    });
    await protocol.seekFrame("scene", 90);
    window.dispatchEvent(new Event("fixture"));
    expect(listener).toHaveBeenCalledOnce();
    await protocol.destroy();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(document.body.children).toHaveLength(0);
    window.dispatchEvent(new Event("fixture"));
    expect(listener).toHaveBeenCalledOnce();
    await protocol.seekFrame("scene", 90);
    expect(document.body.textContent).toBe("frame 90");
    window.dispatchEvent(new Event("fixture"));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("restores an existing empty mount and never deletes nonempty user content", async () => {
    document.body.innerHTML =
      '<div id="owned-by-user" style="color:red"></div>';
    const protocol = registerReactComposition("scene", {
      ...config,
      component: () => <b>ready</b>,
      target: "#owned-by-user",
    });
    await protocol.seekFrame("scene", 0);
    await protocol.destroy();
    expect(document.querySelector("#owned-by-user")?.outerHTML).toBe(
      '<div id="owned-by-user" style="color:red"></div>',
    );
    document.querySelector("#owned-by-user")!.innerHTML = "original";
    await expect(protocol.seekFrame("scene", 0)).rejects.toThrow(
      /empty composition mount/,
    );
    expect(document.body.textContent).toBe("original");
  });

  it("rejects uncommitted suspense instead of reporting its fallback as a completed frame", async () => {
    const gate = deferred<void>();
    let ready = false;
    function Scene() {
      if (!ready) throw gate.promise;
      return <b>resolved</b>;
    }
    const protocol = registerReactComposition("scene", {
      ...config,
      component: Scene,
    });
    await expect(protocol.seekFrame("scene", 0)).rejects.toThrow(
      /frame did not commit/i,
    );
    await expect(protocol.seekFrame("scene", 0)).rejects.toThrow(
      /destroy before retrying/,
    );
    await protocol.destroy();
    ready = true;
    gate.resolve();
    await protocol.seekFrame("scene", 0);
    expect(document.body.textContent).toBe("resolved");
  });

  it("keeps composition roots and frame stores isolated", async () => {
    function Scene({ title }: { title: string }) {
      return (
        <div>
          {title}:{useCurrentFrame()}
        </div>
      );
    }
    const protocol = registerReactComposition("a", {
      ...config,
      component: Scene,
      defaultProps: { title: "a" },
    });
    registerReactComposition("b", {
      ...config,
      component: Scene,
      defaultProps: { title: "b" },
    });
    await protocol.seekFrame("a", 3);
    await protocol.seekFrame("b", 7);
    await protocol.seekFrame("a", 9);
    expect(document.body.textContent).toBe("a:9b:7");
    await protocol.destroy();
    expect(document.body.children).toHaveLength(0);
  });

  it("rejects non-object props without replacing the last committed DOM", async () => {
    const protocol = registerReactComposition("scene", {
      ...config,
      component: () => <b>ready</b>,
    });
    await protocol.seekFrame("scene", 0);
    await protocol.setInputProps(null);
    await expect(protocol.seekFrame("scene", 0)).rejects.toThrow(
      /inputProps must be an object/,
    );
    expect(document.body.textContent).toBe("ready");
  });

  it("releases fonts after failed mount so retries cannot leak registered faces", async () => {
    const faces = new Set<unknown>();
    vi.stubGlobal(
      "FontFace",
      class {
        load() {
          return Promise.resolve(this);
        }
      },
    );
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: {
        add: (face: unknown) => faces.add(face),
        delete: (face: unknown) => faces.delete(face),
      },
    });
    const protocol = registerReactComposition("scene", {
      ...config,
      component: () => <b>ready</b>,
      target: "#missing",
      fonts: [{ family: "Korean", source: 'local("Fixture")' }],
    });
    await expect(protocol.seekFrame("scene", 0)).rejects.toThrow(/#missing/);
    expect(faces.size).toBe(0);
    await expect(protocol.seekFrame("scene", 0)).rejects.toThrow(/#missing/);
    expect(faces.size).toBe(0);
  });

  it("propagates declared font failures before rendering", async () => {
    const render = vi.fn(() => <b>must not render</b>);
    vi.stubGlobal(
      "FontFace",
      class {
        load() {
          return Promise.reject(new Error("font unavailable"));
        }
      },
    );
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { add: vi.fn(), delete: vi.fn() },
    });
    const protocol = registerReactComposition("scene", {
      ...config,
      component: render,
      fonts: [{ family: "Korean", source: 'url("missing.woff2")' }],
    });
    await expect(protocol.seekFrame("scene", 0)).rejects.toThrow(
      /declared font did not load/,
    );
    expect(render).not.toHaveBeenCalled();
    expect(document.body.children).toHaveLength(0);
  });
});

describe("image preload readiness", () => {
  it("waits for decode and clears its detached image on cancellation", async () => {
    const gate = deferred<void>();
    const images: HTMLImageElement[] = [];
    vi.stubGlobal("Image", function () {
      const image = document.createElement("img");
      Object.defineProperty(image, "decode", { value: () => gate.promise });
      images.push(image);
      return image;
    });
    const controller = new AbortController();
    const pending = preloadImage("/image.png", { signal: controller.signal });
    expect(images[0]!.getAttribute("src")).toBe("/image.png");
    controller.abort(new Error("cancelled preload"));
    await expect(pending).rejects.toThrow("cancelled preload");
    expect(images[0]!.hasAttribute("src")).toBe(false);
    gate.reject(new Error("late decoder failure"));
    await Promise.resolve();
  });

  it("propagates decode failure before the first component layout effect", async () => {
    const layout = vi.fn();
    vi.stubGlobal("Image", function () {
      const image = document.createElement("img");
      Object.defineProperty(image, "decode", {
        value: () => Promise.reject(new Error("broken image")),
      });
      return image;
    });
    function Scene() {
      useLayoutEffect(layout, []);
      return <b>unready</b>;
    }
    const protocol = registerReactComposition("scene", {
      ...config,
      component: Scene,
      preload: ({ signal }) => preloadImage("/broken.png", { signal }),
    });
    await expect(protocol.seekFrame("scene", 0)).rejects.toThrow(
      /image could not be decoded/,
    );
    expect(layout).not.toHaveBeenCalled();
    expect(document.body.textContent).toBe("");
  });
});

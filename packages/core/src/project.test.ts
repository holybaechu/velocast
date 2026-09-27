import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  defineFrameComposition,
  defineProject,
  type FrameSession,
} from "./project.js";
import { VelocastRuntime } from "./runtime.js";

const video = {
  width: 320,
  height: 180,
  fps: 30,
  durationFrames: 90,
  target: "#video",
};

describe("composition projects", () => {
  beforeEach(() => {
    delete window.__velocast;
    delete window.Velocast;
  });

  it("defines without browser effects and validates the complete catalog before publication", () => {
    const open = vi.fn(() => ({ seekFrame() {} }));
    const composition = defineFrameComposition({
      id: "intro",
      video,
      source: { open },
    });
    expect(window.__velocast).toBeUndefined();
    expect(open).not.toHaveBeenCalled();
    expect(() =>
      new VelocastRuntime().startProject([composition, composition]),
    ).toThrow("VELOCAST_DUPLICATE_COMPOSITION");
    expect(window.__velocast).toBeUndefined();
    expect(() =>
      new VelocastRuntime().startProject([
        composition,
        { ...composition, id: "invalid", video: { ...video, fps: 0 } },
      ]),
    ).toThrow("fps");
    expect(window.__velocast).toBeUndefined();
  });

  it("retains one protocol object for legacy registration and rejects late registration", async () => {
    const runtime = new VelocastRuntime();
    const protocol = runtime.installBrowserProtocol();
    const adapter = { id: "a", getDurationFrames: () => 90, seekFrame() {} };
    expect(runtime.registerFrameAdapter("a", adapter, video)).toBe(protocol);
    expect(runtime.registerFrameAdapter("b", adapter, video)).toBe(protocol);
    await protocol.beginSession({ sessionId: "render" });
    expect(() => runtime.registerFrameAdapter("c", adapter, video)).toThrow(
      "VELOCAST_CATALOG_BOUND",
    );
    expect((await protocol.getCompositions()).map((item) => item.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("shares frozen props and one session between audio and frames, then disposes before reopening", async () => {
    const events: string[] = [];
    const runtime = new VelocastRuntime();
    const protocol = runtime.startProject(
      defineProject([
        defineFrameComposition({
          id: "intro",
          video,
          defaultProps: { title: "Default", nested: { value: 1 } },
          source: {
            open(context) {
              expect(context.signal).toBeInstanceOf(AbortSignal);
              expect(Object.isFrozen(context.inputProps.nested)).toBe(true);
              const title = context.inputProps.title;
              events.push(`open:${title}`);
              return {
                getAudioPlan(audioContext) {
                  expect(audioContext.inputProps).toBe(context.inputProps);
                  events.push(`audio:${title}`);
                  return null;
                },
                seekFrame(frame, frameContext) {
                  expect(frameContext.inputProps).toBe(context.inputProps);
                  events.push(`frame:${title}:${frame}`);
                },
                dispose() {
                  events.push(`dispose:${title}`);
                },
              };
            },
          },
        }),
      ]),
    );
    const input = { title: "First" };
    await protocol.setInputProps(input);
    input.title = "Mutated";
    await protocol.getAudioPlan!("intro");
    await protocol.seekFrame("intro", 10);
    await protocol.setInputProps({ title: "Second" });
    await protocol.seekFrame("intro", 10);
    expect(events).toEqual([
      "open:First",
      "audio:First",
      "frame:First:10",
      "dispose:First",
      "open:Second",
      "frame:Second:10",
    ]);
    await protocol.destroy();
    await protocol.seekFrame("intro", 0);
    expect(events.slice(-3)).toEqual([
      "dispose:Second",
      "open:Default",
      "frame:Default:0",
    ]);
  });

  it("resolves the capture target as the source root after opening", async () => {
    const target = document.createElement("div");
    target.id = "video";
    const protocol = new VelocastRuntime().startProject([
      defineFrameComposition({
        id: "intro",
        video,
        source: {
          open() {
            document.body.append(target);
            return {
              seekFrame(_frame, context) {
                expect(context.rootElement).toBe(target);
              },
              dispose() {
                target.remove();
              },
            };
          },
        },
      }),
    ]);
    await protocol.seekFrame("intro", 0);
    await protocol.destroy();
    expect(target.isConnected).toBe(false);
  });

  it("resolves input-dependent metadata atomically and preserves the previous session on invalid input", async () => {
    const dispose = vi.fn();
    const protocol = new VelocastRuntime().startProject([
      defineFrameComposition({
        id: "intro",
        video,
        defaultProps: { frames: 90 },
        resolveVideo: (props) => ({ ...video, durationFrames: props.frames }),
        source: { open: () => ({ seekFrame() {}, dispose }) },
      }),
    ]);
    await protocol.setInputProps({ frames: 120 });
    expect((await protocol.getCompositions())[0]?.durationFrames).toBe(120);
    await protocol.seekFrame("intro", 110);
    await expect(protocol.setInputProps({ frames: 0 })).rejects.toThrow(
      "durationFrames",
    );
    expect(dispose).not.toHaveBeenCalled();
    expect(await protocol.getDurationFrames("intro")).toBe(120);
  });

  it("reopens for per-request props and uses their resolved duration", async () => {
    const frames: number[] = [];
    const protocol = new VelocastRuntime().startProject([
      defineFrameComposition({
        id: "intro",
        video,
        defaultProps: { frames: 90 },
        resolveVideo: (props) => ({ ...video, durationFrames: props.frames }),
        source: {
          open: () => ({
            seekFrame(frame) {
              frames.push(frame);
            },
          }),
        },
      }),
    ]);
    await protocol.seekFrame("intro", 100, {
      compositionId: "intro",
      ...video,
      inputProps: { frames: 10 },
    });
    expect(frames).toEqual([9]);
    expect(await protocol.getDurationFrames("intro")).toBe(10);
  });

  it("accepts required external props before resolving the catalog", async () => {
    const parseProps = vi.fn((value: unknown) => {
      if (!value || typeof value !== "object" || !("title" in value))
        throw new Error("title required");
      return { title: String(value.title) };
    });
    const protocol = new VelocastRuntime().startProject([
      defineFrameComposition({
        id: "intro",
        video,
        parseProps,
        source: { open: () => ({ seekFrame() {} }) },
      }),
    ]);
    expect(parseProps).not.toHaveBeenCalled();
    await protocol.setInputProps({ title: "External" });
    await expect(protocol.getCompositions()).resolves.toHaveLength(1);
    expect(parseProps).toHaveBeenCalledOnce();
  });

  it("pins props before asynchronous metadata resolution and reuses equivalent snapshots", async () => {
    let finish: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const resolveVideo = vi.fn(async (props: { frames: number }) => {
      await ready;
      return { ...video, durationFrames: props.frames };
    });
    const opens: number[] = [];
    const protocol = new VelocastRuntime().startProject([
      defineFrameComposition({
        id: "intro",
        video,
        defaultProps: { frames: 90 },
        resolveVideo,
        source: {
          open(context) {
            opens.push(context.inputProps.frames);
            return { seekFrame() {} };
          },
        },
      }),
    ]);
    const input = { frames: 20 };
    const setting = protocol.setInputProps(input);
    input.frames = 30;
    finish!();
    await setting;
    await protocol.seekFrame("intro", 0);
    await protocol.setInputProps({ frames: 20 });
    await protocol.seekFrame("intro", 0);
    expect(opens).toEqual([20]);
    expect(resolveVideo).toHaveBeenCalledOnce();
    expect(await protocol.getDurationFrames("intro")).toBe(20);
  });

  it("preserves explicit undefined overrides when comparing input snapshots", async () => {
    const values: unknown[] = [];
    const protocol = new VelocastRuntime().startProject([
      defineFrameComposition({
        id: "intro",
        video,
        defaultProps: { title: "Default" as string | undefined },
        source: {
          open(context) {
            values.push(context.inputProps.title);
            return { seekFrame() {} };
          },
        },
      }),
    ]);
    await protocol.setInputProps({});
    await protocol.seekFrame("intro", 0);
    await protocol.seekFrame("intro", 0, {
      compositionId: "intro",
      ...video,
      inputProps: { title: undefined },
    });
    expect(values).toEqual(["Default", undefined]);
  });

  it("requires successful cleanup before opening another source after disposal fails", async () => {
    let attempts = 0;
    const open = vi.fn(() => ({
      seekFrame() {},
      dispose() {
        if (++attempts === 1) throw new Error("cleanup failed");
      },
    }));
    const protocol = new VelocastRuntime().startProject([
      defineFrameComposition({ id: "intro", video, source: { open } }),
    ]);
    await protocol.seekFrame("intro", 0);
    await expect(protocol.setInputProps({ title: "Next" })).rejects.toThrow(
      "VELOCAST_DESTROY_FAILED",
    );
    await expect(protocol.seekFrame("intro", 0)).rejects.toThrow(
      "VELOCAST_RUNTIME_CANCELLED",
    );
    expect(open).toHaveBeenCalledOnce();
    await protocol.destroy();
    expect(attempts).toBe(2);
    await protocol.seekFrame("intro", 0);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("snapshots descriptor metadata and callbacks before catalog preparation", async () => {
    const seen: string[] = [];
    const raw = {
      id: "intro",
      video: { ...video },
      source: {
        open: () => {
          seen.push("original");
          return { seekFrame() {} };
        },
      },
    };
    const protocol = new VelocastRuntime().startProject([raw]);
    raw.video.durationFrames = 7;
    raw.source.open = () => {
      seen.push("mutated");
      return { seekFrame() {} };
    };
    await protocol.seekFrame("intro", 0);
    expect(await protocol.getDurationFrames("intro")).toBe(90);
    expect(seen).toEqual(["original"]);
  });

  it("rejects synchronous catalog reads until input-dependent metadata is prepared", async () => {
    const runtime = new VelocastRuntime();
    const protocol = runtime.startProject([
      defineFrameComposition({
        id: "intro",
        video,
        defaultProps: { frames: 15 },
        resolveVideo: (props) => ({ ...video, durationFrames: props.frames }),
        source: { open: () => ({ seekFrame() {} }) },
      }),
    ]);
    expect(() => runtime.getRenderableCompositions()).toThrow(
      "VELOCAST_PROJECT_UNPREPARED",
    );
    expect((await protocol.getCompositions())[0]?.durationFrames).toBe(15);
    expect(runtime.getRenderableCompositions()[0]?.durationFrames).toBe(15);
    await protocol.destroy();
    expect(() => runtime.getRenderableCompositions()).toThrow(
      "VELOCAST_PROJECT_UNPREPARED",
    );
  });

  it("disposes an invalid source session before allowing a retry", async () => {
    const dispose = vi.fn();
    const open = vi.fn(() => ({ dispose }) as unknown as FrameSession);
    const protocol = new VelocastRuntime().startProject([
      defineFrameComposition({ id: "intro", video, source: { open } }),
    ]);
    await expect(protocol.seekFrame("intro", 0)).rejects.toThrow(
      "source.open must return a frame session",
    );
    expect(dispose).toHaveBeenCalledOnce();
    open.mockImplementation(() => ({ seekFrame() {}, dispose }));
    await protocol.seekFrame("intro", 0);
    await protocol.destroy();
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it("retains an invalid source session for cleanup retry if its disposal fails", async () => {
    const dispose = vi
      .fn()
      .mockRejectedValueOnce(new Error("cleanup failed"))
      .mockResolvedValue(undefined);
    const open = vi.fn(() => ({ dispose }) as unknown as FrameSession);
    const protocol = new VelocastRuntime().startProject([
      defineFrameComposition({ id: "intro", video, source: { open } }),
    ]);
    await expect(protocol.seekFrame("intro", 0)).rejects.toThrow(
      "cleanup failed",
    );
    await expect(protocol.seekFrame("intro", 0)).rejects.toThrow(
      "VELOCAST_RUNTIME_CANCELLED",
    );
    await protocol.destroy();
    expect(open).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it("defines input-dependent video metadata without a static placeholder", async () => {
    const resolveVideo = vi.fn(
      (props: { frames: number }, context: { signal: AbortSignal }) => {
        expect(Object.isFrozen(props)).toBe(true);
        expect(context.signal.aborted).toBe(false);
        return {
          ...video,
          width: props.frames * 10,
          durationFrames: props.frames,
        };
      },
    );
    const opened: number[] = [];
    const composition = defineFrameComposition({
      id: "dynamic",
      defaultProps: { frames: 12 },
      resolveVideo,
      source: {
        open(context) {
          opened.push(context.durationFrames);
          return { seekFrame() {} };
        },
      },
    });
    expect(composition.video).toBeUndefined();
    const runtime = new VelocastRuntime();
    const protocol = runtime.startProject([composition]);
    expect(resolveVideo).not.toHaveBeenCalled();
    expect(() => runtime.getRenderableCompositions()).toThrow(
      "VELOCAST_PROJECT_UNPREPARED",
    );
    expect((await protocol.getCompositions())[0]).toMatchObject({
      id: "dynamic",
      width: 120,
      durationFrames: 12,
    });
    expect(opened).toEqual([]);
    await protocol.seekFrame("dynamic", 0);
    await protocol.setInputProps({ frames: 24 });
    expect(await protocol.getDurationFrames("dynamic")).toBe(24);
    await protocol.seekFrame("dynamic", 0);
    expect(opened).toEqual([12, 24]);
  });

  it("publishes no partial catalog when a dynamic-only composition fails preparation", async () => {
    const open = vi.fn(() => ({ seekFrame() {} }));
    const runtime = new VelocastRuntime();
    const protocol = runtime.startProject([
      defineFrameComposition({ id: "static", video, source: { open } }),
      defineFrameComposition({
        id: "dynamic",
        defaultProps: { frames: 0 },
        resolveVideo: (props) => ({ ...video, durationFrames: props.frames }),
        source: { open },
      }),
    ]);
    await expect(protocol.getCompositions()).rejects.toThrow("durationFrames");
    expect(() => runtime.getRenderableCompositions()).toThrow(
      "VELOCAST_PROJECT_UNPREPARED",
    );
    expect(open).not.toHaveBeenCalled();
    await protocol.setInputProps({ frames: 20 });
    expect(
      (await protocol.getCompositions()).map((item) => item.durationFrames),
    ).toEqual([90, 20]);
    await expect(protocol.setInputProps({ frames: -1 })).rejects.toThrow(
      "durationFrames",
    );
    expect(
      runtime.getRenderableCompositions().map((item) => item.durationFrames),
    ).toEqual([90, 20]);
  });

  it("requires either static video metadata or a resolver", () => {
    expect(() => {
      // @ts-expect-error A source without any video metadata cannot define a composition.
      defineFrameComposition({
        id: "missing",
        source: { open: () => ({ seekFrame() {} }) },
      });
    }).toThrow("define video or resolveVideo");
  });
});

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  sliceAudioPlanByFrames,
  startVelocast,
  type VideoProject,
} from "@velocast/core";
import { clearFrameAdaptersForTest } from "@velocast/core/testing";
import { defineProjectCompositions } from "./project-composition.js";
const originalImageDecode = Object.getOwnPropertyDescriptor(
  HTMLImageElement.prototype,
  "decode",
);

function project(): VideoProject {
  return {
    format: "velocast-project",
    version: 1,
    name: "Demo",
    assets: [],
    compositions: [
      {
        id: "demo",
        name: "Demo",
        width: 320,
        height: 180,
        fps: 30,
        durationFrames: 120,
        background: "#101820",
        scenes: [
          {
            id: "second",
            name: "Second scene",
            from: 60,
            durationFrames: 60,
            background: "#ffffff",
          },
        ],
        layers: [
          {
            id: "title",
            name: "Title",
            kind: "text",
            sceneId: "second",
            from: 10,
            durationFrames: 30,
            x: 20,
            y: 30,
            width: 200,
            height: 60,
            rotation: 5,
            opacity: 0.8,
            text: "Shared source",
            color: "#123456",
            fontSize: 24,
            fadeInFrames: 10,
            fadeOutFrames: 10,
          },
        ],
      },
    ],
  };
}

beforeEach(() => {
  clearFrameAdaptersForTest();
  window.__velocast = undefined;
  document.body.innerHTML = "";
});
afterEach(async () => {
  await window.__velocast?.destroy();
  clearFrameAdaptersForTest();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (originalImageDecode)
    Object.defineProperty(
      HTMLImageElement.prototype,
      "decode",
      originalImageDecode,
    );
  else Reflect.deleteProperty(HTMLImageElement.prototype, "decode");
});

it("rasterizes a ready image once, releases its bitmap, and identifies failed assets", async () => {
  const source = project();
  source.assets.push({
    id: "picture",
    name: "Picture",
    kind: "image",
    src: "assets/picture.png",
  });
  source.compositions[0]!.layers.push({
    id: "picture",
    name: "Picture",
    kind: "image",
    from: 10,
    durationFrames: 20,
    x: 0,
    y: 0,
    width: 320,
    height: 180,
    rotation: 0,
    opacity: 1,
    assetId: "picture",
    fit: "cover",
  });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const decode = vi.fn(() => gate);
  const close = vi.fn();
  const bitmap = { width: 320, height: 180, close };
  const rasterize = vi.fn(async () => bitmap);
  vi.stubGlobal("createImageBitmap", rasterize);
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage,
  } as unknown as CanvasRenderingContext2D);
  Object.defineProperty(HTMLImageElement.prototype, "decode", {
    configurable: true,
    value: decode,
  });
  const protocol = startVelocast(defineProjectCompositions(source));
  await protocol.seekFrame("demo", 0);
  expect(decode).not.toHaveBeenCalled();
  const seek = protocol.seekFrame("demo", 10);
  await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
  let complete = false;
  void seek.then(() => {
    complete = true;
  });
  await Promise.resolve();
  expect(complete).toBe(false);
  release();
  await seek;
  expect(document.querySelector("canvas")!.style.objectFit).toBe("cover");
  expect(document.querySelector("img")).toBeNull();
  expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0);
  expect(close).toHaveBeenCalledOnce();
  await protocol.seekFrame("demo", 15);
  await protocol.seekFrame("demo", 10);
  expect(rasterize).toHaveBeenCalledOnce();
  source.assets[0]!.src = "assets/broken.png";
  await protocol.setInputProps(source);
  decode.mockRejectedValueOnce(new Error("cannot decode"));
  await expect(protocol.seekFrame("demo", 10)).rejects.toThrow(
    /image.*assets\/broken.png/,
  );
});

it("releases an image bitmap completed after cancellation without painting it", async () => {
  const source = project();
  source.assets.push({
    id: "poster",
    name: "Poster",
    kind: "image",
    src: "assets/poster.gif",
  });
  source.compositions[0]!.layers = [
    {
      ...source.compositions[0]!.layers[0]!,
      kind: "image",
      assetId: "poster",
      sceneId: undefined,
      from: 0,
      durationFrames: 120,
    },
  ];
  Reflect.deleteProperty(source.compositions[0]!.layers[0]!, "sceneId");
  Object.defineProperty(HTMLImageElement.prototype, "decode", {
    configurable: true,
    value: () => Promise.resolve(),
  });
  let release!: (bitmap: {
    width: number;
    height: number;
    close(): void;
  }) => void;
  const bitmapReady = new Promise<{
    width: number;
    height: number;
    close(): void;
  }>((resolve) => {
    release = resolve;
  });
  const rasterize = vi.fn(() => bitmapReady);
  vi.stubGlobal("createImageBitmap", rasterize);
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage,
  } as unknown as CanvasRenderingContext2D);
  const protocol = startVelocast(defineProjectCompositions(source));
  const pending = protocol.seekFrame("demo", 0);
  const cancelled = expect(pending).rejects.toThrow(/cancelled/i);
  await vi.waitFor(() => expect(rasterize).toHaveBeenCalledOnce());
  protocol.cancelPending();
  await cancelled;
  const disposed = protocol.destroy();
  const close = vi.fn();
  release({ width: 320, height: 180, close });
  await disposed;
  expect(close).toHaveBeenCalledOnce();
  expect(drawImage).not.toHaveBeenCalled();
  expect(document.body.children).toHaveLength(0);
});

it.each([
  [0, 0, 320, 180],
  [400, 200, 400, 200],
])(
  "provides SVG bitmap dimensions while preserving resolved image aspect (%s×%s)",
  async (naturalWidth, naturalHeight, width, height) => {
    const source = project();
    source.assets.push({
      id: "vector",
      name: "Vector",
      kind: "image",
      src: "assets/viewbox.svg",
    });
    source.compositions[0]!.layers = [
      {
        ...source.compositions[0]!.layers[0]!,
        kind: "image",
        assetId: "vector",
        width: 320,
        height: 180,
        fit: "cover",
      },
    ];
    vi.stubGlobal("Image", function () {
      const image = document.createElement("img");
      Object.defineProperties(image, {
        naturalWidth: { value: naturalWidth },
        naturalHeight: { value: naturalHeight },
        decode: { value: () => Promise.resolve() },
      });
      return image;
    });
    const close = vi.fn();
    const rasterize = vi.fn(
      async (_image: HTMLImageElement, options?: ImageBitmapOptions) => {
        if (!options?.resizeWidth || !options.resizeHeight)
          throw new DOMException(
            "SVG requires explicit dimensions",
            "InvalidStateError",
          );
        return {
          width: options.resizeWidth,
          height: options.resizeHeight,
          close,
        };
      },
    );
    vi.stubGlobal("createImageBitmap", rasterize);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    const protocol = startVelocast(defineProjectCompositions(source));
    await protocol.seekFrame("demo", 75);
    expect(rasterize).toHaveBeenCalledWith(expect.any(HTMLImageElement), {
      resizeWidth: width,
      resizeHeight: height,
    });
    const canvas = document.querySelector("canvas")!;
    expect([canvas.width, canvas.height, canvas.style.objectFit]).toEqual([
      width,
      height,
      "cover",
    ]);
    expect(close).toHaveBeenCalledOnce();
  },
);

it.each([true, false])(
  "uses one absolute clock for scene video frames and full-length audio (video hasAudio=%s)",
  async (hasAudio) => {
    const source = project();
    source.assets.push(
      {
        id: "music",
        name: "Music",
        kind: "audio",
        src: "assets/music.wav",
        durationSeconds: 5,
      },
      {
        id: "clip",
        name: "Clip",
        kind: "video",
        hasAudio,
        src: "assets/clip.mp4",
        durationSeconds: 2,
      },
    );
    source.compositions[0]!.layers.push(
      {
        id: "music",
        name: "Music",
        kind: "audio",
        from: 0,
        durationFrames: 120,
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        rotation: 0,
        opacity: 1,
        assetId: "music",
        gain: 0.25,
      },
      {
        id: "clip",
        name: "Clip",
        kind: "video",
        sceneId: "second",
        from: 3,
        durationFrames: 20,
        x: 0,
        y: 0,
        width: 160,
        height: 90,
        rotation: 0,
        opacity: 1,
        assetId: "clip",
        trimBeforeFrames: 8,
        gain: 0.7,
        fadeInFrames: 5,
        fadeOutFrames: 7,
      },
    );
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      clearRect() {},
      createImageData: () => ({ data: new Uint8ClampedArray(4) }),
      putImageData() {},
    } as unknown as CanvasRenderingContext2D);
    const requests: number[] = [];
    vi.stubGlobal("fetch", async (url: URL) => {
      const seconds = Number(url.searchParams.get("seconds"));
      requests.push(seconds);
      return new Response(new Uint8Array([0, 0, 0, 255]), {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": "4",
          "X-Velocast-Session-Id": "project-session",
          "X-Velocast-Source-Version": "source-1",
          "X-Velocast-Frame-Width": "1",
          "X-Velocast-Frame-Height": "1",
          "X-Velocast-Frame-PTS": String(Math.round(seconds * 30000)),
          "X-Velocast-Frame-Time-Base-Numerator": "1",
          "X-Velocast-Frame-Time-Base-Denominator": "30000",
        },
      });
    });
    const protocol = startVelocast(defineProjectCompositions(source));
    const session = { sessionId: "project-session", sourceVersion: "source-1" };
    await protocol.beginSession(session);
    const context = {
      compositionId: "demo",
      width: 320,
      height: 180,
      fps: 30,
      durationFrames: 120,
      renderSession: session,
    };
    const audio = await protocol.getAudioPlan!("demo", context);
    expect(audio).toMatchObject({
      sampleRate: 48000,
      durationSamples: 192000,
      clips: [
        {
          source: "assets/music.wav",
          startSample: 0,
          sourceStartSample: 0,
          durationSamples: 192000,
          gain: 0.25,
        },
        ...(hasAudio
          ? [
              {
                source: "assets/clip.mp4",
                startSample: 100800,
                sourceStartSample: 12800,
                durationSamples: 32000,
                gain: 0.7,
                volumeEnvelope: [
                  { sample: 0, gain: 0 },
                  { sample: 8000, gain: 1 },
                  { sample: 20800, gain: 1 },
                  { sample: 32000, gain: 0 },
                ],
              },
            ]
          : []),
      ],
    });
    const range = sliceAudioPlanByFrames(audio!, 70, 80, 30, "round");
    expect(range).toMatchObject({
      durationSamples: 16000,
      clips: [
        { sourceStartSample: 112000, startSample: 0, durationSamples: 16000 },
        ...(hasAudio
          ? [
              {
                sourceStartSample: 24000,
                startSample: 0,
                durationSamples: 16000,
              },
            ]
          : []),
      ],
    });
    for (const frame of [63, 82, 70, 63]) {
      await protocol.seekFrame("demo", frame, context);
      expect(requests.at(-1)).toBe((frame - 63 + 8) / 30);
      expect(document.querySelector("canvas")!.dataset.velocastVideoPts).toBe(
        String((frame - 63 + 8) * 1000),
      );
    }
    expect(requests).toHaveLength(4);
    await protocol.seekFrame("demo", 83, context);
    expect(document.querySelector("canvas")).toBeNull();
    expect(requests).toHaveLength(4);
  },
);

it("renders exact scene-local frames in either direction and reflects saved source and metadata edits", async () => {
  const source = project();
  const protocol = startVelocast(defineProjectCompositions(source));
  await protocol.seekFrame("demo", 75);
  let title = document.querySelector<HTMLElement>(
    '[data-velocast-layer="title"]',
  )!;
  expect(title.textContent).toBe("Shared source");
  expect(title.style.left).toBe("20px");
  expect(title.style.transform).toBe("rotate(5deg)");
  expect(title.style.opacity).toBe("0.4");
  expect(title.parentElement!.style.backgroundColor).toBe("rgb(255, 255, 255)");
  await protocol.seekFrame("demo", 100);
  expect(document.querySelector('[data-velocast-layer="title"]')).toBeNull();
  await protocol.seekFrame("demo", 69);
  expect(document.querySelector('[data-velocast-layer="title"]')).toBeNull();
  source.compositions[0]!.width = 640;
  source.compositions[0]!.durationFrames = 180;
  source.compositions[0]!.layers[0]!.text = "Edited";
  await protocol.setInputProps(source);
  expect(await protocol.getCompositions()).toMatchObject([
    { id: "demo", width: 640, durationFrames: 180 },
  ]);
  await protocol.seekFrame("demo", 95);
  title = document.querySelector<HTMLElement>('[data-velocast-layer="title"]')!;
  expect(title.textContent).toBe("Edited");
  expect(title.style.opacity).toBe("0.4");
  expect(title.parentElement!.style.width).toBe("640px");
  await protocol.destroy();
  expect(document.body.children).toHaveLength(0);
});

it("returns no audio plan for a standalone silent video and respects a saved audio-presence change", async () => {
  const source = project();
  source.assets.push({
    id: "clip",
    name: "Clip",
    kind: "video",
    src: "assets/clip.mp4",
    hasAudio: false,
  });
  Object.assign(source.compositions[0]!.layers[0]!, {
    kind: "video",
    assetId: "clip",
  });
  const protocol = startVelocast(defineProjectCompositions(source));
  await expect(protocol.getAudioPlan!("demo")).resolves.toBeNull();
  source.assets[0]!.hasAudio = true;
  await protocol.setInputProps(source);
  expect(await protocol.getAudioPlan!("demo")).toMatchObject({
    clips: [{ source: "assets/clip.mp4", gain: 1 }],
  });
});

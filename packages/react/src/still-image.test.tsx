import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearFrameAdaptersForTest } from "@velocast/core/testing";
import {
  Layer,
  StillImage,
  registerReactComposition,
  type StillImageProps,
} from "./index.js";

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
});

it("awaits image readiness, preserves natural aspect and styles, and refreshes its source at the same frame", async () => {
  let release!: () => void;
  const decoded = new Promise<void>((resolve) => {
    release = resolve;
  });
  const decode = vi.fn(() => decoded);
  vi.stubGlobal("Image", function () {
    const image = document.createElement("img");
    Object.defineProperties(image, {
      naturalWidth: { value: 400 },
      naturalHeight: { value: 200 },
      decode: { value: decode },
    });
    return image;
  });
  const close = vi.fn();
  const bitmap = { width: 400, height: 200, close };
  const rasterize = vi.fn(async () => bitmap);
  vi.stubGlobal("createImageBitmap", rasterize);
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage,
  } as unknown as CanvasRenderingContext2D);
  const protocol = registerReactComposition("image", {
    width: 320,
    height: 180,
    fps: 30,
    durationFrames: 60,
    defaultProps: { src: "assets/first.svg" },
    component: ({ src }: { src: string }) => (
      <Layer id="picture" width={200} height={100}>
        <StillImage
          src={src}
          alt="Product screenshot"
          className="product-picture"
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      </Layer>
    ),
  });
  const seek = protocol.seekFrame("image", 12);
  await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
  expect(drawImage).not.toHaveBeenCalled();
  release();
  await seek;
  let canvas = document.querySelector("canvas")!;
  expect([
    canvas.width,
    canvas.height,
    canvas.style.width,
    canvas.style.objectFit,
  ]).toEqual([400, 200, "100%", "cover"]);
  expect(canvas.getAttribute("aria-label")).toBe("Product screenshot");
  expect(canvas.className).toBe("product-picture");
  expect(rasterize).toHaveBeenCalledWith(expect.any(HTMLImageElement), {
    resizeWidth: 400,
    resizeHeight: 200,
  });
  expect(close).toHaveBeenCalledOnce();
  await protocol.setInputProps({ src: "assets/second.svg" });
  await protocol.seekFrame("image", 12);
  canvas = document.querySelector("canvas")!;
  expect(canvas.dataset.velocastImageSrc).toBe("assets/second.svg");
  expect(drawImage).toHaveBeenCalledTimes(2);
  expect(close).toHaveBeenCalledTimes(2);
});

it("rejects missing image sources and invalid dimensions before decoding", async () => {
  const report = (event: ErrorEvent) => event.preventDefault();
  window.addEventListener("error", report);
  vi.spyOn(console, "error").mockImplementation(() => {});
  const invalid: Array<[Partial<StillImageProps>, string]> = [
    [{ src: " " }, "src"],
    [{ width: NaN }, "width"],
    [{ height: -1 }, "height"],
  ];
  try {
    for (const [props, field] of invalid) {
      const protocol = registerReactComposition(`invalid-${field}`, {
        width: 320,
        height: 180,
        fps: 30,
        durationFrames: 30,
        component: () => <StillImage src="assets/image.svg" {...props} />,
      });
      await expect(protocol.seekFrame(`invalid-${field}`, 0)).rejects.toThrow(
        new RegExp(`VELOCAST_STILL_IMAGE_INVALID.*${field}`),
      );
      await protocol.destroy();
      clearFrameAdaptersForTest();
      window.__velocast = undefined;
    }
  } finally {
    window.removeEventListener("error", report);
  }
});

it("uses the rendered parent box for SVGs without natural dimensions or numeric size props", async () => {
  vi.stubGlobal("Image", function () {
    const image = document.createElement("img");
    Object.defineProperty(image, "decode", { value: () => Promise.resolve() });
    return image;
  });
  vi.spyOn(HTMLCanvasElement.prototype, "clientWidth", "get").mockReturnValue(
    200,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "clientHeight", "get").mockReturnValue(
    100,
  );
  const close = vi.fn();
  const rasterize = vi.fn(async () => ({ width: 200, height: 100, close }));
  vi.stubGlobal("createImageBitmap", rasterize);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  const protocol = registerReactComposition("svg", {
    width: 640,
    height: 360,
    fps: 30,
    durationFrames: 60,
    component: () => (
      <Layer id="picture" width={200} height={100}>
        <StillImage
          src="assets/viewbox.svg"
          style={{ width: "100%", height: "100%", objectFit: "contain" }}
        />
      </Layer>
    ),
  });
  await protocol.seekFrame("svg", 0);
  expect(rasterize).toHaveBeenCalledWith(expect.any(HTMLImageElement), {
    resizeWidth: 200,
    resizeHeight: 100,
  });
  expect(close).toHaveBeenCalledOnce();
});

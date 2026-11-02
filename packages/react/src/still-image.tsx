import { useRef, type CSSProperties } from "react";
import { useVideoConfig } from "./frame-state.js";
import { useFrameResource } from "./frame-resources.js";
import { abortable } from "./resources.js";

export interface StillImageProps {
  readonly src: string;
  readonly width?: number;
  readonly height?: number;
  readonly style?: CSSProperties;
  readonly className?: string;
  readonly alt?: string;
}

/** A decoded still poster, including the default/first frame of animated image files. */
export function StillImage({
  src,
  width,
  height,
  style,
  className,
  alt = "",
}: StillImageProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const rasterized = useRef<string>();
  const config = useVideoConfig();
  if (typeof src !== "string" || !src.trim())
    throw new Error(
      "VELOCAST_STILL_IMAGE_INVALID: src must be a nonempty string",
    );
  for (const [field, value] of Object.entries({ width, height }))
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    )
      throw new Error(
        `VELOCAST_STILL_IMAGE_INVALID: ${field} must be finite and nonnegative`,
      );
  useFrameResource(async (signal) => {
    const canvas = ref.current!;
    const fallbackWidth = width ?? (canvas.clientWidth || config.width);
    const fallbackHeight = height ?? (canvas.clientHeight || config.height);
    const rasterKey = JSON.stringify([src, fallbackWidth, fallbackHeight]);
    if (rasterized.current === rasterKey) return;
    const image = new Image();
    try {
      image.src = src;
      await abortable(image.decode(), signal);
      signal.throwIfAborted();
      // ImageBitmap uses an animation's default/first frame, never wall-clock playback.
      const bitmap = await createImageBitmap(image, {
        resizeWidth: Math.max(
          1,
          Math.round(image.naturalWidth || fallbackWidth),
        ),
        resizeHeight: Math.max(
          1,
          Math.round(image.naturalHeight || fallbackHeight),
        ),
      });
      try {
        signal.throwIfAborted();
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("2D canvas context is unavailable");
        context.drawImage(bitmap, 0, 0);
        rasterized.current = rasterKey;
      } finally {
        bitmap.close();
      }
    } catch (cause) {
      signal.throwIfAborted();
      throw new Error(
        `VELOCAST_STILL_IMAGE_FAILED: image ${src} could not be decoded or rasterized`,
        { cause },
      );
    } finally {
      image.removeAttribute("src");
    }
  });
  return (
    <canvas
      ref={ref}
      data-velocast-image-src={src}
      className={className}
      role={alt ? "img" : undefined}
      aria-label={alt || undefined}
      aria-hidden={alt ? undefined : true}
      style={{
        width: width ?? "100%",
        height: height ?? "100%",
        objectFit: "contain",
        display: "block",
        ...style,
      }}
    >
      {alt}
    </canvas>
  );
}

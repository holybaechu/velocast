import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";
import { framesToSeconds } from "@velocast/core";
import { useCurrentFrame, useVideoConfig } from "./frame-state.js";
import { useFrameResource } from "./frame-resources.js";

export interface VideoFrame {
  readonly pts: number;
  readonly timeBase: {
    readonly numerator: number;
    readonly denominator: number;
  };
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}
export type VideoFrameLoader = (
  src: string,
  sourceSeconds: number,
  signal: AbortSignal,
) => Promise<VideoFrame>;
export interface VideoFrameProviderProps {
  getFrame: VideoFrameLoader;
  children?: ReactNode;
}
const VideoContext = createContext<VideoFrameLoader | null>(null);

/** Transport/decoding is injected; this provider never starts media or networking. */
export function VideoFrameProvider({
  getFrame,
  children,
}: VideoFrameProviderProps) {
  if (typeof getFrame !== "function")
    throw new Error(
      "VELOCAST_VIDEO_PROVIDER_INVALID: getFrame must be a function",
    );
  return (
    <VideoContext.Provider value={getFrame}>{children}</VideoContext.Provider>
  );
}

export interface VideoClipProps {
  src: string;
  /** Clip audio is disabled; declare it through the authored audio plan. */
  muted: true;
  /** Both trim boundaries are measured at OUTPUT fps, not decoded source ordinals. */
  trimBeforeFrames?: number;
  trimAfterFrames?: number;
  className?: string;
  style?: CSSProperties;
}

const MAX_RGBA_BYTES = 32 * 1024 * 1024;
function boundary(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(
      `VELOCAST_VIDEO_INVALID_TRIM: ${name} must be a nonnegative safe integer`,
    );
}
function validateFrame(frame: VideoFrame): void {
  const bytes = frame?.width * frame?.height * 4;
  const byteView =
    ArrayBuffer.isView(frame?.rgba) && frame.rgba.BYTES_PER_ELEMENT === 1;
  if (
    !frame ||
    !Number.isSafeInteger(frame.width) ||
    frame.width < 1 ||
    !Number.isSafeInteger(frame.height) ||
    frame.height < 1 ||
    !Number.isSafeInteger(bytes) ||
    bytes > MAX_RGBA_BYTES ||
    !byteView ||
    frame.rgba.byteLength !== bytes ||
    !Number.isSafeInteger(frame.pts) ||
    !frame.timeBase ||
    !Number.isSafeInteger(frame.timeBase.numerator) ||
    frame.timeBase.numerator < 1 ||
    !Number.isSafeInteger(frame.timeBase.denominator) ||
    frame.timeBase.denominator < 1
  )
    throw new Error(
      "VELOCAST_VIDEO_INVALID_FRAME: provider must return one bounded RGBA frame with valid PTS/time base/dimensions",
    );
}
function clearCanvas(canvas: HTMLCanvasElement, empty: boolean): void {
  canvas.style.visibility = "hidden";
  canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
  delete canvas.dataset.velocastVideoPts;
  if (empty) {
    canvas.width = 0;
    canvas.height = 0;
    canvas.style.display = "none";
  }
}

/** Frame-synchronous canvas video; no HTML media element or asynchronous React state. */
export function VideoClip({
  src,
  muted,
  trimBeforeFrames = 0,
  trimAfterFrames,
  className,
  style,
}: VideoClipProps) {
  const getFrame = useContext(VideoContext),
    localFrame = useCurrentFrame(),
    { fps } = useVideoConfig();
  const ref = useRef<HTMLCanvasElement>(null);
  if (!getFrame)
    throw new Error(
      "VELOCAST_VIDEO_PROVIDER_MISSING: VideoClip requires VideoFrameProvider",
    );
  if (typeof src !== "string" || !src.trim())
    throw new Error(
      "VELOCAST_VIDEO_INVALID_SOURCE: src must be a nonempty string",
    );
  if (muted !== true)
    throw new Error(
      "VELOCAST_VIDEO_AUDIO_UNSUPPORTED: explicitly set muted=true; clip audio is not enabled",
    );
  boundary(trimBeforeFrames, "trimBeforeFrames");
  if (trimAfterFrames !== undefined) {
    boundary(trimAfterFrames, "trimAfterFrames");
    if (trimAfterFrames < trimBeforeFrames)
      throw new Error(
        "VELOCAST_VIDEO_INVALID_TRIM: trimAfterFrames precedes trimBeforeFrames",
      );
  }
  const sourceFrame = localFrame + trimBeforeFrames;
  if (!Number.isSafeInteger(sourceFrame))
    throw new Error(
      "VELOCAST_VIDEO_INVALID_TRIM: source frame exceeds safe integer range",
    );
  const active =
    localFrame >= 0 &&
    (trimAfterFrames === undefined || sourceFrame < trimAfterFrames);
  const sourceSeconds = active ? framesToSeconds(sourceFrame, fps) : 0;
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (canvas) clearCanvas(canvas, !active);
    return () => {
      if (canvas) clearCanvas(canvas, true);
    };
  });
  useFrameResource(async (signal) => {
    const canvas = ref.current;
    if (!canvas || !active) return;
    signal.throwIfAborted();
    const frame = await getFrame(src, sourceSeconds, signal);
    signal.throwIfAborted();
    if (ref.current !== canvas || !canvas.isConnected)
      throw new Error(
        "VELOCAST_VIDEO_DETACHED: canvas was removed before its frame was ready",
      );
    validateFrame(frame);
    const context = canvas.getContext("2d");
    if (!context)
      throw new Error(
        "VELOCAST_VIDEO_CANVAS_UNAVAILABLE: 2D canvas context is unavailable",
      );
    canvas.width = frame.width;
    canvas.height = frame.height;
    const pixels = context.createImageData(frame.width, frame.height);
    pixels.data.set(
      new Uint8Array(
        frame.rgba.buffer,
        frame.rgba.byteOffset,
        frame.rgba.byteLength,
      ),
    );
    signal.throwIfAborted();
    context.putImageData(pixels, 0, 0);
    canvas.dataset.velocastVideoPts = String(frame.pts);
    canvas.style.display = style?.display ?? "";
    canvas.style.visibility = style?.visibility ?? "";
  });
  return (
    <canvas
      ref={ref}
      className={className}
      style={style}
      data-velocast-video-src={src}
    />
  );
}

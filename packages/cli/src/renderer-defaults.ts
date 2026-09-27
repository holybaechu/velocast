import type { RendererAcceleration } from "@velocast/core";

export const defaultRendererAcceleration: RendererAcceleration = "auto";

export function defaultRendererPixelFormat(
  acceleration: RendererAcceleration,
): string {
  // Auto prioritizes the GPU-compatible path; explicit formats remain binding.
  return acceleration === "off" ? "yuv444p" : "nv12";
}

import type { RendererAcceleration } from "@velocast/core";

export const defaultRendererAcceleration: RendererAcceleration = "auto";

export function defaultRendererPixelFormat(
  acceleration: RendererAcceleration,
  codec?: string,
): string {
  void acceleration;
  return codec === "prores" ? "yuv422p10le" : "yuv420p";
}

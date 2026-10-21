import type { RendererAcceleration } from "@velocast/core";

export const defaultRendererAcceleration: RendererAcceleration = "auto";

export function defaultRendererPixelFormat(
  acceleration: RendererAcceleration,
  codec?: string,
): string {
  void acceleration;
  void codec;
  return "yuv420p";
}

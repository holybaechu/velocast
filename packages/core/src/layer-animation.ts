import { Easing } from "./easing.js";
import { interpolate } from "./interpolation.js";

export const LAYER_ANIMATION_PROPERTIES = [
  "x",
  "y",
  "width",
  "height",
  "rotation",
  "opacity",
] as const;
export type LayerAnimatedProperty = (typeof LAYER_ANIMATION_PROPERTIES)[number];
export const LAYER_ANIMATION_EASINGS = [
  "linear",
  "easeIn",
  "easeOut",
  "easeInOut",
] as const;
export interface LayerKeyframe {
  readonly frame: number;
  readonly value: number;
}
export interface LayerAnimationTrack {
  readonly keyframes: readonly LayerKeyframe[];
  readonly easing?: (typeof LAYER_ANIMATION_EASINGS)[number];
}
export type LayerAnimation = Partial<
  Record<LayerAnimatedProperty, LayerAnimationTrack | null>
>;
const easings = {
  linear: Easing.linear,
  easeIn: Easing.ease,
  easeOut: Easing.out(Easing.ease),
  easeInOut: Easing.inOut(Easing.ease),
};

/** The same bounded numeric contract is used by source edits and frame authoring. */
export function validateLayerAnimationTrack(
  property: string,
  value: unknown,
): LayerAnimationTrack {
  const invalid = (): never => {
    throw new Error(
      `VELOCAST_LAYER_ANIMATION: ${property} needs 2–128 increasing nonnegative integer-frame keyframes, valid numeric values and a supported easing`,
    );
  };
  if (
    !LAYER_ANIMATION_PROPERTIES.includes(property as LayerAnimatedProperty) ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    return invalid();
  const track = value as Record<string, unknown>;
  if (
    Object.keys(track).some((key) => !["keyframes", "easing"].includes(key)) ||
    (track.easing !== undefined &&
      !LAYER_ANIMATION_EASINGS.includes(
        track.easing as LayerAnimationTrack["easing"] & string,
      )) ||
    !Array.isArray(track.keyframes) ||
    track.keyframes.length < 2 ||
    track.keyframes.length > 128
  )
    return invalid();
  let previous = -1;
  const keyframes = track.keyframes.map((keyframe: unknown) => {
    if (!keyframe || typeof keyframe !== "object" || Array.isArray(keyframe))
      return invalid();
    const point = keyframe as Record<string, unknown>;
    if (
      Object.keys(point).some((key) => !["frame", "value"].includes(key)) ||
      typeof point.frame !== "number" ||
      !Number.isSafeInteger(point.frame) ||
      point.frame < 0 ||
      point.frame <= previous ||
      typeof point.value !== "number" ||
      !Number.isFinite(point.value) ||
      (["width", "height", "opacity"].includes(property) && point.value < 0) ||
      (property === "opacity" && point.value > 1)
    )
      return invalid();
    previous = point.frame;
    return { frame: point.frame, value: point.value };
  });
  return {
    keyframes,
    ...(track.easing === undefined
      ? {}
      : { easing: track.easing as LayerAnimationTrack["easing"] }),
  };
}

export function evaluateLayerAnimation(
  animation: LayerAnimation | undefined,
  frame: number,
): Partial<Record<LayerAnimatedProperty, number>> {
  if (animation === undefined) return {};
  if (!animation || typeof animation !== "object" || Array.isArray(animation))
    throw new Error(
      "VELOCAST_LAYER_ANIMATION: animation must be an object of numeric tracks",
    );
  for (const property of Object.keys(animation))
    if (!LAYER_ANIMATION_PROPERTIES.includes(property as LayerAnimatedProperty))
      throw new Error(
        `VELOCAST_LAYER_ANIMATION: unsupported property ${property}`,
      );
  return Object.fromEntries(
    Object.entries(animation)
      .filter(([, value]) => value != null)
      .map(([property, value]) => {
        const track = validateLayerAnimationTrack(property, value);
        return [
          property,
          interpolate(
            frame,
            track.keyframes.map((point) => point.frame),
            track.keyframes.map((point) => point.value),
            {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: easings[track.easing ?? "linear"],
            },
          ),
        ];
      }),
  );
}

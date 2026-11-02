import { useContext, type CSSProperties, type ReactNode } from "react";
import { SequenceContext, useVideoConfig } from "./frame-state.js";
import { Sequence } from "./sequence.js";

export interface LayerProps {
  readonly id: string;
  readonly name?: string;
  /** Start relative to the parent frame scope. */
  readonly from?: number;
  /** Omitted extends to the parent scope's end; zero is an empty interval. */
  readonly durationFrames?: number;
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
  readonly rotation?: number;
  readonly opacity?: number;
  /** Applied last. Computed styles and ordinary React children remain authored code. */
  readonly style?: CSSProperties;
  readonly children?: ReactNode;
}

/** A source-editable identity and frame scope around ordinary React content. */
export function Layer({
  id,
  name,
  from = 0,
  durationFrames,
  x = 0,
  y = 0,
  width,
  height,
  rotation = 0,
  opacity = 1,
  style,
  children,
}: LayerProps) {
  const ancestors = useContext(SequenceContext);
  const config = useVideoConfig();
  if (typeof id !== "string" || !id.trim())
    invalid("id", "must be a nonempty stable string");
  if (name !== undefined && typeof name !== "string")
    invalid("name", "must be a string");
  if (!Number.isSafeInteger(from)) invalid("from", "must be a safe integer");
  for (const [field, value] of Object.entries({
    x,
    y,
    rotation,
    opacity,
    width,
    height,
  })) {
    if (value === undefined && (field === "width" || field === "height"))
      continue;
    if (typeof value !== "number" || !Number.isFinite(value))
      invalid(field, "must be finite");
    if ((field === "width" || field === "height") && value < 0)
      invalid(field, "must be nonnegative");
  }
  if (opacity < 0 || opacity > 1)
    invalid("opacity", "must be between zero and one");
  const parentDuration =
    ancestors.at(-1)?.durationFrames ?? config.durationFrames;
  const duration = durationFrames ?? Math.max(0, parentDuration - from);
  if (
    !Number.isSafeInteger(duration) ||
    duration < 0 ||
    !Number.isSafeInteger(from + duration)
  )
    invalid(
      "durationFrames",
      "must be a nonnegative safe integer with a safe end frame",
    );
  return (
    <Sequence from={from} durationFrames={duration}>
      <div
        data-velocast-layer={id}
        data-velocast-layer-name={name}
        style={{
          position: "absolute",
          left: x,
          top: y,
          width,
          height,
          transform: `rotate(${rotation}deg)`,
          opacity,
          ...style,
        }}
      >
        {children}
      </div>
    </Sequence>
  );
}

function invalid(field: string, reason: string): never {
  throw new Error(`VELOCAST_LAYER_INVALID: ${field} ${reason}`);
}

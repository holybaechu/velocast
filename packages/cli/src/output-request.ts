import { createFrameRange } from "@velocast/core";
import type { RendererCapabilitySupport } from "./renderer-capabilities.js";
import {
  OUTPUT_API_VERSION,
  type OutputFrameRange,
} from "./generated/renderer-contracts.js";
export { OUTPUT_API_VERSION } from "./generated/renderer-contracts.js";

export function parseOutputFrame(value: unknown): number {
  const number =
    typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number < 0 ||
    number > 0xffff_ffff
  )
    throw new Error(
      "output.invalid_frame: frame must be an exact nonnegative u32 integer",
    );
  return number;
}

export function parseOutputRange(
  start: unknown,
  end: unknown,
): OutputFrameRange | undefined {
  if (start === undefined && end === undefined) return;
  if (start === undefined || end === undefined)
    throw new Error(
      "output.invalid_range: --start-frame and --end-frame must be supplied together",
    );
  let range;
  try {
    range = createFrameRange(parseOutputFrame(start), parseOutputFrame(end));
  } catch (error) {
    throw new Error(
      `output.invalid_range: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (range.start === range.end)
    throw new Error("output.invalid_range: output range must not be empty");
  return { startFrame: range.start, endFrame: range.end };
}

export function requireOutputApi(
  capabilities: RendererCapabilitySupport,
): void {
  if (
    !capabilities.available ||
    capabilities.outputApiVersion !== OUTPUT_API_VERSION
  )
    throw new Error(
      `output.native_incompatible: native renderer must support output API ${OUTPUT_API_VERSION}${capabilities.reason ? `: ${capabilities.reason}` : ""}`,
    );
}

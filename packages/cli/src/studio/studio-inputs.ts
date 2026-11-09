import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isObjectRecord } from "../internal/validation.js";

export const MAX_STUDIO_INPUT_BYTES = 1024 * 1024;

export class StudioInputsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Read external composition inputs; source editors own changes to this file. */
export async function readStudioInputs(path: string | undefined) {
  if (!path) return { enabled: false as const };
  const file = await lstat(path);
  if (!file.isFile())
    throw new StudioInputsError(
      400,
      "studio.invalid_inputs",
      "Saved inputs must remain a regular file",
    );
  if (file.size > MAX_STUDIO_INPUT_BYTES)
    throw new StudioInputsError(
      413,
      "studio.inputs_limit",
      "Saved inputs exceed 1 MiB",
    );
  const bytes = await readFile(path);
  if (bytes.length > MAX_STUDIO_INPUT_BYTES)
    throw new StudioInputsError(
      413,
      "studio.inputs_limit",
      "Saved inputs exceed 1 MiB",
    );
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
  } catch {
    throw new StudioInputsError(
      400,
      "studio.invalid_inputs",
      "Saved inputs must contain a JSON object",
    );
  }
  if (!isObjectRecord(value))
    throw new StudioInputsError(
      400,
      "studio.invalid_inputs",
      "Saved inputs must contain a JSON object",
    );
  return {
    enabled: true as const,
    path,
    revision: createHash("sha256").update(bytes).digest("hex"),
    inputProps: value,
  };
}

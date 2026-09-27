import {
  isObjectRecord,
  isPositiveSafeInteger,
  optionalNonEmptyString,
  optionalPositiveSafeInteger,
} from "./internal/validation.js";
import type { CompositionDefinition, CompositionManifest } from "./types.js";

export type CompositionMetadata = Omit<CompositionDefinition, "durationFrames">;

export function validateComposition(
  id: string,
  definition: CompositionDefinition,
): CompositionManifest {
  const metadata = validateCompositionMetadata(id, definition);
  if (!isPositiveSafeInteger(definition.durationFrames)) {
    throw new Error(
      `composition ${id} durationFrames must be a positive integer`,
    );
  }
  return { id, ...metadata, durationFrames: definition.durationFrames };
}

/** Shared authoring rules; duration is supplied by the frame adapter at runtime. */
export function validateCompositionMetadata(
  id: string,
  definition: CompositionMetadata,
): CompositionMetadata {
  validateCompositionId(id);
  validateCompositionDefinition(id, definition);

  for (const key of ["width", "height", "fps"] as const) {
    const value = definition[key];
    if (!isPositiveSafeInteger(value)) {
      throw new Error(`composition ${id} ${key} must be a positive integer`);
    }
  }

  const target = optionalNonEmptyString(
    `composition ${id}`,
    "target",
    definition.target,
  );
  const url = optionalNonEmptyString(
    `composition ${id}`,
    "url",
    definition.url,
  );
  const maxConcurrency = optionalPositiveSafeInteger(
    `composition ${id}`,
    "maxConcurrency",
    definition.maxConcurrency,
  );

  if (!target && !url) {
    throw new Error(`composition ${id} must define target or url`);
  }

  return {
    width: definition.width,
    height: definition.height,
    fps: definition.fps,
    target,
    url,
    maxConcurrency,
  };
}

function validateCompositionId(id: unknown): asserts id is string {
  if (typeof id !== "string") {
    throw new Error("composition id must be a string");
  }

  if (!id.trim()) {
    throw new Error("composition id must not be empty");
  }
}

function validateCompositionDefinition(
  id: string,
  definition: unknown,
): asserts definition is CompositionDefinition {
  if (!isObjectRecord(definition)) {
    throw new Error(`composition ${id} definition must be an object`);
  }
}

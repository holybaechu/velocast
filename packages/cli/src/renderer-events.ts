import { isObjectRecord } from "./internal/validation.js";

export {
  RENDERER_BACKEND_DIAGNOSTIC_CODES,
  RENDERER_EVENT_FIELD_CONTRACTS,
  RENDERER_EVENT_NAMES,
  type RendererBackendDiagnosticCode,
  type RendererEventName,
} from "./generated/renderer-contracts.js";

import {
  validateRendererEvent,
  type RendererEvent,
  type RendererFailedEvent,
  type RendererFinishedEvent,
} from "./generated/renderer-contracts.js";
export type {
  RendererEvent,
  RendererStartedEvent,
  PipelinePlanResolvedEvent,
  FrameRenderedEvent,
  FrameEncodedEvent,
  RendererFinishedEvent,
  RendererFailedEvent,
  UnknownRendererEvent,
} from "./generated/renderer-contracts.js";

export function parseRendererEventLog(text: string): RendererEvent[] {
  const events: RendererEvent[] = [];
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) {
      continue;
    }

    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(
        `renderer event log line ${index + 1} is not valid JSON: ${errorMessage(error)}`,
        { cause: error },
      );
    }

    if (!isObjectRecord(value) || typeof value.event !== "string") {
      throw new Error(
        `renderer event log line ${index + 1} is missing an event string`,
      );
    }
    try {
      validateRendererEvent(value);
    } catch (error) {
      throw new Error(
        `renderer event log line ${index + 1}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    events.push(value);
  }
  return events;
}

export function extractRendererEventFailure(
  events: readonly RendererEvent[],
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (isRendererFailedEvent(event) && event.error.trim()) {
      return event.error.trim();
    }
  }
  return undefined;
}

export function extractRendererEventSuccessWarning(
  events: readonly RendererEvent[],
): string | undefined {
  const finished = lastRendererFinishedEvent(events);
  if (!finished) {
    return undefined;
  }

  const cpuReadbackFrames = finished.cpu_readback_frames;
  if (
    typeof cpuReadbackFrames === "number" &&
    Number.isInteger(cpuReadbackFrames) &&
    cpuReadbackFrames > 0
  ) {
    return `renderer completed using CPU readback for ${cpuReadbackFrames} frame(s)`;
  }

  if (finished.fallback_used) {
    const reason =
      typeof finished.fallback_reason === "string" &&
      finished.fallback_reason.trim()
        ? `: ${finished.fallback_reason.trim()}`
        : "";
    return `renderer completed using fallback path${reason}`;
  }

  return undefined;
}

function lastRendererFinishedEvent(
  events: readonly RendererEvent[],
): RendererFinishedEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (isRendererFinishedEvent(event)) {
      return event;
    }
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRendererFailedEvent(
  value: RendererEvent | undefined,
): value is RendererFailedEvent {
  return (
    isObjectRecord(value) &&
    value.event === "renderer_failed" &&
    typeof value.error === "string"
  );
}

function isRendererFinishedEvent(
  value: RendererEvent | undefined,
): value is RendererFinishedEvent {
  return (
    isObjectRecord(value) &&
    value.event === "renderer_finished" &&
    typeof value.frames_rendered === "number" &&
    typeof value.frames_encoded === "number" &&
    typeof value.fallback_used === "boolean"
  );
}

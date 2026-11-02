import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { StudioClient, StudioClientCommand } from "@velocast/core";

const id = z.string().min(1).max(256);
const frame = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const stateSchema = z.strictObject({
  revision: frame,
  sourceVersion: z.string().max(256),
  compositions: z
    .array(
      z.object({
        id,
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        fps: z.number().positive(),
        durationFrames: z.number().int().positive(),
      }),
    )
    .max(512),
  compositionId: id.optional(),
  frame: frame.optional(),
  selectedElementId: id.optional(),
  sourceRevision: id.optional(),
  dirty: z.boolean(),
  ready: z.boolean(),
  exportReady: z.boolean(),
  playing: z.boolean(),
  error: z.string().max(4000).optional(),
});
const heartbeatSchema = z.strictObject({
  state: stateSchema,
  acknowledgements: z
    .array(
      z.strictObject({
        id,
        status: z.enum(["succeeded", "failed"]),
        error: z.string().max(4000).optional(),
      }),
    )
    .max(16)
    .optional(),
});
const guard = {
  clientId: id,
  expectedRevision: frame,
  expectedSourceVersion: id,
};
const controlSchema = z.discriminatedUnion("action", [
  z.strictObject({ ...guard, action: z.literal("play") }),
  z.strictObject({ ...guard, action: z.literal("pause") }),
  z.strictObject({ ...guard, action: z.literal("seek"), frame }),
  z.strictObject({ ...guard, action: z.literal("select"), elementId: id }),
  z.strictObject({
    ...guard,
    action: z.literal("composition"),
    compositionId: id,
  }),
]);

export class StudioClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface ClientEntry {
  client: StudioClient;
  stateJson: string;
  seenAt: number;
  pending?: {
    command: StudioClientCommand;
    finish(error?: StudioClientError): void;
  };
}

/** Browser presence and acknowledged control; never infers a target tab. */
export class StudioClients {
  private readonly entries = new Map<string, ClientEntry>();
  private closed = false;

  list(): StudioClient[] {
    for (const [key, entry] of this.entries) {
      if (Date.now() - entry.seenAt > 30_000) this.disconnect(key);
    }
    return [...this.entries.values()].map(({ client }) =>
      structuredClone(client),
    );
  }

  heartbeat(
    clientId: string,
    value: unknown,
  ): { commands: StudioClientCommand[] } {
    if (this.closed)
      throw new StudioClientError(503, "studio.client_closed", "Studio closed");
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(clientId))
      throw new StudioClientError(
        400,
        "studio.client_id",
        "Invalid browser client ID",
      );
    const parsed = heartbeatSchema.safeParse(value);
    if (!parsed.success)
      throw new StudioClientError(
        400,
        "studio.client_state",
        parsed.error.message,
      );
    const { state, acknowledgements } = parsed.data;
    const composition = state.compositions.find(
      (item) => item.id === state.compositionId,
    );
    if (
      new Set(state.compositions.map((item) => item.id)).size !==
        state.compositions.length ||
      (state.compositionId !== undefined && !composition) ||
      (state.frame !== undefined &&
        (!composition || state.frame >= composition.durationFrames)) ||
      (state.ready &&
        (!state.sourceVersion || !composition || state.frame === undefined)) ||
      (state.exportReady && (!state.ready || state.dirty))
    )
      throw new StudioClientError(
        400,
        "studio.client_state",
        "Browser state has inconsistent composition, frame or readiness",
      );
    this.list();
    let entry = this.entries.get(clientId);
    const stateJson = JSON.stringify(state);
    if (
      entry &&
      (state.revision < entry.client.revision ||
        (state.revision === entry.client.revision &&
          stateJson !== entry.stateJson))
    )
      throw new StudioClientError(
        409,
        "studio.client_stale",
        "Browser state changed without a new revision",
      );
    if (!entry) {
      if (this.entries.size >= 32)
        throw new StudioClientError(
          429,
          "studio.client_limit",
          "Close an unused Studio tab before attaching another",
        );
      entry = {
        client: { ...state, clientId, updatedAt: new Date().toISOString() },
        stateJson,
        seenAt: Date.now(),
      };
      this.entries.set(clientId, entry);
    } else {
      entry.client = {
        ...state,
        clientId,
        updatedAt: new Date().toISOString(),
      };
      entry.stateJson = stateJson;
      entry.seenAt = Date.now();
    }
    for (const acknowledgement of acknowledgements ?? []) {
      if (entry.pending?.command.id === acknowledgement.id) {
        entry.pending.finish(
          acknowledgement.status === "failed"
            ? new StudioClientError(
                409,
                "studio.client_command_failed",
                acknowledgement.error ?? "Browser rejected the command",
              )
            : undefined,
        );
      }
    }
    return {
      commands: entry.pending ? [structuredClone(entry.pending.command)] : [],
    };
  }

  async control(value: unknown, signal?: AbortSignal): Promise<StudioClient> {
    if (this.closed)
      throw new StudioClientError(503, "studio.client_closed", "Studio closed");
    const parsed = controlSchema.safeParse(value);
    if (!parsed.success)
      throw new StudioClientError(
        400,
        "studio.client_command",
        parsed.error.message,
      );
    const { clientId, ...request } = parsed.data;
    this.list();
    const entry = this.entries.get(clientId);
    if (!entry)
      throw new StudioClientError(
        409,
        "studio.client_disconnected",
        "Open Studio in a browser and read its current client ID",
      );
    if (
      (request.action !== "pause" &&
        entry.client.revision !== request.expectedRevision) ||
      entry.client.sourceVersion !== request.expectedSourceVersion
    )
      throw new StudioClientError(
        409,
        "studio.client_stale",
        "Browser selection or source changed; read its current context before retrying",
      );
    if (entry.pending)
      throw new StudioClientError(
        409,
        "studio.client_busy",
        "A command is waiting for this browser",
      );
    if (request.action === "seek") {
      const composition = entry.client.compositions.find(
        (item) => item.id === entry.client.compositionId,
      );
      if (!composition || request.frame >= composition.durationFrames)
        throw new StudioClientError(
          400,
          "studio.client_frame",
          "Frame is outside the current composition",
        );
    }
    if (
      request.action === "composition" &&
      !entry.client.compositions.some(
        (item) => item.id === request.compositionId,
      )
    )
      throw new StudioClientError(
        400,
        "studio.client_composition",
        "Composition is not available in this browser",
      );
    signal?.throwIfAborted();
    return new Promise<StudioClient>((resolve, reject) => {
      const abort = () =>
        finish(
          new StudioClientError(
            409,
            "studio.client_cancelled",
            "Browser command cancelled",
          ),
        );
      const timer = setTimeout(
        () =>
          finish(
            new StudioClientError(
              408,
              "studio.client_timeout",
              "Browser did not acknowledge the command; read context before retrying",
            ),
          ),
        8_000,
      );
      const finish = (error?: StudioClientError) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        entry.pending = undefined;
        if (error) reject(error);
        else resolve(structuredClone(entry.client));
      };
      entry.pending = { command: { ...request, id: randomUUID() }, finish };
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  disconnect(clientId: string): void {
    const entry = this.entries.get(clientId);
    entry?.pending?.finish(
      new StudioClientError(
        409,
        "studio.client_disconnected",
        "Studio browser disconnected",
      ),
    );
    this.entries.delete(clientId);
  }

  close(): void {
    this.closed = true;
    for (const entry of this.entries.values())
      entry.pending?.finish(
        new StudioClientError(503, "studio.client_closed", "Studio closed"),
      );
    this.entries.clear();
  }
}

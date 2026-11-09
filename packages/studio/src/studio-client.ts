import type {
  StudioClientAcknowledgement,
  StudioClientCommand,
  StudioClientState,
  StudioHeartbeat,
  StudioElementInspection,
} from "@velocast/core";

interface ClientApi {
  heartbeat(
    clientId: string,
    heartbeat: StudioHeartbeat,
    signal?: AbortSignal,
  ): Promise<{ commands: StudioClientCommand[] }>;
  disconnect(clientId: string, signal?: AbortSignal): Promise<void>;
}

/** Owns one browser's presence and serial command delivery, independent of playback. */
export class StudioClientConnection {
  readonly clientId = crypto.randomUUID();
  private readonly lifetime = new AbortController();
  private readonly completed = new Map<string, StudioClientAcknowledgement>();
  private pending: StudioClientAcknowledgement[] = [];
  private revision = 0;
  private fingerprint = "";
  private timer?: ReturnType<typeof setTimeout>;
  private work?: Promise<void>;
  private started = false;

  constructor(
    private readonly options: {
      api: ClientApi;
      getState(): Omit<StudioClientState, "revision">;
      control(
        command: StudioClientCommand,
      ): Promise<StudioElementInspection | void>;
      status?(connected: boolean, error?: string): void;
    },
  ) {}

  start(): void {
    if (this.started || this.lifetime.signal.aborted) return;
    this.started = true;
    this.schedule(0);
  }

  changed(): StudioClientState {
    const state = this.options.getState();
    const fingerprint = JSON.stringify(state);
    if (fingerprint !== this.fingerprint) {
      this.fingerprint = fingerprint;
      this.revision++;
    }
    return { ...state, revision: this.revision };
  }

  async dispose(): Promise<void> {
    this.lifetime.abort();
    clearTimeout(this.timer);
    await this.work;
    if (!this.started) return;
    try {
      await this.options.api.disconnect(
        this.clientId,
        AbortSignal.timeout(3000),
      );
    } catch {
      // The server expires this client if the browser cannot deliver disconnect.
    }
  }

  private schedule(delay: number): void {
    if (this.lifetime.signal.aborted) return;
    this.timer = setTimeout(() => {
      this.work = this.poll();
    }, delay);
  }

  private async poll(): Promise<void> {
    let delay = 1000;
    const acknowledgements = this.pending;
    try {
      const { commands } = await this.options.api.heartbeat(
        this.clientId,
        {
          state: this.changed(),
          ...(acknowledgements.length ? { acknowledgements } : {}),
        },
        this.lifetime.signal,
      );
      this.lifetime.signal.throwIfAborted();
      this.pending = [];
      this.options.status?.(true);
      for (const command of commands) {
        const prior = this.completed.get(command.id);
        if (prior) {
          this.pending.push(prior);
          continue;
        }
        let acknowledgement: StudioClientAcknowledgement;
        try {
          const state = this.changed();
          if (
            (command.action !== "pause" &&
              command.expectedRevision !== state.revision) ||
            command.expectedSourceVersion !== state.sourceVersion
          )
            throw new Error(
              "studio.client_conflict: This tab changed. Read its current state and retry.",
            );
          const inspection = await this.options.control(command);
          acknowledgement = {
            id: command.id,
            status: "succeeded",
            ...(inspection ? { inspection } : {}),
          };
        } catch (error) {
          acknowledgement = {
            id: command.id,
            status: "failed",
            error: (error instanceof Error
              ? error.message
              : String(error)
            ).slice(0, 4000),
          };
        }
        this.completed.set(command.id, acknowledgement);
        if (this.completed.size > 64)
          this.completed.delete(this.completed.keys().next().value!);
        this.pending.push(acknowledgement);
      }
      if (this.pending.length) delay = 0;
    } catch (error) {
      if (!this.lifetime.signal.aborted)
        this.options.status?.(
          false,
          (error instanceof Error ? error.message : String(error)).slice(
            0,
            400,
          ),
        );
    } finally {
      this.schedule(delay);
    }
  }
}

export type AdapterKind = "built-in" | "custom";
export type ProtocolPolicy = "required" | "bypassed";
export type SettlementStatus = "fulfilled" | "rejected";

export type ProcessDisposition =
  | Readonly<{ status: "unknown" }>
  | Readonly<{ status: "running" }>
  | Readonly<{
      status: "exited";
      code: number | null;
      signal: NodeJS.Signals | null;
    }>;

export type AdapterSettlement = Readonly<{
  adapter: AdapterKind;
  protocol: ProtocolPolicy;
  status: SettlementStatus;
  result?: unknown;
  error?: unknown;
  process: ProcessDisposition;
  protocolCompletionExpected: boolean;
  terminationPolicy: "forbidden";
}>;

export function createAdapterSettlement(
  input: Readonly<{
    adapter: AdapterKind;
    protocol: ProtocolPolicy;
    status: SettlementStatus;
    result?: unknown;
    error?: unknown;
    process?: ProcessDisposition;
  }>,
): AdapterSettlement {
  const process = Object.freeze({
    ...(input.process ?? { status: "unknown" }),
  });
  return Object.freeze({
    adapter: input.adapter,
    protocol: input.protocol,
    status: input.status,
    ...(input.status === "fulfilled" ? { result: input.result } : {}),
    ...(input.status === "rejected" ? { error: input.error } : {}),
    process,
    protocolCompletionExpected: input.protocol === "required",
    terminationPolicy: "forbidden",
  });
}

export type ProtocolResult = Readonly<
  | { status: "fulfilled"; result?: unknown }
  | { status: "rejected"; error: unknown }
>;

export type TerminationCause = "abort" | "timeout" | "escalation";

export type LifecycleOutcome = Readonly<
  | {
      status: "fulfilled";
      source: "adapter" | "protocol";
      result?: unknown;
      diagnostics: readonly unknown[];
    }
  | {
      status: "rejected";
      source: "adapter" | "protocol" | "startup" | TerminationCause;
      error: unknown;
      diagnostics: readonly unknown[];
    }
>;

export type LifecycleEvent =
  | Readonly<{ type: "adapter-settled"; settlement: AdapterSettlement }>
  | Readonly<{ type: "startup-failed"; error: unknown }>
  | Readonly<{ type: "protocol-result"; result: ProtocolResult }>
  | Readonly<{
      type: "process-exit";
      disposition: Extract<ProcessDisposition, { status: "exited" }>;
    }>
  | Readonly<{ type: "abort"; error: unknown }>
  | Readonly<{ type: "timeout"; error: unknown }>
  | Readonly<{ type: "escalation"; error: unknown }>
  | Readonly<{ type: "termination-complete"; error?: unknown }>
  | Readonly<{ type: "cleanup-complete"; error?: unknown }>;

export type LifecycleEffect =
  | Readonly<{ type: "drain-protocol" }>
  | Readonly<{ type: "stop-protocol-drain" }>
  | Readonly<{ type: "terminate-process"; cause: TerminationCause }>
  | Readonly<{ type: "cleanup" }>
  | Readonly<{ type: "finalize"; outcome: LifecycleOutcome }>
  | Readonly<{ type: "diagnostic"; message: string }>;

type PrimaryOutcome =
  | Readonly<{
      status: "fulfilled";
      source: "adapter" | "protocol";
      result?: unknown;
    }>
  | Readonly<{
      status: "rejected";
      source: "adapter" | "protocol" | "startup" | TerminationCause;
      error: unknown;
    }>;

export interface RendererLifecycleState {
  readonly finalized: boolean;
  readonly settlement?: AdapterSettlement;
  readonly protocolResult?: ProtocolResult;
  readonly process: ProcessDisposition;
  readonly protocolDrain: "undecided" | "requested" | "stopped";
  readonly primaryOutcome?: PrimaryOutcome;
  readonly terminationCause?: TerminationCause;
  readonly terminationCompleted: boolean;
  readonly cleanupRequested: boolean;
  readonly cleanupCompleted: boolean;
  readonly diagnostics: readonly unknown[];
}

export function createRendererLifecycleState(): RendererLifecycleState {
  return {
    finalized: false,
    process: Object.freeze({ status: "unknown" }),
    protocolDrain: "undecided",
    terminationCompleted: false,
    cleanupRequested: false,
    cleanupCompleted: false,
    diagnostics: [],
  };
}

export function reduceRendererLifecycle(
  state: RendererLifecycleState,
  event: LifecycleEvent,
): Readonly<{
  state: RendererLifecycleState;
  effects: readonly LifecycleEffect[];
}> {
  if (state.finalized) {
    return {
      state,
      effects: [
        {
          type: "diagnostic",
          message: `ignored ${event.type} after lifecycle finalization`,
        },
      ],
    };
  }

  let next = state;
  const effects: LifecycleEffect[] = [];

  switch (event.type) {
    case "startup-failed": {
      if (state.primaryOutcome === undefined) {
        next = {
          ...state,
          primaryOutcome: {
            status: "rejected",
            source: "startup",
            error: event.error,
          },
        };
        next = stopProtocolDrain(next, effects);
      }
      break;
    }
    case "adapter-settled": {
      if (state.settlement !== undefined) {
        effects.push({
          type: "diagnostic",
          message: "ignored duplicate adapter settlement",
        });
        break;
      }
      next = {
        ...state,
        settlement: event.settlement,
        process:
          event.settlement.process.status === "unknown"
            ? state.process
            : event.settlement.process,
      };
      if (event.settlement.protocol === "bypassed") {
        next = stopProtocolDrain(next, effects);
        if (next.primaryOutcome === undefined) {
          next = withAdapterOutcome(next, event.settlement);
        }
      } else if (next.protocolResult !== undefined) {
        next = withRequiredOutcome(next, event.settlement, next.protocolResult);
      } else if (
        next.primaryOutcome === undefined &&
        next.protocolDrain === "undecided"
      ) {
        next = { ...next, protocolDrain: "requested" };
        effects.push({ type: "drain-protocol" });
      }
      break;
    }
    case "protocol-result": {
      if (state.protocolResult !== undefined) {
        effects.push({
          type: "diagnostic",
          message: "ignored duplicate protocol result",
        });
        break;
      }
      next = { ...state, protocolResult: event.result };
      if (state.settlement?.protocol === "required") {
        next = withRequiredOutcome(next, state.settlement, event.result);
      } else if (state.settlement?.protocol === "bypassed") {
        effects.push({
          type: "diagnostic",
          message: "ignored protocol result after protocol bypass",
        });
      }
      break;
    }
    case "process-exit": {
      if (state.process.status === "exited") {
        effects.push({
          type: "diagnostic",
          message: "ignored duplicate process exit",
        });
        break;
      }
      next = { ...state, process: Object.freeze({ ...event.disposition }) };
      break;
    }
    case "abort":
    case "timeout":
    case "escalation": {
      const cause = event.type;
      if (
        state.process.status === "exited" &&
        state.primaryOutcome === undefined
      ) {
        effects.push({
          type: "diagnostic",
          message: `ignored ${cause} after process exit`,
        });
        break;
      }
      if (state.primaryOutcome === undefined) {
        next = {
          ...state,
          primaryOutcome: {
            status: "rejected",
            source: cause,
            error: event.error,
          },
        };
        next = stopProtocolDrain(next, effects);
      }
      if (
        state.process.status !== "exited" &&
        state.terminationCause === undefined
      ) {
        next = { ...next, terminationCause: cause };
        effects.push({ type: "terminate-process", cause });
      }
      break;
    }
    case "termination-complete": {
      if (state.terminationCause === undefined || state.terminationCompleted) {
        effects.push({
          type: "diagnostic",
          message: "ignored unexpected termination completion",
        });
        break;
      }
      next = {
        ...state,
        terminationCompleted: true,
        diagnostics:
          event.error === undefined
            ? state.diagnostics
            : [...state.diagnostics, event.error],
      };
      break;
    }
    case "cleanup-complete": {
      if (!state.cleanupRequested || state.cleanupCompleted) {
        effects.push({
          type: "diagnostic",
          message: "ignored unexpected cleanup completion",
        });
        break;
      }
      next = {
        ...state,
        cleanupCompleted: true,
        diagnostics:
          event.error === undefined
            ? state.diagnostics
            : [...state.diagnostics, event.error],
      };
      break;
    }
  }

  if (next.primaryOutcome !== undefined && !next.cleanupRequested) {
    next = { ...next, cleanupRequested: true };
    effects.push({ type: "cleanup" });
  }

  const terminationDone =
    next.terminationCause === undefined || next.terminationCompleted;
  if (
    next.primaryOutcome !== undefined &&
    next.cleanupCompleted &&
    terminationDone &&
    !next.finalized
  ) {
    const outcome = Object.freeze({
      ...next.primaryOutcome,
      diagnostics: Object.freeze([...next.diagnostics]),
    }) as LifecycleOutcome;
    next = { ...next, finalized: true };
    effects.push({ type: "finalize", outcome });
  }

  return { state: next, effects };
}

function stopProtocolDrain(
  state: RendererLifecycleState,
  effects: LifecycleEffect[],
): RendererLifecycleState {
  if (state.protocolDrain === "stopped") {
    return state;
  }
  effects.push({ type: "stop-protocol-drain" });
  return { ...state, protocolDrain: "stopped" };
}

function withAdapterOutcome(
  state: RendererLifecycleState,
  settlement: AdapterSettlement,
): RendererLifecycleState {
  return {
    ...state,
    primaryOutcome:
      settlement.status === "fulfilled"
        ? { status: "fulfilled", source: "adapter", result: settlement.result }
        : { status: "rejected", source: "adapter", error: settlement.error },
  };
}

function withRequiredOutcome(
  state: RendererLifecycleState,
  settlement: AdapterSettlement,
  protocol: ProtocolResult,
): RendererLifecycleState {
  if (state.primaryOutcome !== undefined) {
    return state;
  }
  if (protocol.status === "rejected") {
    return {
      ...state,
      primaryOutcome: {
        status: "rejected",
        source: "protocol",
        error: protocol.error,
      },
    };
  }
  return withAdapterOutcome(state, settlement);
}

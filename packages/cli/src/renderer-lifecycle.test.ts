import { describe, expect, it } from "vitest";
import {
  createAdapterSettlement,
  createRendererLifecycleState,
  reduceRendererLifecycle,
  type AdapterKind,
  type LifecycleEffect,
  type LifecycleEvent,
  type ProtocolPolicy,
  type RendererLifecycleState,
  type SettlementStatus,
} from "./renderer-lifecycle.js";

const adapterError = new Error("adapter rejected");
const protocolError = new Error("protocol rejected");

describe("createAdapterSettlement", () => {
  it("freezes protocol and termination policy into the settlement", () => {
    const settlement = createAdapterSettlement({
      adapter: "custom",
      protocol: "bypassed",
      status: "rejected",
      error: adapterError,
      process: { status: "running" },
    });

    expect(settlement).toEqual({
      adapter: "custom",
      protocol: "bypassed",
      status: "rejected",
      error: adapterError,
      process: { status: "running" },
      protocolCompletionExpected: false,
      terminationPolicy: "forbidden",
    });
    expect(Object.isFrozen(settlement)).toBe(true);
    expect(Object.isFrozen(settlement.process)).toBe(true);
  });
});

describe("reduceRendererLifecycle", () => {
  const adapters: AdapterKind[] = ["built-in", "custom"];
  const protocols: ProtocolPolicy[] = ["required", "bypassed"];
  const statuses: SettlementStatus[] = ["fulfilled", "rejected"];

  for (const adapter of adapters) {
    for (const protocol of protocols) {
      for (const status of statuses) {
        it(`${adapter} ${status} with protocol ${protocol}`, () => {
          const settlement = createAdapterSettlement({
            adapter,
            protocol,
            status,
            result: "adapter result",
            error: adapterError,
            process: { status: "running" },
          });
          const first = reduceRendererLifecycle(
            createRendererLifecycleState(),
            {
              type: "adapter-settled",
              settlement,
            },
          );

          if (protocol === "bypassed") {
            expect(effectTypes(first.effects)).toEqual([
              "stop-protocol-drain",
              "cleanup",
            ]);
            expect(first.state.primaryOutcome?.status).toBe(status);
          } else {
            expect(effectTypes(first.effects)).toEqual(["drain-protocol"]);
            const afterProtocol = reduceRendererLifecycle(first.state, {
              type: "protocol-result",
              result: { status: "fulfilled", result: "protocol result" },
            });
            expect(effectTypes(afterProtocol.effects)).toEqual(["cleanup"]);
            expect(afterProtocol.state.primaryOutcome?.status).toBe(status);
          }
        });
      }
    }
  }

  it("routes startup failure through one cleanup and one finalization", () => {
    const startupError = new Error("spawn failed");
    const failed = reduceRendererLifecycle(createRendererLifecycleState(), {
      type: "startup-failed",
      error: startupError,
    });
    const cleaned = reduceRendererLifecycle(failed.state, {
      type: "cleanup-complete",
    });

    expect(effectTypes(failed.effects)).toEqual([
      "stop-protocol-drain",
      "cleanup",
    ]);
    expect(effectTypes(cleaned.effects)).toEqual(["finalize"]);
    expect(cleaned.effects).toContainEqual({
      type: "finalize",
      outcome: {
        status: "rejected",
        source: "startup",
        error: startupError,
        diagnostics: [],
      },
    });
  });

  it("makes protocol failure authoritative when protocol is required", () => {
    const beforeSettlement = reduceRendererLifecycle(
      createRendererLifecycleState(),
      {
        type: "protocol-result",
        result: { status: "rejected", error: protocolError },
      },
    );
    const afterSettlement = reduceRendererLifecycle(beforeSettlement.state, {
      type: "adapter-settled",
      settlement: rejectedSettlement("required"),
    });

    expect(afterSettlement.state.primaryOutcome).toMatchObject({
      status: "rejected",
      source: "protocol",
      error: protocolError,
    });
    expect(effectTypes(afterSettlement.effects)).toEqual(["cleanup"]);
  });

  it("atomically bypasses a pre-arrived protocol result", () => {
    const beforeSettlement = reduceRendererLifecycle(
      createRendererLifecycleState(),
      {
        type: "protocol-result",
        result: { status: "rejected", error: protocolError },
      },
    );
    const afterSettlement = reduceRendererLifecycle(beforeSettlement.state, {
      type: "adapter-settled",
      settlement: rejectedSettlement("bypassed"),
    });

    expect(afterSettlement.state.primaryOutcome).toMatchObject({
      status: "rejected",
      source: "adapter",
      error: adapterError,
    });
    expect(effectTypes(afterSettlement.effects)).toEqual([
      "stop-protocol-drain",
      "cleanup",
    ]);
  });

  it("lets abort before settlement terminate and remain decisive", () => {
    const abortError = new Error("aborted first");
    const afterAbort = reduceRendererLifecycle(createRendererLifecycleState(), {
      type: "abort",
      error: abortError,
    });
    const afterSettlement = reduceRendererLifecycle(afterAbort.state, {
      type: "adapter-settled",
      settlement: fulfilledSettlement("bypassed"),
    });

    expect(effectTypes(afterAbort.effects)).toEqual([
      "stop-protocol-drain",
      "terminate-process",
      "cleanup",
    ]);
    expect(afterSettlement.state.primaryOutcome).toMatchObject({
      status: "rejected",
      source: "abort",
      error: abortError,
    });
  });

  it.each(["abort", "timeout", "escalation"] as const)(
    "keeps protocol stopped when required settlement arrives after decisive %s",
    (type) => {
      const effects: LifecycleEffect[] = [];
      let reduced = reduceRendererLifecycle(createRendererLifecycleState(), {
        type,
        error: new Error(`${type} first`),
      });
      effects.push(...reduced.effects);
      reduced = reduceRendererLifecycle(reduced.state, {
        type: "adapter-settled",
        settlement: fulfilledSettlement("required"),
      });
      effects.push(...reduced.effects);
      reduced = reduceRendererLifecycle(reduced.state, {
        type: "termination-complete",
      });
      effects.push(...reduced.effects);
      reduced = reduceRendererLifecycle(reduced.state, {
        type: "cleanup-complete",
      });
      effects.push(...reduced.effects);

      expect(effectTypes(effects)).not.toContain("drain-protocol");
      expect(
        effectTypes(effects).filter((effect) => effect === "cleanup"),
      ).toHaveLength(1);
      expect(
        effectTypes(effects).filter((effect) => effect === "finalize"),
      ).toHaveLength(1);
      expect(reduced.state.finalized).toBe(true);
    },
  );

  it("does not let abort after settlement overwrite its outcome", () => {
    const afterSettlement = reduceRendererLifecycle(
      createRendererLifecycleState(),
      { type: "adapter-settled", settlement: rejectedSettlement("bypassed") },
    );
    const afterAbort = reduceRendererLifecycle(afterSettlement.state, {
      type: "abort",
      error: new Error("late abort"),
    });

    expect(afterAbort.state.primaryOutcome).toMatchObject({
      source: "adapter",
      error: adapterError,
    });
    expect(effectTypes(afterAbort.effects)).toEqual(["terminate-process"]);
  });

  it("lets process exit observed first suppress later abort termination", () => {
    const afterExit = reduceRendererLifecycle(createRendererLifecycleState(), {
      type: "process-exit",
      disposition: { status: "exited", code: 0, signal: null },
    });
    const afterAbort = reduceRendererLifecycle(afterExit.state, {
      type: "abort",
      error: new Error("late abort"),
    });
    const afterSettlement = reduceRendererLifecycle(afterAbort.state, {
      type: "adapter-settled",
      settlement: fulfilledSettlement("bypassed"),
    });

    expect(effectTypes(afterAbort.effects)).toEqual(["diagnostic"]);
    expect(afterSettlement.state.primaryOutcome).toMatchObject({
      status: "fulfilled",
      source: "adapter",
    });
  });

  it.each(["timeout", "escalation"] as const)(
    "permits explicit %s termination after bypass rejection without changing the error",
    (type) => {
      const afterSettlement = reduceRendererLifecycle(
        createRendererLifecycleState(),
        { type: "adapter-settled", settlement: rejectedSettlement("bypassed") },
      );
      const explicitError = new Error(type);
      const afterCause = reduceRendererLifecycle(afterSettlement.state, {
        type,
        error: explicitError,
      });

      expect(effectTypes(afterCause.effects)).toEqual(["terminate-process"]);
      expect(afterCause.state.primaryOutcome).toMatchObject({
        source: "adapter",
        error: adapterError,
      });
    },
  );

  it("makes duplicate settlement and settlement after finalization idempotent", () => {
    const settlement = fulfilledSettlement("bypassed");
    const first = reduceRendererLifecycle(createRendererLifecycleState(), {
      type: "adapter-settled",
      settlement,
    });
    const duplicate = reduceRendererLifecycle(first.state, {
      type: "adapter-settled",
      settlement: rejectedSettlement("required"),
    });
    const cleaned = reduceRendererLifecycle(duplicate.state, {
      type: "cleanup-complete",
    });
    const late = reduceRendererLifecycle(cleaned.state, {
      type: "adapter-settled",
      settlement: rejectedSettlement("required"),
    });

    expect(effectTypes(duplicate.effects)).toEqual(["diagnostic"]);
    expect(effectTypes(cleaned.effects)).toEqual(["finalize"]);
    expect(effectTypes(late.effects)).toEqual(["diagnostic"]);
    expect(late.state).toBe(cleaned.state);
  });

  it.each([
    ["fulfilled", fulfilledSettlement("bypassed")],
    ["adapter rejection", rejectedSettlement("bypassed")],
    ["protocol rejection", fulfilledSettlement("required")],
    ["abort", undefined],
  ] as const)(
    "preserves the %s primary outcome when cleanup fails",
    (_name, settlement) => {
      const cleanupError = new Error("cleanup failed");
      let state = createRendererLifecycleState();
      if (settlement === undefined) {
        state = apply(state, {
          type: "abort",
          error: new Error("abort"),
        }).state;
        state = apply(state, { type: "termination-complete" }).state;
      } else {
        state = apply(state, { type: "adapter-settled", settlement }).state;
        if (settlement.protocol === "required") {
          state = apply(state, {
            type: "protocol-result",
            result: { status: "rejected", error: protocolError },
          }).state;
        }
      }
      const completed = reduceRendererLifecycle(state, {
        type: "cleanup-complete",
        error: cleanupError,
      });
      const final = completed.effects.find(
        (effect) => effect.type === "finalize",
      );

      expect(final).toMatchObject({
        type: "finalize",
        outcome: { diagnostics: [cleanupError] },
      });
    },
  );

  it("preserves termination and cleanup failures as secondary diagnostics", () => {
    const abortError = new Error("abort");
    const terminationError = new Error("termination failed");
    const cleanupError = new Error("cleanup failed");
    let state = apply(createRendererLifecycleState(), {
      type: "abort",
      error: abortError,
    }).state;
    state = apply(state, {
      type: "termination-complete",
      error: terminationError,
    }).state;
    const completed = reduceRendererLifecycle(state, {
      type: "cleanup-complete",
      error: cleanupError,
    });

    expect(completed.effects).toContainEqual({
      type: "finalize",
      outcome: {
        status: "rejected",
        source: "abort",
        error: abortError,
        diagnostics: [terminationError, cleanupError],
      },
    });
  });

  it.each(["timeout", "escalation"] as const)(
    "preserves %s as primary when cleanup fails",
    (type) => {
      const primaryError = new Error(type);
      const cleanupError = new Error("cleanup failed");
      let state = apply(createRendererLifecycleState(), {
        type,
        error: primaryError,
      }).state;
      state = apply(state, { type: "termination-complete" }).state;
      const completed = reduceRendererLifecycle(state, {
        type: "cleanup-complete",
        error: cleanupError,
      });

      expect(completed.effects).toContainEqual({
        type: "finalize",
        outcome: {
          status: "rejected",
          source: type,
          error: primaryError,
          diagnostics: [cleanupError],
        },
      });
    },
  );

  it("proves bypass rejection never drains or terminates across short event permutations", () => {
    const surroundingEvents: LifecycleEvent[] = [
      {
        type: "protocol-result",
        result: { status: "rejected", error: protocolError },
      },
      {
        type: "process-exit",
        disposition: { status: "exited", code: 9, signal: null },
      },
    ];

    for (const order of permutations(surroundingEvents)) {
      let state = createRendererLifecycleState();
      const effects: LifecycleEffect[] = [];
      for (const event of [
        order[0]!,
        {
          type: "adapter-settled",
          settlement: rejectedSettlement("bypassed"),
        } as const,
        order[1]!,
      ]) {
        const reduced = reduceRendererLifecycle(state, event);
        state = reduced.state;
        effects.push(...reduced.effects);
      }
      const cleaned = reduceRendererLifecycle(state, {
        type: "cleanup-complete",
      });
      effects.push(...cleaned.effects);

      expect(effectTypes(effects)).not.toContain("drain-protocol");
      expect(effectTypes(effects)).not.toContain("terminate-process");
      expect(
        effectTypes(effects).filter((type) => type === "cleanup"),
      ).toHaveLength(1);
      expect(
        effectTypes(effects).filter((type) => type === "finalize"),
      ).toHaveLength(1);
      expect(cleaned.state.finalized).toBe(true);
    }
  });
});

function fulfilledSettlement(protocol: ProtocolPolicy) {
  return createAdapterSettlement({
    adapter: "custom",
    protocol,
    status: "fulfilled",
    result: "adapter result",
    process: { status: "running" },
  });
}

function rejectedSettlement(protocol: ProtocolPolicy) {
  return createAdapterSettlement({
    adapter: "custom",
    protocol,
    status: "rejected",
    error: adapterError,
    process: { status: "running" },
  });
}

function apply(state: RendererLifecycleState, event: LifecycleEvent) {
  return reduceRendererLifecycle(state, event);
}

function effectTypes(effects: readonly LifecycleEffect[]) {
  return effects.map((effect) => effect.type);
}

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) {
    return [[...values]];
  }
  return values.flatMap((value, index) =>
    permutations(
      values.filter((_candidate, candidateIndex) => candidateIndex !== index),
    ).map((rest) => [value, ...rest]),
  );
}

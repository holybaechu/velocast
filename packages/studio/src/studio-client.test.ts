import { afterEach, expect, it, vi } from "vitest";
import type { StudioClientCommand, StudioHeartbeat } from "@velocast/core";
import { StudioClientConnection } from "./studio-client.js";

afterEach(() => vi.useRealTimers());

function setup() {
  vi.useFakeTimers();
  let state = {
    sourceVersion: "source-1",
    compositions: [],
    compositionId: "scene",
    frame: 2,
    ready: true,
    exportReady: true,
    dirty: false,
    playing: false,
  };
  const sent: StudioHeartbeat[] = [];
  let commands: StudioClientCommand[] = [];
  let duringRequest: (() => void) | undefined;
  const api = {
    heartbeat: vi.fn(async (_id: string, heartbeat: StudioHeartbeat) => {
      sent.push(heartbeat);
      duringRequest?.();
      const result = { commands };
      commands = [];
      return result;
    }),
    disconnect: vi.fn(async () => {}),
  };
  const control = vi.fn(async (command: StudioClientCommand) => {
    if (command.action === "seek") state = { ...state, frame: command.frame };
  });
  const connection = new StudioClientConnection({
    api,
    getState: () => state,
    control,
  });
  return {
    connection,
    api,
    control,
    sent,
    command(command: StudioClientCommand) {
      commands = [command];
    },
    interrupt() {
      duringRequest = () => {
        state = { ...state, frame: 7 };
      };
    },
  };
}

it("publishes stable revisions, acknowledges exact commands, and disconnects its own client", async () => {
  const f = setup();
  f.connection.start();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.sent[0]!.state).toMatchObject({ revision: 1, frame: 2 });
  f.command({
    id: "seek",
    action: "seek",
    frame: 12,
    expectedRevision: 1,
    expectedSourceVersion: "source-1",
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.control).toHaveBeenCalledOnce();
  expect(f.sent.at(-1)).toMatchObject({
    state: { revision: 2, frame: 12 },
    acknowledgements: [{ id: "seek", status: "succeeded" }],
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.sent.at(-1)!.state.revision).toBe(2);
  await f.connection.dispose();
  expect(f.api.disconnect).toHaveBeenCalledWith(
    f.api.heartbeat.mock.calls[0]![0],
    expect.any(AbortSignal),
  );
  const count = f.sent.length;
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.sent).toHaveLength(count);
});

it("rejects a command if a human changes the tab while the request is in flight", async () => {
  const f = setup();
  f.command({
    id: "stale",
    action: "seek",
    frame: 12,
    expectedRevision: 1,
    expectedSourceVersion: "source-1",
  });
  f.interrupt();
  f.connection.start();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.control).not.toHaveBeenCalled();
  expect(f.sent.at(-1)).toMatchObject({
    state: { revision: 2, frame: 7 },
    acknowledgements: [
      {
        id: "stale",
        status: "failed",
        error: expect.stringContaining("studio.client_conflict"),
      },
    ],
  });
  await f.connection.dispose();
});

it("allows explicit pause after playback advances while still guarding the displayed source", async () => {
  const f = setup();
  f.command({
    id: "pause",
    action: "pause",
    expectedRevision: 1,
    expectedSourceVersion: "source-1",
  });
  f.interrupt();
  f.connection.start();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.control).toHaveBeenCalledOnce();
  f.command({
    id: "stale-source",
    action: "pause",
    expectedRevision: 1,
    expectedSourceVersion: "old-source",
  });
  await vi.advanceTimersByTimeAsync(1010);
  expect(f.control).toHaveBeenCalledOnce();
  expect(f.sent.at(-1)).toMatchObject({
    acknowledgements: [{ id: "stale-source", status: "failed" }],
  });
  await f.connection.dispose();
});

it("retains acknowledgements after network failure without executing a command twice", async () => {
  const f = setup();
  const command: StudioClientCommand = {
    id: "seek",
    action: "seek",
    frame: 12,
    expectedRevision: 1,
    expectedSourceVersion: "source-1",
  };
  f.api.heartbeat
    .mockImplementationOnce(async (_id, heartbeat) => {
      f.sent.push(heartbeat);
      return { commands: [command] };
    })
    .mockRejectedValueOnce(new Error("offline"));
  f.connection.start();
  await vi.advanceTimersByTimeAsync(1);
  f.command(command);
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.control).toHaveBeenCalledOnce();
  expect(
    f.sent.some(({ acknowledgements }) =>
      acknowledgements?.some(
        ({ id, status }) => id === "seek" && status === "succeeded",
      ),
    ),
  ).toBe(true);
  await f.connection.dispose();
});

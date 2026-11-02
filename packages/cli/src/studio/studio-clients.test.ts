import { afterEach, expect, it, vi } from "vitest";
import { StudioClients } from "./studio-clients.js";

afterEach(() => vi.useRealTimers());
const state = {
  revision: 1,
  sourceVersion: "build-1",
  compositions: [
    { id: "demo", width: 320, height: 180, fps: 30, durationFrames: 60 },
  ],
  compositionId: "demo",
  frame: 12,
  selectedElementId: "title",
  dirty: false,
  ready: true,
  exportReady: true,
  playing: false,
};

it("targets one browser and waits for its acknowledged presented frame", async () => {
  const clients = new StudioClients();
  clients.heartbeat("browser-a", { state });
  clients.heartbeat("browser-b", { state: { ...state, frame: 20 } });
  const result = clients.control({
    clientId: "browser-a",
    expectedRevision: 1,
    expectedSourceVersion: "build-1",
    action: "seek",
    frame: 30,
  });
  expect(
    clients.heartbeat("browser-b", { state: { ...state, frame: 20 } }).commands,
  ).toEqual([]);
  const command = clients.heartbeat("browser-a", { state }).commands[0]!;
  clients.heartbeat("browser-a", {
    state: { ...state, revision: 2, frame: 30 },
    acknowledgements: [{ id: command.id, status: "succeeded" }],
  });
  await expect(result).resolves.toMatchObject({
    clientId: "browser-a",
    revision: 2,
    frame: 30,
  });
  clients.close();
});

it("rejects stale commands and removes expired browser contexts", async () => {
  vi.useFakeTimers();
  const clients = new StudioClients();
  clients.heartbeat("browser-a", { state });
  await expect(
    clients.control({
      clientId: "browser-a",
      expectedRevision: 0,
      expectedSourceVersion: "build-1",
      action: "seek",
      frame: 30,
    }),
  ).rejects.toMatchObject({ code: "studio.client_stale" });
  expect(() =>
    clients.heartbeat("browser-a", { state: { ...state, frame: 25 } }),
  ).toThrow(/revision/i);
  vi.advanceTimersByTime(30_001);
  expect(clients.list()).toEqual([]);
  clients.close();
});

it("keeps a ready browser available after a recoverable output error", () => {
  const clients = new StudioClients();
  clients.heartbeat("browser-a", {
    state: { ...state, error: "Output cancelled; retry when ready" },
  });
  expect(clients.list()[0]).toMatchObject({ exportReady: true });
  expect(() =>
    clients.heartbeat("browser-b", { state: { ...state, ready: false } }),
  ).toThrow(/readiness/);
  clients.close();
});

it("bounds commands, preserves browser failures, and cancels pending control on shutdown", async () => {
  const clients = new StudioClients();
  clients.heartbeat("browser-a", { state });
  const request = {
    clientId: "browser-a",
    expectedRevision: 1,
    expectedSourceVersion: "build-1",
    action: "seek",
    frame: 30,
  };
  const result = clients.control(request);
  await expect(clients.control(request)).rejects.toMatchObject({
    code: "studio.client_busy",
  });
  const command = clients.heartbeat("browser-a", { state }).commands[0]!;
  clients.heartbeat("browser-a", {
    state,
    acknowledgements: [
      {
        id: command.id,
        status: "failed",
        error: "Source changed before the command ran",
      },
    ],
  });
  await expect(result).rejects.toThrow(/Source changed/);
  const pending = clients.control(request);
  clients.close();
  await expect(pending).rejects.toMatchObject({ code: "studio.client_closed" });
});

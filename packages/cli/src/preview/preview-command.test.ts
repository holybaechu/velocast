import { expect, it, vi } from "vitest";
import { previewCommand } from "./preview-command.js";

it("prints one ready descriptor and waits for cancellation before closing its server", async () => {
  const controller = new AbortController();
  const close = vi.fn(async () => {});
  const write = vi.fn((message: string) => {
    void message;
    controller.abort();
  });
  const createServer = vi.fn(async () => ({
    url: "http://127.0.0.1:12345",
    close,
    session: () => ({
      snapshotUrl: "http://127.0.0.1:23456/index.html",
      session: { sessionId: "one", sourceVersion: "a".repeat(64) },
    }),
  }));
  const before = [
    process.listenerCount("SIGINT"),
    process.listenerCount("SIGTERM"),
  ];
  await previewCommand(
    { entry: "dist/index.html" },
    { signal: controller.signal, port: "0", json: true },
    { createServer, write },
  );
  expect(createServer).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
  expect(
    JSON.parse(write.mock.calls[0]![0] as unknown as string),
  ).toMatchObject({ status: "ready", url: "http://127.0.0.1:12345" });
  expect([
    process.listenerCount("SIGINT"),
    process.listenerCount("SIGTERM"),
  ]).toEqual(before);
});

it("rejects invalid port/watch requests without opening a session", async () => {
  const createServer = vi.fn();
  await expect(
    previewCommand({}, { port: "not-a-port" }, { createServer }),
  ).rejects.toThrow("preview.invalid_port");
  await expect(
    previewCommand({}, { watchCommand: " " }, { createServer }),
  ).rejects.toThrow("preview.invalid_watch_command");
  expect(createServer).not.toHaveBeenCalled();
});

it.each(["primary", "cleanup", "combined", "falsy"])(
  "preserves %s preview failures and releases signal listeners",
  async (scenario) => {
    const controller = new AbortController();
    const primary =
      scenario === "falsy" ? undefined : new Error("write failed");
    const secondary = scenario === "falsy" ? 0 : new Error("close failed");
    const close = vi.fn(async () => {
      if (scenario !== "primary") throw secondary;
    });
    const before = [
      process.listenerCount("SIGINT"),
      process.listenerCount("SIGTERM"),
    ];
    const error = await previewCommand(
      {},
      { signal: controller.signal },
      {
        createServer: async () => ({
          url: "http://127.0.0.1:12345",
          close,
          session: () => ({
            snapshotUrl: "http://127.0.0.1:23456/index.html",
            session: { sessionId: "one", sourceVersion: "version" },
          }),
        }),
        write: () => {
          if (scenario !== "cleanup") throw primary;
          controller.abort();
        },
      },
    ).then(
      () => expect.fail("preview command should reject"),
      (error: unknown) => error,
    );
    if (scenario === "combined" || scenario === "falsy") {
      expect(error).toBeInstanceOf(AggregateError);
      const aggregate = error as AggregateError;
      expect(aggregate.errors).toHaveLength(2);
      expect(aggregate.errors[0]).toBe(primary);
      expect(aggregate.errors[1]).toBe(secondary);
      expect(aggregate.cause).toBe(primary);
      expect(aggregate.message).toBe(
        scenario === "falsy" ? "undefined\n0" : "write failed\nclose failed",
      );
    } else expect(error).toBe(scenario === "primary" ? primary : secondary);
    expect(close).toHaveBeenCalledTimes(1);
    expect([
      process.listenerCount("SIGINT"),
      process.listenerCount("SIGTERM"),
    ]).toEqual(before);
  },
);

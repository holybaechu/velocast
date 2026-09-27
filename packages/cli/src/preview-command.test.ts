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

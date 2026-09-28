import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  browserClose: vi.fn(),
  snapshotClose: vi.fn(),
}));
vi.mock("./browser-cdp.js", async (original) => ({
  ...(await original<typeof import("./browser-cdp.js")>()),
  launchCdpBrowser: async () => ({
    call: mocks.call,
    close: mocks.browserClose,
    evaluate: vi.fn(),
    executable: "owned-browser",
  }),
}));
vi.mock("./render-source.js", () => ({
  resolveCompositionRenderSource: () => ({
    kind: "entry",
    snapshotRoot: "fixture",
    url: new URL("./agent-audit.ts", import.meta.url).href,
  }),
}));
vi.mock("./input-snapshot.js", () => ({
  createInputSnapshot: async () => ({
    url: "http://fixture/",
    session: { sessionId: "session", sourceVersion: "version" },
    close: mocks.snapshotClose,
  }),
}));
import { auditComposition } from "./agent-audit.js";
beforeEach(() => vi.resetAllMocks());
it("preserves the page error and attempts remaining cleanup when browser shutdown also fails", async () => {
  const pageError = new Error("original page failure"),
    closeError = new Error("owned browser termination failed"),
    snapshotError = new Error("snapshot cleanup failed");
  mocks.call.mockRejectedValue(pageError);
  mocks.browserClose.mockRejectedValue(closeError);
  mocks.snapshotClose.mockRejectedValue(snapshotError);
  const error = await auditComposition({}, "fixture").catch((error) => error);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.cause).toBe(pageError);
  expect(error.message).toMatch(/^original page failure/);
  expect(error.errors).toEqual([pageError, closeError, snapshotError]);
  expect(mocks.snapshotClose).toHaveBeenCalledOnce();
});
it("returns the original error unchanged when owned cleanup succeeds", async () => {
  const pageError = new Error("original page failure");
  mocks.call.mockRejectedValue(pageError);
  mocks.browserClose.mockResolvedValue(undefined);
  mocks.snapshotClose.mockResolvedValue(undefined);
  await expect(auditComposition({}, "fixture")).rejects.toBe(pageError);
  expect(mocks.snapshotClose).toHaveBeenCalledOnce();
});

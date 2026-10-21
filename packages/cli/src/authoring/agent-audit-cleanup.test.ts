import { beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  browserClose: vi.fn(),
  snapshotClose: vi.fn(),
  inputPropsPath: undefined as string | undefined,
}));
vi.mock("../media/browser-cdp.js", async (original) => ({
  ...(await original<typeof import("../media/browser-cdp.js")>()),
  launchCdpBrowser: async () => ({
    call: mocks.call,
    close: mocks.browserClose,
    evaluate: vi.fn(),
    executable: "owned-browser",
  }),
}));
vi.mock("../project/render-source.js", () => ({
  resolveCompositionRenderSource: () => ({
    kind: "entry",
    snapshotRoot: "fixture",
    url: new URL("./agent-audit.ts", import.meta.url).href,
  }),
}));
vi.mock("../project/input-snapshot.js", () => ({
  createInputSnapshot: async () => ({
    url: "http://fixture/",
    session: { sessionId: "session", sourceVersion: "version" },
    inputPropsPath: mocks.inputPropsPath,
    close: mocks.snapshotClose,
  }),
}));
import { auditComposition } from "./agent-audit.js";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.inputPropsPath = undefined;
});
it("closes the snapshot when frozen input props cannot be parsed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "velocast-audit-props-test-"));
  try {
    mocks.inputPropsPath = join(directory, "props.json");
    await writeFile(mocks.inputPropsPath, "invalid JSON");
    await expect(auditComposition({}, "fixture")).rejects.toBeInstanceOf(
      SyntaxError,
    );
    expect(mocks.snapshotClose).toHaveBeenCalledOnce();
    expect(mocks.call).not.toHaveBeenCalled();
    expect(mocks.browserClose).not.toHaveBeenCalled();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
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

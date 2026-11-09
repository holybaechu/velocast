import { beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  evaluate: vi.fn(),
  renderFrame: vi.fn(),
  browserClose: vi.fn(),
  snapshotClose: vi.fn(),
  inputPropsPath: undefined as string | undefined,
}));
vi.mock("../media/browser-cdp.js", async (original) => ({
  ...(await original<typeof import("../media/browser-cdp.js")>()),
  launchCdpBrowser: async () => ({
    call: mocks.call,
    close: mocks.browserClose,
    evaluate: mocks.evaluate,
    executable: "owned-browser",
  }),
}));
vi.mock("../render/commands.js", () => ({ renderFrame: mocks.renderFrame }));
vi.mock("../project/render-source.js", () => ({
  resolveCompositionRenderSource: () => ({
    kind: "entry",
    snapshotRoot: "fixture",
    url: new URL("./frame-check.ts", import.meta.url).href,
  }),
}));
vi.mock("../project/input-snapshot.js", () => ({
  createInputSnapshot: async () => ({
    url: "http://fixture/",
    session: { sessionId: "session", sourceVersion: "a".repeat(64) },
    inputPropsPath: mocks.inputPropsPath,
    close: mocks.snapshotClose,
  }),
}));
import { checkComposition } from "./frame-check.js";
const composition = {
  id: "../fixture/scene",
  width: 64,
  height: 48,
  fps: 30,
  durationFrames: 10,
  target: "#scene",
};
function readyBrowser() {
  mocks.evaluate.mockImplementation(async (expression: string) => {
    if (expression.startsWith("Boolean(")) return true;
    if (expression === "window.__velocast.getCompositions()")
      return [composition];
    if (expression.includes("const runtimeErrors="))
      return {
        selectors: [],
        runtimeErrors: [],
        viewport: {
          width: 64,
          height: 48,
          scrollWidth: 64,
          scrollHeight: 48,
          rootBox: { x: 0, y: 0, width: 64, height: 48 },
        },
        automaticTextAudit: {
          totalCandidates: 0,
          examined: 0,
          truncated: false,
          unmeasurableContrast: 0,
          findings: [],
        },
      };
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.inputPropsPath = undefined;
});
it("closes the snapshot when frozen input props cannot be parsed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "velocast-audit-props-test-"));
  try {
    mocks.inputPropsPath = join(directory, "props.json");
    await writeFile(mocks.inputPropsPath, "invalid JSON");
    await expect(checkComposition({}, "fixture")).rejects.toBeInstanceOf(
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
  const error = await checkComposition({}, "fixture").catch((error) => error);
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
  await expect(checkComposition({}, "fixture")).rejects.toBe(pageError);
  expect(mocks.snapshotClose).toHaveBeenCalledOnce();
});

it("routes ordered, scoped final snapshots to native with the audit's frozen source and props", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "velocast-audit-snapshots-test-"),
  );
  try {
    readyBrowser();
    mocks.inputPropsPath = join(directory, "props.json");
    await writeFile(mocks.inputPropsPath, JSON.stringify({ title: "frozen" }));
    const options = {
      frames: "9,0,9",
      snapshots: "pictures",
      cwd: directory,
      env: { INIT_CWD: directory },
    };
    const report = await checkComposition({}, composition.id, options);
    expect(report.sampledFrames.map((sample) => sample.frame)).toEqual([0, 9]);
    expect(report.sampledFrames.map((sample) => sample.snapshot)).toEqual([
      join(directory, "pictures", ".._fixture_scene-frame-0.png"),
      join(directory, "pictures", ".._fixture_scene-frame-9.png"),
    ]);
    for (const [index, frame] of [0, 9].entries()) {
      const args = mocks.renderFrame.mock.calls[index]!;
      expect(args.slice(0, 4)).toEqual([
        {},
        composition.id,
        report.sampledFrames[index]!.snapshot,
        { frame },
      ]);
      expect(args[4]).toMatchObject({
        inputSnapshot: {
          url: "http://fixture/",
          session: report.source,
          inputPropsPath: mocks.inputPropsPath,
        },
        expectedSourceVersion: report.source.sourceVersion,
        pathOptions: options,
        signal: expect.any(AbortSignal),
      });
    }
    expect(
      mocks.evaluate.mock.calls.some(([expression]) =>
        expression.includes('inputProps:{"title":"frozen"}'),
      ),
    ).toBe(true);
    expect(mocks.call.mock.calls.map(([method]) => method)).not.toContain(
      "Page.captureScreenshot",
    );
    expect(mocks.snapshotClose).toHaveBeenCalledOnce();
    expect(await readdir(directory)).toEqual(["pictures", "props.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([false, true])(
  "does not fall back or overwrite previous snapshots after native failure/cancellation (cancel=%s)",
  async (cancel) => {
    const directory = await mkdtemp(
      join(tmpdir(), "velocast-audit-failure-test-"),
    );
    try {
      readyBrowser();
      const controller = new AbortController();
      const output = join(directory, ".._fixture_scene-frame-0.png");
      await writeFile(output, "previous");
      const failure = new Error(
        cancel ? "cancelled" : "native GPU capture unavailable",
      );
      mocks.renderFrame.mockImplementation(async (...args: unknown[]) => {
        expect((args[4] as { signal: AbortSignal }).signal).toBe(
          controller.signal,
        );
        if (cancel) controller.abort(failure);
        throw failure;
      });
      await expect(
        checkComposition({}, composition.id, {
          frames: "0,9",
          snapshots: directory,
          signal: controller.signal,
        }),
      ).rejects.toBe(failure);
      expect(mocks.renderFrame).toHaveBeenCalledOnce();
      expect(await readFile(output, "utf8")).toBe("previous");
      expect(await readdir(directory)).toEqual([
        ".._fixture_scene-frame-0.png",
      ]);
      expect(mocks.browserClose).toHaveBeenCalledOnce();
      expect(mocks.snapshotClose).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

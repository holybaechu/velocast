import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPreviewServer } from "./preview-server.js";
import { failedOutputResult } from "./output-result.js";
import type { RustRenderJob } from "./render-command-job.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "velocast-preview-server-"));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "dist"));
  await writeFile(join(cwd, "dist/index.html"), "<p>original project</p>");
  return {
    cwd,
    config: { entry: "dist/index.html", renderer: { snapshotRoot: "dist" } },
  };
}
const composition = {
  id: "scene",
  width: 320,
  height: 180,
  fps: 30,
  durationFrames: 60,
};
async function nativeSuccess(value: unknown) {
  const job = value as RustRenderJob;
  await writeFile(job.output, "complete output");
  await writeFile(
    job.result_path!,
    JSON.stringify({
      ...failedOutputResult(job, "pending"),
      status: "success",
      error: null,
      composition,
      compositions: [composition],
      request: {
        compositionId: "scene",
        frame: job.output_frame ?? null,
        range:
          job.operation === "frame"
            ? null
            : (job.output_range ?? { startFrame: 0, endFrame: 60 }),
      },
    }),
  );
}
function post(url: string, data: unknown) {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Origin: new URL(url).origin,
    },
    body: JSON.stringify(data),
  });
}

it("serves installed UI and immutable instrumented project versions, refreshes without mutating authored files", async () => {
  const { cwd, config } = await fixture();
  const server = await createPreviewServer(config, {
    pathOptions: { cwd, env: {} },
  });
  cleanup.push(server.close);
  expect((await fetch(server.url)).status).toBe(200);
  const before = server.session();
  const entry = await (await fetch(before.snapshotUrl)).text();
  expect(entry).toContain("original project");
  expect(entry).toContain("/__velocast-preview/bridge.js");
  expect(await readFile(join(cwd, "dist/index.html"), "utf8")).toBe(
    "<p>original project</p>",
  );
  const platform = await fetch(
    new URL("/__velocast-preview/config.js", before.snapshotUrl),
  );
  expect(await platform.text()).toContain(server.url);
  await writeFile(join(cwd, "dist/index.html"), "<p>changed project</p>");
  expect(await (await fetch(before.snapshotUrl)).text()).toContain(
    "original project",
  );
  const refreshed = await post(server.url + "/api/refresh", {
    expectedSourceVersion: before.session.sourceVersion,
  });
  expect(refreshed.status).toBe(200);
  const after = (await refreshed.json()) as ReturnType<typeof server.session>;
  expect(after.session.sourceVersion).not.toBe(before.session.sourceVersion);
  expect(await (await fetch(after.snapshotUrl)).text()).toContain(
    "changed project",
  );
  await expect(fetch(before.snapshotUrl)).rejects.toThrow();
  expect(
    (
      await post(server.url + "/api/refresh", {
        expectedSourceVersion: before.session.sourceVersion,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await fetch(server.url + "/api/session", {
        headers: { Origin: "http://127.0.0.1:9" },
      })
    ).status,
  ).toBe(403);
  await server.close();
  await expect(fetch(after.snapshotUrl)).rejects.toThrow();
});

it("owns exact frame/range output requests and rejects unrefreshed source before native acquisition", async () => {
  const { cwd, config } = await fixture();
  const acquire = vi.fn(async () => ({
    binary: "native",
    env: process.env,
    source: "local" as const,
  }));
  const native = vi.fn(async (_binary: string, job: unknown) =>
    nativeSuccess(job),
  );
  const server = await createPreviewServer(
    config,
    { pathOptions: { cwd, env: {} } },
    {
      runtimeAcquisition: { acquire },
      runRenderer: native,
      probeCapabilities: () => ({ available: true, outputApiVersion: 1 }),
    },
  );
  cleanup.push(server.close);
  const version = server.session().session.sourceVersion;
  const frame = await post(server.url + "/api/output", {
    compositionId: "scene",
    frame: 12,
    expectedSourceVersion: version,
  });
  expect(frame.status).toBe(200);
  const result = (await frame.json()) as { outputPath: string; url: string };
  expect(result.outputPath).toMatch(/\.png$/);
  expect(await (await fetch(result.url)).text()).toBe("complete output");
  const range = await post(server.url + "/api/output", {
    compositionId: "scene",
    range: { start: 12, end: 18 },
    expectedSourceVersion: version,
  });
  expect(range.status).toBe(200);
  expect((native.mock.calls[1]![1] as RustRenderJob).output_range).toEqual({
    startFrame: 12,
    endFrame: 18,
  });
  const calls = acquire.mock.calls.length;
  await writeFile(join(cwd, "dist/index.html"), "changed without refresh");
  const stale = await post(server.url + "/api/output", {
    compositionId: "scene",
    frame: 12,
    expectedSourceVersion: version,
  });
  expect(stale.status).not.toBe(200);
  expect(await stale.text()).toContain("snapshot.version_mismatch");
  expect(acquire).toHaveBeenCalledTimes(calls);
  expect(await readFile(result.outputPath, "utf8")).toBe("complete output");
  await server.close();
  expect(await readFile(result.outputPath, "utf8")).toBe("complete output");
});

it("retains the valid snapshot after a failed source refresh", async () => {
  const { cwd, config } = await fixture();
  const server = await createPreviewServer(config, {
    pathOptions: { cwd, env: {} },
  });
  cleanup.push(server.close);
  const before = server.session();
  await rm(join(cwd, "dist/index.html"));
  const response = await post(server.url + "/api/refresh", {
    expectedSourceVersion: before.session.sourceVersion,
  });
  expect(response.status).toBe(500);
  expect(server.session()).toEqual(before);
  expect(await (await fetch(before.snapshotUrl)).text()).toContain(
    "original project",
  );
});

it("stages a new source for browser validation and only replaces the active source on commit", async () => {
  const { cwd, config } = await fixture();
  const server = await createPreviewServer(config, {
    pathOptions: { cwd, env: {} },
  });
  cleanup.push(server.close);
  const before = server.session();
  await writeFile(join(cwd, "dist/index.html"), "<h1>candidate</h1>");
  const changes = (await (await fetch(server.url + "/api/changes")).json()) as {
    revision: string;
  };
  expect(changes.revision).not.toBe(before.sourceRevision);
  const prepared = (await (
    await post(server.url + "/api/prepare-refresh", {
      expectedSourceVersion: before.session.sourceVersion,
    })
  ).json()) as ReturnType<typeof server.session>;
  expect(server.session()).toEqual(before);
  expect(await (await fetch(before.snapshotUrl)).text()).toContain(
    "original project",
  );
  expect(await (await fetch(prepared.snapshotUrl)).text()).toContain(
    "candidate",
  );
  expect(
    (
      await post(server.url + "/api/commit-refresh", {
        expectedSourceVersion: before.session.sourceVersion,
        candidateSessionId: "stale",
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await post(server.url + "/api/discard-refresh", {
        expectedSourceVersion: before.session.sourceVersion,
        candidateSessionId: prepared.session.sessionId,
      })
    ).status,
  ).toBe(200);
  expect(server.session()).toEqual(before);
  await expect(fetch(prepared.snapshotUrl)).rejects.toThrow();
  const second = (await (
    await post(server.url + "/api/prepare-refresh", {
      expectedSourceVersion: before.session.sourceVersion,
    })
  ).json()) as ReturnType<typeof server.session>;
  expect(
    (
      await post(server.url + "/api/commit-refresh", {
        expectedSourceVersion: before.session.sourceVersion,
        candidateSessionId: second.session.sessionId,
      })
    ).status,
  ).toBe(200);
  expect(server.session().session).toEqual(second.session);
  await expect(fetch(before.snapshotUrl)).rejects.toThrow();
});

it("keeps automatic source updates opt-out and releases an uncommitted candidate on close", async () => {
  const { cwd, config } = await fixture();
  const server = await createPreviewServer(config, {
    autoRefresh: false,
    pathOptions: { cwd, env: {} },
  });
  cleanup.push(server.close);
  expect(server.session().autoRefresh).toBe(false);
  expect(await (await fetch(server.url + "/api/changes")).json()).toMatchObject(
    { enabled: false },
  );
  const prepared = (await (
    await post(server.url + "/api/prepare-refresh", {
      expectedSourceVersion: server.session().session.sourceVersion,
    })
  ).json()) as ReturnType<typeof server.session>;
  await server.close();
  await expect(fetch(prepared.snapshotUrl)).rejects.toThrow();
});

it("expires an abandoned prepared snapshot while retaining the active source", async () => {
  const { cwd, config } = await fixture();
  const server = await createPreviewServer(
    config,
    { pathOptions: { cwd, env: {} } },
    { preparedLifetimeMs: 100 },
  );
  cleanup.push(server.close);
  const before = server.session();
  const prepared = (await (
    await post(server.url + "/api/prepare-refresh", {
      expectedSourceVersion: before.session.sourceVersion,
    })
  ).json()) as ReturnType<typeof server.session>;
  await new Promise((done) => setTimeout(done, 200));
  await expect(fetch(prepared.snapshotUrl)).rejects.toThrow();
  expect(server.session()).toEqual(before);
  expect((await fetch(before.snapshotUrl)).status).toBe(200);
});

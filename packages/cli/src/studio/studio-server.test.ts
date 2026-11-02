import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStudioServer, type StudioJob } from "./studio-server.js";
import { failedOutputResult } from "../render/output-result.js";
import type { RustRenderJob } from "../render/render-command-job.js";
import * as snapshotModule from "../project/input-snapshot.js";
import type { StudioClientCommand, StudioClientState } from "@velocast/core";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "velocast-studio-server-"));
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

async function finishedJob(
  url: string,
  response: Response,
): Promise<StudioJob> {
  expect(response.status).toBe(202);
  const created = await response.json();
  let job!: StudioJob;
  await vi.waitFor(async () => {
    job = await (await fetch(`${url}/api/jobs/${created.id}`)).json();
    expect(["running", "cancelling"]).not.toContain(job.status);
  });
  return job;
}

async function browserCommand(
  url: string,
  clientId: string,
  state: StudioClientState,
): Promise<StudioClientCommand> {
  let command!: StudioClientCommand;
  await vi.waitFor(async () => {
    const response = await post(`${url}/api/clients/${clientId}`, { state });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.commands).toHaveLength(1);
    command = body.commands[0];
  });
  return command;
}

it("targets explicit browser clients over HTTP and completes controls only after their acknowledgements", async () => {
  const { cwd, config } = await fixture();
  const server = await createStudioServer(config, {
    pathOptions: { cwd, env: {} },
  });
  cleanup.push(server.close);
  let state: StudioClientState = {
    revision: 1,
    sourceVersion: server.session().session.sourceVersion,
    compositions: [composition],
    compositionId: "scene",
    frame: 0,
    selectedElementId: "heading",
    sourceRevision: "file-1",
    dirty: false,
    ready: true,
    exportReady: true,
    playing: false,
  };
  const otherState = { ...state, frame: 8 };
  expect(
    await (await post(server.url + "/api/clients/browser-a", { state })).json(),
  ).toEqual({ commands: [] });
  expect(
    (await post(server.url + "/api/clients/browser-b", { state: otherState }))
      .status,
  ).toBe(200);
  expect(await (await fetch(server.url + "/api/clients")).json()).toMatchObject(
    {
      clients: [
        { clientId: "browser-a", frame: 0, sourceRevision: "file-1" },
        { clientId: "browser-b", frame: 8 },
      ],
    },
  );

  const seekRequest = {
    clientId: "browser-a",
    expectedRevision: 1,
    expectedSourceVersion: state.sourceVersion,
    action: "seek",
    frame: 17,
  };
  let completed = false;
  const seeking = post(server.url + "/api/control", seekRequest).then(
    (response) => {
      completed = true;
      return response;
    },
  );
  const seek = await browserCommand(server.url, "browser-a", state);
  expect(seek).toMatchObject({
    action: "seek",
    frame: 17,
    expectedRevision: 1,
    expectedSourceVersion: state.sourceVersion,
  });
  expect(completed).toBe(false);
  // Another tab cannot consume or acknowledge this tab's request.
  expect(
    await (
      await post(server.url + "/api/clients/browser-b", {
        state: otherState,
        acknowledgements: [{ id: seek.id, status: "succeeded" }],
      })
    ).json(),
  ).toEqual({ commands: [] });
  expect(completed).toBe(false);
  state = { ...state, revision: 2, frame: 17 };
  expect(
    (
      await post(server.url + "/api/clients/browser-a", {
        state,
        acknowledgements: [{ id: seek.id, status: "succeeded" }],
      })
    ).status,
  ).toBe(200);
  const sought = await seeking;
  expect(sought.status).toBe(200);
  expect(await sought.json()).toMatchObject({
    clientId: "browser-a",
    revision: 2,
    frame: 17,
  });

  const stale = await post(server.url + "/api/control", seekRequest);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ code: "studio.client_stale" });
  const staleSource = await post(server.url + "/api/control", {
    ...seekRequest,
    expectedRevision: 2,
    expectedSourceVersion: "old-source",
  });
  expect(staleSource.status).toBe(409);
  expect(await staleSource.json()).toMatchObject({
    code: "snapshot.version_mismatch",
  });
  const conflictingHeartbeat = await post(
    server.url + "/api/clients/browser-a",
    { state: { ...state, frame: 25 } },
  );
  expect(conflictingHeartbeat.status).toBe(409);
  expect(await conflictingHeartbeat.json()).toMatchObject({
    code: "studio.client_stale",
  });

  const selecting = post(server.url + "/api/control", {
    clientId: "browser-a",
    expectedRevision: 2,
    expectedSourceVersion: state.sourceVersion,
    action: "select",
    elementId: "caption",
  });
  const select = await browserCommand(server.url, "browser-a", state);
  expect(select).toMatchObject({ action: "select", elementId: "caption" });
  state = { ...state, revision: 3, selectedElementId: "caption" };
  await post(server.url + "/api/clients/browser-a", {
    state,
    acknowledgements: [{ id: select.id, status: "succeeded" }],
  });
  expect(await (await selecting).json()).toMatchObject({
    clientId: "browser-a",
    selectedElementId: "caption",
    frame: 17,
    revision: 3,
  });

  const rejected = post(server.url + "/api/control", {
    clientId: "browser-a",
    expectedRevision: 3,
    expectedSourceVersion: state.sourceVersion,
    action: "select",
    elementId: "missing",
  });
  const missing = await browserCommand(server.url, "browser-a", state);
  await post(server.url + "/api/clients/browser-a", {
    state,
    acknowledgements: [
      {
        id: missing.id,
        status: "failed",
        error: "studio.element_missing: No source element named missing",
      },
    ],
  });
  const failure = await rejected;
  expect(failure.status).toBe(409);
  expect(await failure.json()).toMatchObject({
    code: "studio.client_command_failed",
    message: "studio.element_missing: No source element named missing",
  });
});

it.each(["disconnect", "shutdown"] as const)(
  "settles an outstanding HTTP control on browser %s",
  async (operation) => {
    const { cwd, config } = await fixture();
    const server = await createStudioServer(config, {
      pathOptions: { cwd, env: {} },
    });
    cleanup.push(server.close);
    const state: StudioClientState = {
      revision: 1,
      sourceVersion: server.session().session.sourceVersion,
      compositions: [composition],
      compositionId: "scene",
      frame: 0,
      dirty: false,
      ready: true,
      exportReady: true,
      playing: false,
    };
    await post(server.url + "/api/clients/browser-a", { state });
    const request = {
      clientId: "browser-a",
      expectedRevision: 1,
      expectedSourceVersion: state.sourceVersion,
      action: "seek",
      frame: 12,
    };
    const pending = post(server.url + "/api/control", request);
    // Attach rejection handling before shutdown can close the HTTP connection.
    const settled = Promise.allSettled([pending]);
    await browserCommand(server.url, "browser-a", state);
    if (operation === "disconnect") {
      expect(
        (
          await fetch(server.url + "/api/clients/browser-a", {
            method: "DELETE",
            headers: { Origin: server.url },
          })
        ).status,
      ).toBe(200);
      const response = await pending;
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "studio.client_disconnected",
      });
      expect(await (await fetch(server.url + "/api/clients")).json()).toEqual({
        clients: [],
      });
      expect((await post(server.url + "/api/control", request)).status).toBe(
        409,
      );
    } else {
      await server.close();
      const [result] = await settled;
      if (result!.status === "fulfilled")
        expect(result!.value.status).toBe(503);
      await expect(fetch(server.url + "/api/clients")).rejects.toThrow();
    }
    await settled;
  },
);

it("keeps asynchronous output owned by the session and exposes its completed artifact", async () => {
  const { cwd, config } = await fixture();
  let finish!: () => void;
  const held = new Promise<void>((done) => {
    finish = done;
  });
  const server = await createStudioServer(
    config,
    { pathOptions: { cwd, env: {} } },
    {
      runtimeAcquisition: {
        acquire: async () => ({
          binary: "native",
          env: {},
          source: "local" as const,
        }),
      },
      probeCapabilities: () => ({ available: true, outputApiVersion: 1 }),
      runRenderer: async (_binary, job) => {
        await held;
        await nativeSuccess(job);
      },
    },
  );
  cleanup.push(server.close);
  cleanup.push(async () => {
    finish();
  });
  const response = await post(server.url + "/api/jobs", {
    compositionId: "scene",
    frame: 12,
    expectedSourceVersion: server.session().session.sourceVersion,
  });
  expect(response.status).toBe(202);
  const created = (await response.json()) as { id: string; status: string };
  expect(created.status).toBe("running");
  expect(await (await fetch(server.url + "/api/jobs")).json()).toMatchObject({
    jobs: [{ id: created.id }],
  });
  expect(
    (
      await post(server.url + "/api/refresh", {
        expectedSourceVersion: server.session().session.sourceVersion,
      })
    ).status,
  ).toBe(409);
  finish();
  let completed:
    | { status: string; result?: { url: string; outputPath: string } }
    | undefined;
  await vi.waitFor(async () => {
    completed = await (
      await fetch(server.url + "/api/jobs/" + created.id)
    ).json();
    expect(completed?.status).toBe("succeeded");
  });
  expect(await (await fetch(completed!.result!.url)).text()).toBe(
    "complete output",
  );
  await server.close();
  expect(await readFile(completed!.result!.outputPath, "utf8")).toBe(
    "complete output",
  );
});

it("reports asynchronous failures and refuses stale or concurrent output", async () => {
  const { cwd, config } = await fixture();
  const server = await createStudioServer(
    config,
    { pathOptions: { cwd, env: {} } },
    {
      runtimeAcquisition: {
        acquire: async () => {
          throw new Error("runtime.unavailable: install the renderer");
        },
      },
    },
  );
  cleanup.push(server.close);
  const request = {
    compositionId: "scene",
    frame: 0,
    expectedSourceVersion: server.session().session.sourceVersion,
  };
  expect(
    (
      await post(server.url + "/api/jobs", {
        ...request,
        expectedSourceVersion: "stale",
      })
    ).status,
  ).toBe(409);
  const job = (await (
    await post(server.url + "/api/jobs", request)
  ).json()) as { id: string };
  await vi.waitFor(async () => {
    expect(
      await (await fetch(server.url + "/api/jobs/" + job.id)).json(),
    ).toMatchObject({
      status: "failed",
      error: {
        code: "runtime.unavailable",
        message: "runtime.unavailable: install the renderer",
      },
    });
  });
  expect((await fetch(server.url + "/api/jobs/missing")).status).toBe(404);
  expect(
    (await post(server.url + "/api/jobs", { ...request, frame: -1 })).status,
  ).toBe(400);
});

it.each(["cancel", "close"])(
  "joins output acquisition cleanup on %s after the starting client disconnects",
  async (operation) => {
    const { cwd, config } = await fixture();
    let started!: () => void;
    const acquiring = new Promise<void>((done) => {
      started = done;
    });
    let aborted!: () => void;
    const aborting = new Promise<void>((done) => {
      aborted = done;
    });
    let finish!: () => void;
    const cleanupFinished = new Promise<void>((done) => {
      finish = done;
    });
    let joined = false;
    const server = await createStudioServer(
      config,
      { pathOptions: { cwd, env: {} } },
      {
        runtimeAcquisition: {
          acquire: async (_binary, signal) => {
            started();
            await new Promise<void>((done) => {
              signal!.addEventListener("abort", () => done(), { once: true });
            });
            aborted();
            await cleanupFinished;
            joined = true;
            throw signal!.reason;
          },
        },
      },
    );
    cleanup.push(server.close);
    cleanup.push(async () => {
      finish();
    });
    const client = new AbortController();
    const response = await fetch(server.url + "/api/jobs", {
      method: "POST",
      signal: client.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        compositionId: "scene",
        frame: 1,
        expectedSourceVersion: server.session().session.sourceVersion,
      }),
    });
    const job = (await response.json()) as { id: string };
    client.abort();
    await acquiring;
    expect(
      (
        await post(server.url + "/api/jobs", {
          compositionId: "scene",
          frame: 0,
          expectedSourceVersion: server.session().session.sourceVersion,
        })
      ).status,
    ).toBe(409);
    expect(
      await (await fetch(server.url + "/api/jobs/" + job.id)).json(),
    ).toMatchObject({ status: "running" });
    let completed = false;
    const ending = (
      operation === "close"
        ? server.close()
        : post(server.url + "/api/jobs/" + job.id + "/cancel", {})
    ).then((value) => {
      completed = true;
      return value;
    });
    await aborting;
    expect(completed).toBe(false);
    expect(joined).toBe(false);
    if (operation === "cancel")
      expect(
        await (await fetch(server.url + "/api/jobs/" + job.id)).json(),
      ).toMatchObject({ status: "cancelling" });
    finish();
    const result = await ending;
    expect(joined).toBe(true);
    if (result)
      expect(await result.json()).toMatchObject({
        id: job.id,
        status: "cancelled",
        error: { code: "studio.cancelled" },
      });
  },
);

it("reads code-owned input props and refreshes their immutable snapshot after external edits", async () => {
  const { cwd, config } = await fixture();
  const path = join(cwd, "inputs.json");
  await writeFile(path, '{"title":"original"}');
  const server = await createStudioServer(config, {
    inputPropsFile: "inputs.json",
    pathOptions: { cwd, env: {} },
  });
  cleanup.push(server.close);
  const before = server.session();
  expect(await (await fetch(server.url + "/api/inputs")).json()).toMatchObject({
    enabled: true,
    path,
    inputProps: { title: "original" },
  });
  expect(
    (
      await post(server.url + "/api/inputs", {
        inputProps: { title: "unsupported" },
      })
    ).status,
  ).toBe(405);
  expect(await readFile(path, "utf8")).toBe('{"title":"original"}');
  await writeFile(path, '{"title":"from agent"}');
  expect(server.session()).toEqual(before);
  const refreshed = await post(server.url + "/api/refresh", {
    expectedSourceVersion: before.session.sourceVersion,
  });
  expect(refreshed.status).toBe(200);
  expect(await refreshed.json()).toMatchObject({
    inputProps: { title: "from agent" },
  });
});

it("rejects a prepared source superseded by an external input edit", async () => {
  const { cwd, config } = await fixture();
  await writeFile(join(cwd, "inputs.json"), '{"title":"original"}');
  const server = await createStudioServer(config, {
    inputPropsFile: "inputs.json",
    pathOptions: { cwd, env: {} },
  });
  cleanup.push(server.close);
  const before = server.session();
  const candidate = (await (
    await post(server.url + "/api/prepare-refresh", {
      expectedSourceVersion: before.session.sourceVersion,
    })
  ).json()) as ReturnType<typeof server.session>;
  await writeFile(join(cwd, "inputs.json"), '{"title":"changed"}');
  const commit = await post(server.url + "/api/commit-refresh", {
    expectedSourceVersion: before.session.sourceVersion,
    candidateSessionId: candidate.session.sessionId,
  });
  expect(commit.status).toBe(409);
  expect(await commit.json()).toMatchObject({
    code: "studio.candidate_stale",
  });
  expect(server.session()).toEqual(before);
});

it("advertises only explicit saved inputs and rejects generated or invalid props files", async () => {
  const { cwd, config } = await fixture();
  const server = await createStudioServer(config, {
    pathOptions: { cwd, env: {} },
  });
  cleanup.push(server.close);
  expect(await (await fetch(server.url + "/api/inputs")).json()).toEqual({
    enabled: false,
  });
  expect(
    await (await fetch(server.url + "/api/capabilities")).json(),
  ).toMatchObject({
    apiVersion: 1,
    operations: { inputs: "GET /api/inputs", clients: "GET /api/clients" },
    limits: { concurrentOutputs: 1 },
  });
  expect(
    (
      await post(server.url + "/api/inputs", {
        expectedSourceVersion: server.session().session.sourceVersion,
        expectedRevision: "",
        inputProps: {},
      })
    ).status,
  ).toBe(405);
  await writeFile(join(cwd, "dist/inputs.json"), "{}");
  await expect(
    createStudioServer(config, {
      inputPropsFile: "dist/inputs.json",
      pathOptions: { cwd, env: {} },
    }),
  ).rejects.toThrow("studio.inputs_overlap_source");
  await writeFile(join(cwd, "inputs.json"), "{}");
  const editable = await createStudioServer(config, {
    inputPropsFile: "inputs.json",
    pathOptions: { cwd, env: {} },
  });
  cleanup.push(editable.close);
  for (const value of [[], null, "string"]) {
    await writeFile(join(cwd, "inputs.json"), JSON.stringify(value));
    expect((await fetch(editable.url + "/api/inputs")).status).toBe(400);
  }
});

it.each([
  ["mp4", "video/mp4"],
  ["mov", "video/quicktime"],
  ["webm", "video/webm"],
  ["mkv", "video/x-matroska"],
] as const)(
  "studio range artifacts honor %s output and MIME type",
  async (container, mime) => {
    const { cwd, config } = await fixture();
    const server = await createStudioServer(
      { ...config, renderer: { ...config.renderer, container } },
      { pathOptions: { cwd, env: {} } },
      {
        runtimeAcquisition: {
          acquire: async () => ({
            binary: "native",
            env: {},
            source: "local" as const,
          }),
        },
        probeCapabilities: () => ({ available: true, outputApiVersion: 1 }),
        runRenderer: async (_binary, job) => nativeSuccess(job),
      },
    );
    cleanup.push(server.close);
    const response = await post(`${server.url}/api/jobs`, {
      compositionId: "scene",
      expectedSourceVersion: server.session().session.sourceVersion,
      range: { start: 0, end: 3 },
    });
    const job = await finishedJob(server.url, response);
    expect(job.status).toBe("succeeded");
    const artifact = job.result!;
    expect(artifact.url.endsWith(`.${container}`)).toBe(true);
    const file = await fetch(artifact.url);
    expect(file.headers.get("content-type")).toBe(mime);
    expect(await file.text()).toBe("complete output");
  },
);

it("serves installed UI and immutable instrumented project versions, refreshes without mutating authored files", async () => {
  const { cwd, config } = await fixture();
  const server = await createStudioServer(config, {
    pathOptions: { cwd, env: {} },
  });
  cleanup.push(server.close);
  expect((await fetch(server.url)).status).toBe(200);
  const before = server.session();
  const entry = await (await fetch(before.snapshotUrl)).text();
  expect(entry).toContain("original project");
  expect(entry).toContain("/__velocast-studio/bridge.js");
  expect(await readFile(join(cwd, "dist/index.html"), "utf8")).toBe(
    "<p>original project</p>",
  );
  const platform = await fetch(
    new URL("/__velocast-studio/config.js", before.snapshotUrl),
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
  const server = await createStudioServer(
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
  const frame = await post(server.url + "/api/jobs", {
    compositionId: "scene",
    frame: 12,
    expectedSourceVersion: version,
  });
  const frameJob = await finishedJob(server.url, frame);
  expect(frameJob.status).toBe("succeeded");
  const result = frameJob.result!;
  expect(result.outputPath).toMatch(/\.png$/);
  expect(await (await fetch(result.url)).text()).toBe("complete output");
  const range = await post(server.url + "/api/jobs", {
    compositionId: "scene",
    range: { start: 12, end: 18 },
    expectedSourceVersion: version,
  });
  expect((await finishedJob(server.url, range)).status).toBe("succeeded");
  expect((native.mock.calls[1]![1] as RustRenderJob).output_range).toEqual({
    startFrame: 12,
    endFrame: 18,
  });
  const calls = acquire.mock.calls.length;
  await writeFile(join(cwd, "dist/index.html"), "changed without refresh");
  const stale = await post(server.url + "/api/jobs", {
    compositionId: "scene",
    frame: 12,
    expectedSourceVersion: version,
  });
  expect(await finishedJob(server.url, stale)).toMatchObject({
    status: "failed",
    error: { code: "snapshot.version_mismatch" },
  });
  expect(acquire).toHaveBeenCalledTimes(calls);
  expect(await readFile(result.outputPath, "utf8")).toBe("complete output");
  await server.close();
  expect(await readFile(result.outputPath, "utf8")).toBe("complete output");
});

it("retains the valid snapshot after a failed source refresh", async () => {
  const { cwd, config } = await fixture();
  const server = await createStudioServer(config, {
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

it("joins lazy media acquisition cleanup before closing the studio", async () => {
  const { cwd, config } = await fixture();
  let started!: () => void;
  const acquiring = new Promise<void>((resolve) => {
    started = resolve;
  });
  let aborted!: () => void;
  const cancellation = new Promise<void>((resolve) => {
    aborted = resolve;
  });
  let finishCleanup!: () => void;
  const cleanupFinished = new Promise<void>((resolve) => {
    finishCleanup = resolve;
  });
  let joined = false;
  const createMediaService = vi.fn();
  const server = await createStudioServer(
    config,
    { pathOptions: { cwd, env: {} } },
    {
      runtimeAcquisition: {
        acquire: async (_binary, signal) => {
          started();
          await new Promise<void>((resolve) => {
            signal!.addEventListener("abort", () => resolve(), { once: true });
          });
          aborted();
          await cleanupFinished;
          joined = true;
          throw signal!.reason;
        },
      },
      createMediaService,
    },
  );
  cleanup.push(server.close);
  const request = fetch(
    new URL("/__velocast-media/frame", server.session().snapshotUrl),
  ).catch(() => undefined);
  let closed = false;
  let closing: Promise<void> | undefined;
  try {
    await acquiring;
    const closeStudio = server.close();
    expect(server.close()).toBe(closeStudio);
    closing = closeStudio.then(() => {
      closed = true;
    });
    await cancellation;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(closed).toBe(false);
    expect(joined).toBe(false);
    finishCleanup();
    await closing;
    expect(joined).toBe(true);
    expect(createMediaService).not.toHaveBeenCalled();
  } finally {
    finishCleanup();
    await closing;
    await request;
  }
});

it("stages a new source for browser validation and only replaces the active source on commit", async () => {
  const { cwd, config } = await fixture();
  const server = await createStudioServer(config, {
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

it.each([
  ["successful", []],
  ["active failure", [new Error("active media shutdown failed")]],
  ["undefined failure", [undefined]],
  [
    "both failures",
    [
      new Error("active media shutdown failed"),
      new Error("prepared media shutdown failed"),
    ],
  ],
] as const)(
  "keeps automatic source updates opt-out and closes snapshots after %s cleanup",
  async (_name, failures) => {
    const { cwd, config } = await fixture();
    const original = snapshotModule.createInputSnapshot;
    const spy = vi
      .spyOn(snapshotModule, "createInputSnapshot")
      .mockImplementation(async (options) => {
        const snapshot = await original(options);
        cleanup.push(snapshot.close);
        return snapshot;
      });
    let nextService = 0;
    const closeMedia = vi.fn(async (index: number) => {
      if (index < failures.length) throw failures[index];
    });
    try {
      const server = await createStudioServer(
        config,
        {
          autoRefresh: false,
          pathOptions: { cwd, env: {} },
        },
        {
          runtimeAcquisition: {
            acquire: async () => ({
              binary: "native",
              env: {},
              source: "local" as const,
            }),
          },
          createMediaService: () => {
            const index = nextService++;
            return {
              handle: async (_request, response) => {
                response.end("frame");
              },
              close: () => closeMedia(index),
            };
          },
        },
      );
      cleanup.push(() => server.close().catch(() => {}));
      const before = server.session();
      expect(before.autoRefresh).toBe(false);
      expect(
        await (await fetch(server.url + "/api/changes")).json(),
      ).toMatchObject({ enabled: false });
      const prepared = (await (
        await post(server.url + "/api/prepare-refresh", {
          expectedSourceVersion: before.session.sourceVersion,
        })
      ).json()) as ReturnType<typeof server.session>;
      for (const url of [before.snapshotUrl, prepared.snapshotUrl])
        await (await fetch(new URL("/__velocast-media/frame", url))).text();
      const closing = server.close();
      expect(server.close()).toBe(closing);
      if (failures.length === 0) await closing;
      else if (failures.length === 1)
        await expect(closing).rejects.toBe(failures[0]);
      else
        await expect(closing).rejects.toMatchObject({
          errors: [...failures],
          message:
            "studio.cleanup_failed: active media shutdown failed; prepared media shutdown failed",
        });
      expect(closeMedia).toHaveBeenCalledTimes(2);
      for (const url of [server.url, before.snapshotUrl, prepared.snapshotUrl])
        await expect(
          fetch(url).then((response) => response.text()),
        ).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
  },
);

it("expires an abandoned prepared snapshot while retaining the active source", async () => {
  const { cwd, config } = await fixture();
  const server = await createStudioServer(
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

import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { previewCommand } from "./preview-command.js";
import { createPreviewServer } from "./preview-server.js";
import type { RustRenderJob } from "./render-command-job.js";
import { failedOutputResult } from "./output-result.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

it("serializes the default preview range job with its actual wire pixel format", async () => {
  const cwd = await projectFixture();
  const report = join(cwd, "evidence/report.json");
  const events = join(cwd, "evidence/events.jsonl");
  const jobs: RustRenderJob[] = [];
  const server = await createPreviewServer(
    {
      entry: "dist/index.html",
      renderer: {
        snapshotRoot: "dist",
        reportPath: report,
        eventLogPath: events,
      },
    },
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
      runRenderer: async (_binary, value) => {
        const job = value as RustRenderJob;
        jobs.push(structuredClone(job));
        await nativeSuccess(job);
      },
    },
  );
  cleanup.push(server.close);
  const response = await post(server.url + "/api/output", {
    compositionId: "scene",
    expectedSourceVersion: server.session().session.sourceVersion,
    range: { start: 10, end: 15 },
  });
  expect(response.status).toBe(200);
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({
    mode: "composition",
    composition_id: "scene",
    pixel_format: "nv12",
    acceleration: "auto",
    assembly_mode: "reference",
    concurrency: 1,
    output_range: { startFrame: 10, endFrame: 15 },
    report_path: report,
    event_log_path: events,
  });
  expect(jobs[0]!.operation).toBeUndefined();
  await writeFile(
    join(cwd, "wire-job.json"),
    JSON.stringify(jobs[0], null, 2),
  );
  expect(
    JSON.parse(await readFile(join(cwd, "wire-job.json"), "utf8")),
  ).toEqual(jobs[0]);
});

it("terminates a persistent watch child and closes the server on cancellation", async () => {
  const cwd = await tempDir("velocast-preview-watch-");
  const script = join(cwd, "watch.mjs");
  const pidPath = join(cwd, "watch.pid");
  await writeFile(
    script,
    `import {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(pidPath)},String(process.pid));setInterval(()=>{},1000);`,
  );
  const controller = new AbortController();
  const close = vi.fn(async () => {});
  const before = [
    process.listenerCount("SIGINT"),
    process.listenerCount("SIGTERM"),
  ];
  await previewCommand(
    {},
    {
      signal: controller.signal,
      watchCommand: quoteCommand(process.execPath, script),
    },
    {
      createServer: async () => {
        await waitForFile(pidPath);
        return {
          url: "http://127.0.0.1:12345",
          close,
          session: () => ({
            snapshotUrl: "http://127.0.0.1:23456/index.html",
            session: { sessionId: "watch", sourceVersion: "a".repeat(64) },
          }),
        };
      },
      write: () => controller.abort(),
    },
  );
  const pid = Number(await readFile(pidPath, "utf8"));
  await expectProcessExit(pid);
  expect(close).toHaveBeenCalledTimes(1);
  expect([
    process.listenerCount("SIGINT"),
    process.listenerCount("SIGTERM"),
  ]).toEqual(before);
});

it("closes the server and reports a watch process that exits unexpectedly", async () => {
  const cwd = await tempDir("velocast-preview-watch-exit-");
  const script = join(cwd, "watch-exit.mjs");
  await writeFile(script, "setTimeout(()=>process.exit(7),50);");
  const close = vi.fn(async () => {});
  await expect(
    previewCommand(
      {},
      { watchCommand: quoteCommand(process.execPath, script) },
      {
        createServer: async () => ({
          url: "http://127.0.0.1:12345",
          close,
          session: () => ({
            snapshotUrl: "http://127.0.0.1:23456/index.html",
            session: { sessionId: "watch", sourceVersion: "b".repeat(64) },
          }),
        }),
        write: () => {},
      },
    ),
  ).rejects.toThrow("preview.watch_exited: build watcher exited 7");
  expect(close).toHaveBeenCalledTimes(1);
});

async function projectFixture(): Promise<string> {
  const cwd = await tempDir("velocast-preview-wire-job-");
  await mkdir(join(cwd, "dist"));
  await mkdir(join(cwd, "evidence"));
  await writeFile(join(cwd, "dist/index.html"), "<p>fixture</p>");
  return cwd;
}

async function tempDir(prefix: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

async function nativeSuccess(job: RustRenderJob): Promise<void> {
  await writeFile(job.output, "complete output");
  await writeFile(
    job.result_path!,
    JSON.stringify({
      ...failedOutputResult(job, "pending"),
      status: "success",
      error: null,
      composition: {
        id: "scene",
        width: 320,
        height: 180,
        fps: 30,
        durationFrames: 60,
      },
      compositions: [],
      request: {
        compositionId: "scene",
        frame: null,
        range: job.output_range,
      },
    }),
  );
}

function post(url: string, data: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
}

function quoteCommand(...parts: string[]): string {
  return parts.map((part) => `"${part.replaceAll('"', '\\"')}"`).join(" ");
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`watch did not create ${path}`);
}

async function expectProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`watch process ${pid} is still running`);
}

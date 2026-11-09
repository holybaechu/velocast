import { afterEach, expect, it } from "vitest";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStudioServer } from "../studio/studio-server.js";

const cleanup: Array<() => Promise<unknown>> = [];
function sourceRevision(value: unknown): string {
  if (
    !value ||
    typeof value !== "object" ||
    !("revision" in value) ||
    typeof value.revision !== "string"
  )
    throw new Error("Source result must include its saved revision");
  return value.revision;
}
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it("animates through real guarded source writes and confirms the exact build and browser revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "velocast-mcp-edit-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"));
  await mkdir(join(root, "dist"));
  const original = `import {Layer} from '@velocast/react';\n// Preserve the human note\nexport const Demo=()=> <Layer id="title" x={10}>Hello</Layer>;`;
  const sourcePath = join(root, "src/demo.jsx");
  const hash = (text: string) =>
    createHash("sha256").update(text).digest("hex");
  await writeFile(sourcePath, original);
  await writeFile(join(root, "dist/index.html"), "<main>Built</main>");
  await writeFile(
    join(root, "dist/_velocast-sources.json"),
    JSON.stringify({ version: 1, revisions: { demo: hash(original) } }),
  );
  const studio = await createStudioServer(
    {
      entry: "dist/index.html",
      renderer: { snapshotRoot: "dist" },
      studio: { sources: { demo: "src/demo.jsx" } },
    },
    { pathOptions: { cwd: root, env: {} } },
  );
  cleanup.push(studio.close);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      fileURLToPath(new URL("../bin.ts", import.meta.url)),
      "mcp",
      "--url",
      studio.url,
    ],
    stderr: "pipe",
  });
  const client = new Client({ name: "velocast-edit-test", version: "1.0.0" });
  cleanup.push(() => client.close());
  await client.connect(transport);
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args });
  const guard = {
    compositionId: "demo",
    expectedRevision: hash(original),
    expectedSourceVersion: studio.session().session.sourceVersion,
  };
  const saved = await call("studio_animate", {
    ...guard,
    elementId: "title",
    property: "opacity",
    action: "set",
    keyframes: [
      { frame: 0, value: 0 },
      { frame: 15, value: 1 },
    ],
    easing: "easeOut",
  });
  expect(saved.isError).not.toBe(true);
  expect(saved.structuredContent).toMatchObject({
    receipt: { stage: "saved", changed: true },
  });
  const firstRevision = sourceRevision(saved.structuredContent);
  expect(await readFile(sourcePath, "utf8")).toContain(
    "// Preserve the human note",
  );
  const stale = await call("studio_animate", {
    ...guard,
    elementId: "title",
    property: "opacity",
    action: "remove",
  });
  expect(stale.isError).toBe(true);
  const changed = await call("studio_animate", {
    ...guard,
    expectedRevision: firstRevision,
    elementId: "title",
    property: "opacity",
    action: "keyframe",
    frame: 7,
    value: 0.4,
  });
  expect(changed.isError).not.toBe(true);
  const revision = sourceRevision(changed.structuredContent);
  expect(
    (
      await call("studio_wait_for_build", {
        compositionId: "demo",
        revision: firstRevision,
        waitMs: 0,
      })
    ).structuredContent,
  ).toMatchObject({ stage: "superseded" });
  const bytes = await readFile(sourcePath, "utf8");
  await writeFile(
    join(root, "dist/_velocast-sources.json"),
    JSON.stringify({ version: 1, revisions: { demo: revision } }),
  );
  const post = async (path: string, body: unknown) =>
    (
      await fetch(studio.url + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    ).json();
  const candidate = await post("/api/prepare-refresh", {
    expectedSourceVersion: guard.expectedSourceVersion,
  });
  await post("/api/commit-refresh", {
    expectedSourceVersion: guard.expectedSourceVersion,
    candidateSessionId: candidate.session.sessionId,
  });
  expect(
    (
      await call("studio_wait_for_build", {
        compositionId: "demo",
        revision,
        waitMs: 0,
      })
    ).structuredContent,
  ).toMatchObject({ stage: "built" });
  const state = {
    revision: 1,
    sourceVersion: studio.session().session.sourceVersion,
    compositions: [
      { id: "demo", width: 320, height: 180, fps: 30, durationFrames: 30 },
    ],
    compositionId: "demo",
    frame: 7,
    sourceRevision: revision,
    dirty: false,
    ready: true,
    exportReady: true,
    playing: false,
  };
  await post("/api/clients/browser", { state });
  expect(
    (
      await call("studio_wait_for_build", {
        compositionId: "demo",
        revision,
        clientId: "browser",
        waitMs: 0,
      })
    ).structuredContent,
  ).toMatchObject({ stage: "displayed", frame: 7, clientRevision: 1 });
  const inspected = call("studio_inspect", {
    compositionId: "demo",
    elementId: "title",
    clientId: "browser",
    expectedRevision: 1,
    expectedSourceVersion: state.sourceVersion,
  });
  let commands: { id: string }[] = [];
  for (let attempt = 0; attempt < 50 && !commands.length; attempt++) {
    commands = (await post("/api/clients/browser", { state })).commands;
    if (!commands.length)
      await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(commands).toHaveLength(1);
  await post("/api/clients/browser", {
    state,
    acknowledgements: [
      {
        id: commands[0]!.id,
        status: "succeeded",
        inspection: {
          selector: '[data-velocast-layer="title"]',
          elementId: "title",
          tag: "div",
          text: "Hello",
          matchCount: 1,
          depth: 0,
          childCount: 0,
          bounds: { x: 10, y: 0, width: 200, height: 40 },
          styles: { opacity: "0.4", color: "rgb(0, 0, 0)" },
        },
      },
    ],
  });
  const result = await inspected;
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({
    element: { id: "title", runtime: { text: "Hello", bounds: { x: 10 } } },
  });
  expect(await readFile(sourcePath, "utf8")).toBe(bytes);
}, 30_000);

it("connects a real MCP client, discovers tools, and reads live Studio context through stdio", async () => {
  const http = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/session")
      response.end(
        JSON.stringify({
          session: { sourceVersion: "build-1" },
          codeRevisions: { demo: "hash" },
        }),
      );
    else if (request.url === "/api/clients")
      response.end(
        JSON.stringify({
          clients: [
            {
              clientId: "browser-a",
              revision: 4,
              sourceVersion: "build-1",
              compositionId: "demo",
              frame: 18,
              selectedElementId: "title",
              dirty: false,
              ready: true,
              exportReady: true,
              playing: false,
            },
          ],
        }),
      );
    else {
      response.statusCode = 404;
      response.end(
        JSON.stringify({ code: "studio.not_found", message: "Unknown route" }),
      );
    }
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) => {
        http.closeAllConnections();
        http.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = http.address();
  if (!address || typeof address === "string") throw Error("No port");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      fileURLToPath(new URL("../bin.ts", import.meta.url)),
      "mcp",
      "--url",
      `http://127.0.0.1:${address.port}`,
    ],
    stderr: "pipe",
  });
  const client = new Client({
    name: "velocast-integration-test",
    version: "1.0.0",
  });
  cleanup.push(() => client.close());
  await client.connect(transport);
  expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
    expect.arrayContaining([
      "studio_context",
      "studio_control",
      "studio_source",
      "studio_edit",
      "studio_frame",
      "studio_render",
      "studio_job",
      "studio_inspect",
      "studio_animate",
      "studio_wait_for_build",
    ]),
  );
  const result = await client.callTool({
    name: "studio_context",
    arguments: { clientId: "browser-a" },
  });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({
    client: { clientId: "browser-a", frame: 18, selectedElementId: "title" },
  });
  const invalid = await client.callTool({
    name: "studio_context",
    arguments: { clientId: "missing" },
  });
  expect(invalid.isError).toBe(true);
}, 20_000);

it("preserves guarded source requests, exact-frame images, job errors, and cancellation through a real client", async () => {
  const requests: Array<{ path: string; body: unknown }> = [];
  let origin = "";
  let status = "running";
  let pollFailure = false;
  let capturePending = false;
  const request = {
    compositionId: "demo",
    expectedSourceVersion: "build-1",
    frame: 18,
  };
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jwwAAAABJRU5ErkJggg==",
    "base64",
  );
  const http = createServer(async (req, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : undefined;
    const path = req.url ?? "";
    requests.push({ path, body });
    response.setHeader("content-type", "application/json");
    const job = () => ({
      id: "job-1",
      status,
      request,
      ...(status === "succeeded"
        ? {
            result: {
              outputPath: "/output/frame.png",
              url: origin + "/artifacts/frame.png",
            },
          }
        : {}),
    });
    if (path === "/api/clients")
      response.end(
        JSON.stringify({
          clients: [
            {
              clientId: "tab",
              revision: 4,
              sourceVersion: "build-1",
              compositionId: "demo",
              frame: 18,
              ready: true,
              playing: false,
              dirty: false,
              exportReady: true,
            },
          ],
        }),
      );
    else if (path.startsWith("/api/code?"))
      response.end(
        JSON.stringify({
          enabled: true,
          revision: "new-source",
          displayedRevision: "old-source",
        }),
      );
    else if (path === "/api/code") {
      response.statusCode = 409;
      response.end(
        JSON.stringify({
          code: "studio.code_stale",
          message: "Source changed; reload before saving",
        }),
      );
    } else if (path === "/api/code/replace")
      response.end(JSON.stringify({ revision: "new-hash", canUndo: true }));
    else if (path === "/api/jobs" && req.method === "POST")
      response.end(JSON.stringify(job()));
    else if (path === "/api/jobs")
      response.end(
        JSON.stringify({
          jobs: status === "succeeded" || capturePending ? [job()] : [],
        }),
      );
    else if (path === "/api/jobs/job-1") {
      if (pollFailure) {
        response.statusCode = 503;
        response.end(
          JSON.stringify({
            code: "studio.test_connection",
            message: "Temporary polling failure",
          }),
        );
      } else response.end(JSON.stringify(job()));
    } else if (path === "/api/jobs/job-1/cancel") {
      status = "cancelled";
      response.end(JSON.stringify(job()));
    } else if (path === "/artifacts/frame.png") {
      response.setHeader("content-type", "image/png");
      response.end(png);
    } else {
      response.statusCode = 404;
      response.end(
        JSON.stringify({ code: "studio.not_found", message: "Unknown route" }),
      );
    }
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) => {
        http.closeAllConnections();
        http.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = http.address();
  if (!address || typeof address === "string") throw Error("No port");
  origin = `http://127.0.0.1:${address.port}`;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      fileURLToPath(new URL("../bin.ts", import.meta.url)),
      "mcp",
      "--url",
      origin,
    ],
    stderr: "pipe",
  });
  const client = new Client({
    name: "velocast-workflow-test",
    version: "1.0.0",
  });
  cleanup.push(() => client.close());
  await client.connect(transport);
  const stale = await client.callTool({
    name: "studio_edit",
    arguments: {
      compositionId: "demo",
      expectedSourceVersion: "build-1",
      expectedRevision: "old-hash",
      edits: [{ id: "title", field: "text", value: "Changed" }],
    },
  });
  expect(stale).toMatchObject({
    isError: true,
    structuredContent: { code: "studio.code_stale" },
  });
  const source = "export default () => <div>Custom code</div>;";
  const replaced = await client.callTool({
    name: "studio_replace_source",
    arguments: {
      compositionId: "demo",
      expectedSourceVersion: "build-1",
      expectedRevision: "hash",
      source,
    },
  });
  expect(replaced.structuredContent).toMatchObject({
    revision: "new-hash",
    canUndo: true,
  });
  expect(
    requests.find((item) => item.path === "/api/code/replace")?.body,
  ).toEqual({
    compositionId: "demo",
    expectedSourceVersion: "build-1",
    expectedRevision: "hash",
    source,
  });
  const started = await client.callTool({
    name: "studio_render",
    arguments: request,
  });
  expect(started.structuredContent).toMatchObject({
    id: "job-1",
    status: "running",
  });
  const unbuilt = await client.callTool({
    name: "studio_render",
    arguments: { ...request, clientId: "tab", expectedRevision: 4 },
  });
  expect(unbuilt).toMatchObject({
    isError: true,
    structuredContent: { code: "studio.source_not_built" },
  });
  const waiting = await client.callTool({
    name: "studio_job",
    arguments: { id: "job-1", action: "wait", waitMs: 1 },
  });
  expect(waiting.structuredContent).toMatchObject({ status: "running" });
  const cancelled = await client.callTool({
    name: "studio_job",
    arguments: { id: "job-1", action: "cancel" },
  });
  expect(cancelled.structuredContent).toMatchObject({ status: "cancelled" });
  status = "running";
  capturePending = true;
  pollFailure = true;
  const pendingFrame = await client.callTool({
    name: "studio_frame",
    arguments: { clientId: "tab", expectedRevision: 4 },
  });
  expect(pendingFrame.isError).not.toBe(true);
  expect(pendingFrame.structuredContent).toMatchObject({
    job: { id: "job-1", status: "running" },
    pollError: { code: "studio.test_connection" },
  });
  expect(
    (
      await client.callTool({
        name: "studio_job",
        arguments: { action: "list" },
      })
    ).structuredContent,
  ).toMatchObject({ jobs: [{ id: "job-1", status: "running" }] });
  pollFailure = false;
  status = "succeeded";
  const captured = await client.callTool({
    name: "studio_frame",
    arguments: { clientId: "tab", expectedRevision: 4 },
  });
  expect(captured.content).toEqual(
    expect.arrayContaining([
      { type: "image", mimeType: "image/png", data: png.toString("base64") },
    ]),
  );
  expect(captured.structuredContent).toMatchObject({
    outputPath: "/output/frame.png",
    client: { frame: 18, sourceVersion: "build-1" },
  });
  expect(
    requests.filter((item) => item.path === "/api/jobs" && item.body),
  ).toHaveLength(1);
  const untargeted = await client.callTool({
    name: "studio_render",
    arguments: { ...request, expectedRevision: 4 },
  });
  expect(untargeted).toMatchObject({
    isError: true,
    structuredContent: { code: "studio.client_revision" },
  });
  await client.close();
  expect((await fetch(origin + "/api/jobs")).ok).toBe(true);
}, 20_000);

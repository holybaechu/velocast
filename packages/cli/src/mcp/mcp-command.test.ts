import { afterEach, expect, it } from "vitest";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { once } from "node:events";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

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
        JSON.stringify({ jobs: status === "succeeded" ? [job()] : [] }),
      );
    else if (path === "/api/jobs/job-1") response.end(JSON.stringify(job()));
    else if (path === "/api/jobs/job-1/cancel") {
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

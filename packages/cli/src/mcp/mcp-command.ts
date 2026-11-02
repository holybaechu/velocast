import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import type { CodeSource, StudioClient } from "@velocast/core";
import type { StudioJob } from "../studio/studio-server.js";

export interface McpOptions {
  url?: string;
}
const id = z.string().min(1).max(256);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const guard = {
  compositionId: id,
  expectedSourceVersion: id,
  expectedRevision: id,
};
type Result = {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
const result = (value: Record<string, unknown>): Result => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value,
});
async function report(operation: () => Promise<Result>): Promise<Result> {
  try {
    return await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...result({
        code: message.match(/^([a-z][\w.]+):/)?.[1] ?? "studio.agent_failed",
        message,
      }),
      isError: true,
    };
  }
}

function studioOrigin(value?: string): string {
  let url: URL;
  try {
    url = new URL(value ?? "");
  } catch {
    throw new Error(
      "studio.agent_url: use mcp --url with the running Studio URL",
    );
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "studio.agent_url: expected http://127.0.0.1:<port> for a trusted local Studio",
    );
  return url.origin;
}

/** A bounded adapter over the same HTTP operations used by Studio. */
export function createStudioMcpServer(origin: string): McpServer {
  origin = studioOrigin(origin);
  const version = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ).version as string;
  const server = new McpServer(
    { name: "velocast-studio", version },
    {
      instructions:
        "Use studio_context to discover browser clients. Target a client explicitly for controls and re-read context after conflicts. Source files are authoritative; source edits still require a successful project build. Use studio_frame to inspect exact rendered pixels, then render and wait for a terminal job status. Changes to arbitrary project files remain available through your own source editor. This connection runs no model and grants no arbitrary shell execution.",
    },
  );
  async function request<T = Record<string, unknown>>(
    path: string,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(origin + "/api/" + path, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      redirect: "error",
    });
    const value = await response.json();
    if (!response.ok)
      throw new Error(
        `${value.code ?? "studio.agent_http"}: ${value.message ?? response.status}`,
      );
    return value as T;
  }
  async function clientContext(
    clientId: string,
    expectedRevision: number | undefined,
    signal: AbortSignal,
  ): Promise<StudioClient> {
    const { clients } = await request<{ clients: StudioClient[] }>(
      "clients",
      signal,
    );
    const client = clients.find((item) => item.clientId === clientId);
    if (!client)
      throw new Error(
        "studio.client_disconnected: open Studio and choose a current clientId from studio_context",
      );
    if (expectedRevision !== undefined && client.revision !== expectedRevision)
      throw new Error(
        "studio.client_stale: browser state changed; read context before retrying",
      );
    return client;
  }
  async function waitJob(
    job: StudioJob,
    milliseconds: number,
    signal: AbortSignal,
  ): Promise<StudioJob> {
    const deadline = Date.now() + milliseconds;
    while (
      ["running", "cancelling"].includes(job.status) &&
      Date.now() < deadline
    ) {
      await delay(
        Math.min(250, Math.max(1, deadline - Date.now())),
        undefined,
        { signal },
      );
      job = await request<StudioJob>(
        "jobs/" + encodeURIComponent(job.id),
        signal,
      );
    }
    return job;
  }
  const readOnly = { readOnlyHint: true, openWorldHint: false };
  const mutation = {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  };
  server.registerTool(
    "studio_context",
    {
      description:
        "Read the saved build and live browser state: exact presented frame, selection, dirty edits and errors. Omit clientId to list tabs; controls require an explicit tab.",
      inputSchema: z.strictObject({ clientId: id.optional() }),
      annotations: readOnly,
    },
    ({ clientId }, ctx) =>
      report(async () => {
        const session = await request("session", ctx.mcpReq.signal);
        const { clients } = await request<{ clients: StudioClient[] }>(
          "clients",
          ctx.mcpReq.signal,
        );
        const saved = {
          session: session.session,
          codeRevisions: session.codeRevisions,
        };
        if (!clientId) return result({ ...saved, clients });
        const client = clients.find((item) => item.clientId === clientId);
        if (!client)
          throw new Error(
            "studio.client_disconnected: requested browser is not connected",
          );
        return result({ ...saved, client });
      }),
  );
  server.registerTool(
    "studio_source",
    {
      description:
        "Inspect mapped source fields, editability reasons, revision, undo and recovery state. Request includeSource only when you need the complete file text.",
      inputSchema: z.strictObject({
        compositionId: id,
        includeSource: z.boolean().optional(),
      }),
      annotations: readOnly,
    },
    ({ compositionId, includeSource }, ctx) =>
      report(async () =>
        result(
          await request(
            `code?compositionId=${encodeURIComponent(compositionId)}${includeSource ? "&includeSource=true" : ""}`,
            ctx.mcpReq.signal,
          ),
        ),
      ),
  );
  server.registerTool(
    "studio_control",
    {
      description:
        "Play, pause, seek, select a source element, or switch composition in one explicit Studio browser. Requires its current revision and source version; pause tolerates advancing playback revisions. Waits for browser acknowledgement.",
      inputSchema: z.strictObject({
        clientId: id,
        expectedRevision: integer,
        expectedSourceVersion: id,
        action: z.enum(["play", "pause", "seek", "select", "composition"]),
        frame: integer.optional(),
        elementId: id.optional(),
        compositionId: id.optional(),
      }),
      annotations: mutation,
    },
    (args, ctx) =>
      report(async () =>
        result(await request("control", ctx.mcpReq.signal, args)),
      ),
  );
  server.registerTool(
    "studio_edit",
    {
      description:
        "Save supported literal edits to mapped JSX/TSX using the same guarded writer and durable undo as direct Studio controls. Rebuild before inspecting the result.",
      inputSchema: z.strictObject({
        ...guard,
        edits: z
          .array(
            z.strictObject({
              id,
              field: id,
              value: z.union([z.string(), z.number(), z.boolean()]),
            }),
          )
          .min(1)
          .max(100),
      }),
      annotations: mutation,
    },
    (args, ctx) =>
      report(async () =>
        result(await request("code", ctx.mcpReq.signal, args)),
      ),
  );
  server.registerTool(
    "studio_replace_source",
    {
      description:
        "Replace one explicitly mapped source file with a complete UTF-8 source string. Preserves recoverable versions and rejects stale revisions. Use for custom code beyond literal controls; this is trusted project code, not sandboxed execution.",
      inputSchema: z.strictObject({
        ...guard,
        source: z.string().max(1024 * 1024),
      }),
      annotations: mutation,
    },
    (args, ctx) =>
      report(async () =>
        result(await request("code/replace", ctx.mcpReq.signal, args)),
      ),
  );
  server.registerTool(
    "studio_history",
    {
      description:
        "Undo/redo a mapped source edit, or recover an interrupted write. Undo/redo require the current file revision. Recovery never overwrites an externally created source file.",
      inputSchema: z.strictObject({
        compositionId: id,
        expectedSourceVersion: id,
        expectedRevision: id.optional(),
        action: z.enum(["undo", "redo", "recover"]),
      }),
      annotations: mutation,
    },
    ({ action, ...args }, ctx) =>
      report(async () =>
        result(
          await request(
            action === "recover" ? "code/recover" : "code/history",
            ctx.mcpReq.signal,
            action === "recover" ? args : { ...args, action },
          ),
        ),
      ),
  );
  server.registerTool(
    "studio_render",
    {
      description:
        "Start an exact frame or exclusive-end range export from the saved build. Returns a job immediately; use studio_job to wait/cancel. Supply clientId and expectedRevision to require the browser to be clean and export-ready.",
      inputSchema: z.strictObject({
        compositionId: id,
        expectedSourceVersion: id,
        frame: integer.optional(),
        range: z.strictObject({ start: integer, end: integer }).optional(),
        clientId: id.optional(),
        expectedRevision: integer.optional(),
      }),
      annotations: mutation,
    },
    ({ clientId, expectedRevision, ...args }, ctx) =>
      report(async () => {
        if (!clientId && expectedRevision !== undefined)
          throw new Error(
            "studio.client_revision: expectedRevision requires an explicit clientId",
          );
        if (clientId) {
          if (expectedRevision === undefined)
            throw new Error(
              "studio.client_revision: expectedRevision is required with clientId",
            );
          const client = await clientContext(
            clientId,
            expectedRevision,
            ctx.mcpReq.signal,
          );
          if (
            !client.exportReady ||
            client.sourceVersion !== args.expectedSourceVersion ||
            client.compositionId !== args.compositionId
          )
            throw new Error(
              "studio.client_not_ready: save or discard drafts, fix errors, and wait for the completed build before export",
            );
          const source = await request<CodeSource>(
            `code?compositionId=${encodeURIComponent(args.compositionId)}`,
            ctx.mcpReq.signal,
          );
          if (
            source.enabled &&
            (source.recoveryRequired ||
              source.syntaxError ||
              !source.revision ||
              source.revision !== source.displayedRevision ||
              source.revision !== client.sourceRevision)
          )
            throw new Error(
              "studio.source_not_built: saved source differs from the displayed build; wait for a successful build and refresh, then read context again",
            );
        }
        return result(await request("jobs", ctx.mcpReq.signal, args));
      }),
  );
  server.registerTool(
    "studio_job",
    {
      description:
        "Read, wait for, or cancel a Studio render job. Waiting returns after at most 30 seconds with an explicit status; repeat if still running. Cancelling waits for owned work to stop. Disconnecting this MCP client does not cancel exports.",
      inputSchema: z.strictObject({
        id,
        action: z.enum(["status", "wait", "cancel"]).default("status"),
        waitMs: z.number().int().min(0).max(30_000).default(10_000),
      }),
      annotations: mutation,
    },
    ({ id: jobId, action, waitMs }, ctx) =>
      report(async () => {
        let job = await request<StudioJob>(
          `jobs/${encodeURIComponent(jobId)}${action === "cancel" ? "/cancel" : ""}`,
          ctx.mcpReq.signal,
          action === "cancel" ? {} : undefined,
        );
        if (action === "wait")
          job = await waitJob(job, waitMs, ctx.mcpReq.signal);
        return result({ ...job });
      }),
  );
  server.registerTool(
    "studio_frame",
    {
      description:
        "Return an exact rendered PNG of the frame presented in a selected browser. Requires its current revision and a paused ready frame. Reuses a completed matching frame job; pending capture returns its job ID. Reports dirty/source state so an old displayed frame is not mistaken for a new edit.",
      inputSchema: z.strictObject({ clientId: id, expectedRevision: integer }),
      annotations: mutation,
    },
    ({ clientId, expectedRevision }, ctx) =>
      report(async () => {
        const client = await clientContext(
          clientId,
          expectedRevision,
          ctx.mcpReq.signal,
        );
        if (
          !client.ready ||
          client.playing ||
          client.frame === undefined ||
          !client.compositionId
        )
          throw new Error(
            "studio.client_not_ready: pause at a ready frame before capturing it",
          );
        const { jobs } = await request<{ jobs: StudioJob[] }>(
          "jobs",
          ctx.mcpReq.signal,
        );
        let job = jobs.find(
          (item) =>
            item.status === "succeeded" &&
            item.request.compositionId === client.compositionId &&
            item.request.frame === client.frame &&
            item.request.expectedSourceVersion === client.sourceVersion,
        );
        job ??= await request<StudioJob>("jobs", ctx.mcpReq.signal, {
          compositionId: client.compositionId,
          expectedSourceVersion: client.sourceVersion,
          frame: client.frame,
        });
        job = await waitJob(job, 25_000, ctx.mcpReq.signal);
        if (job.status !== "succeeded") return result({ job, client });
        if (!job.result)
          throw new Error(
            "studio.frame_missing: completed frame has no output",
          );
        const url = new URL(job.result.url);
        if (
          url.origin !== origin ||
          !url.pathname.startsWith("/artifacts/") ||
          !url.pathname.endsWith(".png")
        )
          throw new Error("studio.frame_url: unexpected frame artifact URL");
        const response = await fetch(url, {
          signal: AbortSignal.any([
            ctx.mcpReq.signal,
            AbortSignal.timeout(15_000),
          ]),
          redirect: "error",
        });
        if (
          !response.ok ||
          response.headers.get("content-type") !== "image/png"
        )
          throw new Error("studio.frame_read: could not read the frame PNG");
        if (Number(response.headers.get("content-length")) > 16 * 1024 * 1024)
          throw new Error(
            "studio.frame_limit: image exceeds 16 MiB; use its outputPath",
          );
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > 16 * 1024 * 1024)
          throw new Error(
            "studio.frame_limit: image exceeds 16 MiB; use its outputPath",
          );
        const metadata = {
          jobId: job.id,
          outputPath: job.result.outputPath,
          client,
        };
        return {
          ...result(metadata),
          content: [
            {
              type: "image",
              data: bytes.toString("base64"),
              mimeType: "image/png",
            },
            { type: "text", text: JSON.stringify(metadata) },
          ],
        };
      }),
  );
  return server;
}

export async function mcpCommand(options: McpOptions): Promise<void> {
  const origin = studioOrigin(options.url);
  const handle = serveStdio(() => createStudioMcpServer(origin), {
    onerror: (error) => process.stderr.write(`${error.message}\n`),
  });
  await new Promise<void>((resolve, reject) => {
    const stop = () => {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      process.removeListener("disconnect", stop);
      process.stdin.removeListener("end", stop);
      void handle.close().then(resolve, reject);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    process.once("disconnect", stop);
    process.stdin.once("end", stop);
  });
}

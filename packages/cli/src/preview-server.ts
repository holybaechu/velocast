import { createHash, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createRequire } from "node:module";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { dirname, extname, isAbsolute, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Config } from "@velocast/core";
import { BROWSER_PROTOCOL_VERSION } from "./generated/renderer-contracts.js";
import {
  executeRendererJob,
  type RendererRunDependencies,
} from "./commands.js";
import { createInputSnapshot, type InputSnapshot } from "./input-snapshot.js";
import {
  createVideoFrameHttp,
  type VideoFrameHttp,
} from "./video-frame-http.js";
import { RendererRuntimeAcquisition } from "./renderer-runtime.js";
import { resolveCompositionRenderSource } from "./render-source.js";
import {
  resolveCliInputPropsPath,
  resolveCliOutputPath,
  type InvocationPathOptions,
} from "./paths.js";
import type { OutputResult } from "./output-result.js";
import { isObjectRecord } from "./internal/validation.js";
import { previewSourceRevision } from "./preview-source-revision.js";

interface PreviewAssets {
  entryScript: string;
  platform: Record<string, Uint8Array>;
  ui: Map<string, Buffer>;
}
export interface PreviewServerOptions {
  autoRefresh?: boolean;
  inputPropsFile?: string;
  outputDirectory?: string;
  port?: number;
  pathOptions?: InvocationPathOptions;
  signal?: AbortSignal;
}
export interface PreviewServerDependencies extends RendererRunDependencies {
  /** Tests/pack consumers may select an installed preview dist directory explicitly. */
  assetsDirectory?: string;
  /** Bounded candidate lease; tests may shorten it without running an expiry minute. */
  preparedLifetimeMs?: number;
}
export interface PreviewServer {
  url: string;
  session(): {
    snapshotUrl: string;
    session: InputSnapshot["session"];
    inputProps?: unknown;
    sourceRevision?: string;
    autoRefresh?: boolean;
    stagedRefresh?: boolean;
  };
  close(): Promise<void>;
}

async function readAssets(directory?: string): Promise<PreviewAssets> {
  const root =
    directory ??
    dirname(createRequire(import.meta.url).resolve("@velocast/preview"));
  const manifest = JSON.parse(
    await readFile(join(root, "platform/manifest.json"), "utf8"),
  );
  if (
    !isObjectRecord(manifest) ||
    manifest.browserProtocolVersion !== BROWSER_PROTOCOL_VERSION ||
    manifest.rpcProtocolVersion !== 1 ||
    !Array.isArray(manifest.assets) ||
    manifest.assets.length > 64 ||
    typeof manifest.entryScript !== "string" ||
    !isObjectRecord(manifest.sha256)
  )
    throw new Error(
      "preview.assets_incompatible: installed preview assets do not match the browser protocol",
    );
  const platform: Record<string, Uint8Array> = {};
  for (const name of manifest.assets) {
    if (typeof name !== "string" || !/^[a-zA-Z0-9_-]+\.js$/.test(name))
      throw new Error("preview.assets_invalid: invalid platform module name");
    const bytes = await readFile(join(root, "platform", name));
    if (
      createHash("sha256").update(bytes).digest("hex") !== manifest.sha256[name]
    )
      throw new Error(
        "preview.assets_corrupt: platform module checksum differs",
      );
    platform[name] = bytes;
  }
  if (!(manifest.entryScript in platform))
    throw new Error("preview.assets_invalid: entry module is missing");
  const ui = new Map<string, Buffer>();
  let bytes = 0;
  const scan = async (path: string, prefix = "") => {
    for (const item of await readdir(path, { withFileTypes: true })) {
      if (item.isSymbolicLink())
        throw new Error(
          "preview.assets_invalid: linked UI assets are not allowed",
        );
      const name = prefix + item.name;
      if (item.isDirectory()) await scan(join(path, item.name), name + "/");
      else if (item.isFile()) {
        const content = await readFile(join(path, item.name));
        bytes += content.length;
        if (bytes > 16 * 1024 * 1024 || ui.size >= 256)
          throw new Error("preview.assets_limit: UI assets exceed limits");
        ui.set(name, content);
      }
    }
  };
  await scan(join(root, "ui"));
  if (!ui.has("index.html"))
    throw new Error(
      "preview.assets_missing: build or reinstall the preview UI",
    );
  return { entryScript: manifest.entryScript, platform, ui };
}

class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
async function body(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 8192)
      throw new RequestError(
        413,
        "preview.request_limit",
        "Request body exceeds 8 KiB",
      );
    chunks.push(chunk);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError(
      400,
      "preview.invalid_request",
      "Expected a JSON object",
    );
  }
  if (!isObjectRecord(value))
    throw new RequestError(
      400,
      "preview.invalid_request",
      "Expected a JSON object",
    );
  return value;
}
function onlyKeys(value: Record<string, unknown>, names: string[]): void {
  if (Object.keys(value).some((name) => !names.includes(name)))
    throw new RequestError(
      400,
      "preview.invalid_request",
      "Unexpected request field",
    );
}
function json(response: ServerResponse, status: number, data: unknown) {
  if (response.destroyed) return;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(data));
}

/** Owns UI, versioned browser snapshots, decoder pools and output jobs as one local session. */
export async function createPreviewServer(
  config: Config,
  options: PreviewServerOptions = {},
  dependencies: PreviewServerDependencies = {},
): Promise<PreviewServer> {
  if (config.source !== undefined)
    throw new Error(
      "preview.source_unsupported: source adapter preview is not available yet; use compositions, inspect, frame or render with this config",
    );
  const paths = options.pathOptions ?? dependencies.pathOptions;
  const source = resolveCompositionRenderSource(config, paths);
  if (source.kind !== "entry" || !source.snapshotRoot)
    throw new Error(
      "preview.static_entry_required: preview needs entry and renderer.snapshotRoot for a built static project",
    );
  const inputPropsPath = resolveCliInputPropsPath(
    options.inputPropsFile,
    paths,
  );
  const outputDirectory = resolveCliOutputPath(
    options.outputDirectory ?? ".velocast/preview-output",
    paths,
  );
  const overlap = relative(source.snapshotRoot, outputDirectory);
  if (
    !overlap ||
    (!isAbsolute(overlap) &&
      overlap !== ".." &&
      !overlap.startsWith("..\\") &&
      !overlap.startsWith("../"))
  )
    throw new Error(
      "preview.output_overlaps_source: output directory must be outside the frozen source root",
    );
  const assets = await readAssets(dependencies.assetsDirectory);
  const owner = new AbortController();
  const pending = new Set<Promise<void>>();
  const artifacts = new Map<string, string>();
  let active:
    | {
        snapshot: InputSnapshot;
        media: VideoFrameHttp;
        inputProps?: unknown;
        sourceRevision: string;
      }
    | undefined;
  let prepared: typeof active;
  let preparedTimer: ReturnType<typeof setTimeout> | undefined;
  let origin = "",
    closed = false,
    refreshing = false,
    outputBusy = false;
  let closePromise: Promise<void> | undefined;
  const acquisition =
    dependencies.runtimeAcquisition ??
    new RendererRuntimeAcquisition({
      cwd: paths?.cwd,
      env: paths?.env ? { ...process.env, ...paths.env } : process.env,
      runtimeResolver: dependencies.runtimeResolver,
      resolveRendererBinary: dependencies.resolveRendererBinary,
    });
  let runtime: ReturnType<typeof acquisition.acquire> | undefined;
  const capture = async () => {
    const sourceRevision = await previewSourceRevision(
      source.snapshotRoot!,
      inputPropsPath,
    );
    let media: VideoFrameHttp | undefined;
    const snapshot = await createInputSnapshot({
      root: source.snapshotRoot!,
      entryPath: fileURLToPath(source.url),
      inputPropsPath,
      preview: {
        parentOrigin: origin,
        entryScript: assets.entryScript,
        assets: {
          ...assets.platform,
          "config.js": Buffer.from(
            `export const previewConfig = ${JSON.stringify({ parentOrigin: origin })};\n`,
          ),
        },
      },
      handleMediaRequest: async (request, response, identity) => {
        runtime ??= acquisition.acquire(config.renderer?.binary);
        const acquired = await runtime;
        owner.signal.throwIfAborted();
        media ??= (dependencies.createMediaService ?? createVideoFrameHttp)({
          directory: tmpdir(),
          env: acquired.env,
        });
        return media.handle(request, response, identity);
      },
    });
    try {
      if (
        sourceRevision !==
        (await previewSourceRevision(source.snapshotRoot!, inputPropsPath))
      )
        throw new RequestError(
          409,
          "preview.build_in_progress",
          "Source is still changing; waiting for a completed build",
        );
      const inputProps = snapshot.inputPropsPath
        ? JSON.parse(
            (await readFile(snapshot.inputPropsPath, "utf8")).replace(
              /^\uFEFF/,
              "",
            ),
          )
        : undefined;
      return {
        snapshot,
        inputProps,
        sourceRevision,
        media: {
          handle: async () => {
            throw new Error("private preview media owner");
          },
          close: async () => {
            await media?.close();
          },
        },
      };
    } catch (error) {
      await snapshot.close();
      throw error;
    }
  };
  const descriptor = (value = active) => {
    if (!value)
      throw new Error("preview.not_ready: session is not initialized");
    return {
      snapshotUrl: value.snapshot.url,
      session: value.snapshot.session,
      sourceRevision: value.sourceRevision,
      autoRefresh: options.autoRefresh !== false,
      stagedRefresh: true,
      ...(value.inputProps === undefined
        ? {}
        : { inputProps: value.inputProps }),
    };
  };
  const release = async (value: typeof active) => {
    try {
      await value?.media.close();
    } finally {
      await value?.snapshot.close();
    }
  };
  const clearPreparedTimer = () => {
    clearTimeout(preparedTimer);
    preparedTimer = undefined;
  };
  const leasePrepared = (value: NonNullable<typeof active>) => {
    clearPreparedTimer();
    const lifetime = dependencies.preparedLifetimeMs ?? 60_000;
    if (!Number.isSafeInteger(lifetime) || lifetime < 1 || lifetime > 60_000)
      throw new Error(
        "preview.candidate_lifetime: expected 1..60000 milliseconds",
      );
    preparedTimer = setTimeout(() => {
      if (prepared !== value) return;
      prepared = undefined;
      const cleanup = release(value).catch((error) => {
        console.warn("preview.candidate_cleanup_failed", error);
      });
      pending.add(cleanup);
      void cleanup.finally(() => pending.delete(cleanup));
    }, lifetime);
    preparedTimer.unref();
  };
  const expected = (value: Record<string, unknown>) => {
    if (
      typeof value.expectedSourceVersion !== "string" ||
      value.expectedSourceVersion !== active?.snapshot.session.sourceVersion
    )
      throw new RequestError(
        409,
        "snapshot.version_mismatch",
        "Preview source changed; refresh before requesting this operation",
      );
  };
  const serve = async (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    request.setTimeout(10000, () => request.destroy());
    try {
      if (closed || !active)
        throw new RequestError(
          503,
          "preview.closed",
          "Preview is not available",
        );
      if (
        request.headers.host !== new URL(origin).host ||
        (request.headers.origin && request.headers.origin !== origin)
      )
        throw new RequestError(
          403,
          "preview.origin_mismatch",
          "Only the local preview origin may use this service",
        );
      const url = new URL(request.url ?? "/", origin);
      if (url.origin !== origin)
        throw new RequestError(
          403,
          "preview.origin_mismatch",
          "Foreign request origin",
        );
      if (request.method === "GET" && url.pathname === "/api/session") {
        json(response, 200, descriptor());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/changes") {
        json(response, 200, {
          enabled: options.autoRefresh !== false,
          revision:
            options.autoRefresh === false
              ? active.sourceRevision
              : await previewSourceRevision(
                  source.snapshotRoot!,
                  inputPropsPath,
                ),
        });
        return;
      }
      if (
        request.method === "POST" &&
        ["/api/commit-refresh", "/api/discard-refresh"].includes(url.pathname)
      ) {
        const input = await body(request);
        onlyKeys(input, ["expectedSourceVersion", "candidateSessionId"]);
        expected(input);
        if (refreshing || outputBusy)
          throw new RequestError(
            409,
            "preview.refresh_busy",
            "Wait for the current operation to finish",
          );
        if (
          !prepared ||
          input.candidateSessionId !== prepared.snapshot.session.sessionId
        )
          throw new RequestError(
            409,
            "preview.candidate_stale",
            "Prepared source is no longer available",
          );
        refreshing = true;
        try {
          const candidate = prepared;
          clearPreparedTimer();
          prepared = undefined;
          if (url.pathname === "/api/commit-refresh") {
            const old = active;
            active = candidate;
            await release(old);
          } else await release(candidate);
          json(response, 200, descriptor());
        } finally {
          refreshing = false;
        }
        return;
      }
      if (
        request.method === "POST" &&
        ["/api/refresh", "/api/prepare-refresh"].includes(url.pathname)
      ) {
        if (refreshing)
          throw new RequestError(
            409,
            "preview.refresh_busy",
            "A source refresh is already running",
          );
        const input = await body(request);
        onlyKeys(input, ["expectedSourceVersion"]);
        expected(input);
        if (refreshing)
          throw new RequestError(
            409,
            "preview.refresh_busy",
            "A source refresh is already running",
          );
        refreshing = true;
        try {
          const next = await capture();
          if (closed) {
            await release(next);
            throw new RequestError(
              503,
              "preview.closed",
              "Preview closed during source refresh",
            );
          }
          if (url.pathname === "/api/prepare-refresh") {
            const previous = prepared;
            prepared = next;
            leasePrepared(next);
            await release(previous);
            json(response, 200, descriptor(next));
          } else {
            const old = active;
            active = next;
            await release(old);
            await release(prepared);
            clearPreparedTimer();
            prepared = undefined;
            json(response, 200, descriptor());
          }
        } finally {
          refreshing = false;
        }
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/output") {
        if (outputBusy)
          throw new RequestError(
            409,
            "preview.output_busy",
            "An output job is already running",
          );
        const input = await body(request);
        onlyKeys(input, [
          "compositionId",
          "expectedSourceVersion",
          "frame",
          "range",
        ]);
        expected(input);
        if (outputBusy)
          throw new RequestError(
            409,
            "preview.output_busy",
            "An output job is already running",
          );
        if (
          typeof input.compositionId !== "string" ||
          !input.compositionId.trim() ||
          input.compositionId.length > 256 ||
          (input.frame === undefined) === (input.range === undefined)
        )
          throw new RequestError(
            400,
            "preview.invalid_output",
            "Supply a composition ID and exactly one frame or range",
          );
        const range = input.range;
        if (
          range !== undefined &&
          (!isObjectRecord(range) ||
            Object.keys(range).length !== 2 ||
            !Number.isSafeInteger(range.start) ||
            !Number.isSafeInteger(range.end) ||
            Number(range.start) < 0 ||
            Number(range.end) <= Number(range.start))
        )
          throw new RequestError(
            400,
            "preview.invalid_output",
            "Range must have exact nonnegative start and exclusive end frames",
          );
        if (
          input.frame !== undefined &&
          (!Number.isSafeInteger(input.frame) || Number(input.frame) < 0)
        )
          throw new RequestError(
            400,
            "preview.invalid_output",
            "Frame must be a nonnegative integer",
          );
        const name = randomUUID() + (range === undefined ? ".png" : ".mp4"),
          output = join(outputDirectory, name);
        const client = new AbortController();
        const disconnected = () => {
          if (!response.writableFinished)
            client.abort(new Error("preview client disconnected"));
        };
        response.once("close", disconnected);
        outputBusy = true;
        let result: OutputResult | undefined;
        try {
          await executeRendererJob(
            range === undefined
              ? {
                  kind: "frame",
                  config,
                  compositionId: input.compositionId,
                  frame: input.frame as number,
                  output,
                  options: {
                    json: true,
                    inputPropsFile: options.inputPropsFile,
                  },
                }
              : {
                  kind: "composition",
                  config,
                  compositionId: input.compositionId,
                  output,
                  options: {
                    json: true,
                    inputPropsFile: options.inputPropsFile,
                    startFrame: Number(
                      (range as Record<string, unknown>).start,
                    ),
                    endFrame: Number((range as Record<string, unknown>).end),
                    concurrency: 1,
                    assembly: "reference",
                  },
                },
            {
              ...dependencies,
              pathOptions: paths,
              runtimeAcquisition: acquisition,
              expectedSourceVersion: input.expectedSourceVersion as string,
              signal: AbortSignal.any([owner.signal, client.signal]),
              onOutputResult: (value) => {
                result = value;
              },
            },
          );
          artifacts.set(name, output);
          json(response, 200, {
            ...result,
            outputPath: output,
            url: `${origin}/artifacts/${name}`,
          });
        } finally {
          outputBusy = false;
          response.removeListener("close", disconnected);
        }
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD")
        throw new RequestError(405, "preview.method", "Unsupported method");
      let content: Buffer | undefined,
        type = "application/octet-stream";
      if (url.pathname.startsWith("/artifacts/")) {
        const path = artifacts.get(url.pathname.slice("/artifacts/".length));
        if (path) {
          type = path.endsWith(".png") ? "image/png" : "video/mp4";
          const file = await stat(path);
          response.writeHead(200, {
            "Content-Type": type,
            "Content-Length": file.size,
          });
          if (request.method === "HEAD") response.end();
          else await pipeline(createReadStream(path), response);
          return;
        }
      } else {
        const name =
          url.pathname === "/"
            ? "index.html"
            : decodeURIComponent(url.pathname.slice(1));
        content = assets.ui.get(name);
        type =
          (
            {
              ".html": "text/html; charset=utf-8",
              ".js": "text/javascript",
              ".css": "text/css",
              ".svg": "image/svg+xml",
            } as Record<string, string>
          )[extname(name)] ?? type;
      }
      if (!content)
        throw new RequestError(
          404,
          "preview.not_found",
          "Preview resource was not found",
        );
      response.writeHead(200, {
        "Content-Type": type,
        "Content-Length": content.length,
      });
      response.end(request.method === "HEAD" ? undefined : content);
    } catch (error) {
      if (!response.headersSent)
        json(response, error instanceof RequestError ? error.status : 500, {
          code:
            error instanceof RequestError
              ? error.code
              : "preview.request_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      else response.destroy();
    }
  };
  const server = createServer((request, response) => {
    const work = serve(request, response);
    pending.add(work);
    void work.finally(() => pending.delete(work));
  });
  const close = (): Promise<void> =>
    (closePromise ??= (async () => {
      closed = true;
      clearPreparedTimer();
      owner.abort(new Error("preview session closed"));
      options.signal?.removeEventListener("abort", stop);
      const stopped = new Promise<void>((done) => {
        if (!server.listening) {
          done();
          return;
        }
        server.close(() => done());
        server.closeAllConnections();
      });
      await Promise.allSettled([...pending]);
      await release(active);
      await release(prepared);
      await stopped;
    })());
  const stop = () => {
    void close();
  };
  try {
    options.signal?.throwIfAborted();
    const port = options.port ?? 0;
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error("preview.invalid_port: port must be 0..65535");
    await new Promise<void>((yes, no) => {
      server.once("error", no);
      server.listen(port, "127.0.0.1", yes);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("preview.listen_failed");
    origin = `http://127.0.0.1:${address.port}`;
    active = await capture();
    options.signal?.throwIfAborted();
    options.signal?.addEventListener("abort", stop, { once: true });
    return { url: origin, session: descriptor, close };
  } catch (error) {
    await close();
    throw error;
  }
}

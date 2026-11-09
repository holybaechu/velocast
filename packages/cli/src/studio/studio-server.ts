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
import { type CodeEdit, type CodeSource, type Config } from "@velocast/core";
import { BROWSER_PROTOCOL_VERSION } from "../generated/renderer-contracts.js";
import {
  executeRendererJob,
  type RendererRunDependencies,
} from "../render/commands.js";
import {
  createInputSnapshot,
  type InputSnapshot,
} from "../project/input-snapshot.js";
import {
  createVideoFrameHttp,
  type VideoFrameHttp,
} from "../media/video-frame-http.js";
import { RendererRuntimeAcquisition } from "../runtime/renderer-runtime.js";
import { resolveCompositionRenderSource } from "../project/render-source.js";
import {
  resolveCliInputPropsPath,
  getInvocationCwd,
  resolveCliOutputPath,
  type InvocationPathOptions,
} from "../project/paths.js";
import { outputError, type OutputResult } from "../render/output-result.js";
import { isObjectRecord } from "../internal/validation.js";
import { studioSourceRevision } from "./studio-source-revision.js";
import {
  MAX_STUDIO_INPUT_BYTES,
  StudioInputsError,
  readStudioInputs,
} from "./studio-inputs.js";
import { resolveRendererContainer } from "../render/renderer-options.js";
import { codeSourceConfig, StudioCodeError } from "./studio-code-config.js";
import { MAX_STUDIO_CODE_BYTES, StudioCodeStore } from "./studio-code-store.js";
import { readSourceReceipt } from "./source-receipt.js";
import { StudioClients, StudioClientError } from "./studio-clients.js";

interface StudioAssets {
  entryScript: string;
  platform: Record<string, Uint8Array>;
  ui: Map<string, Buffer>;
}
export interface StudioServerOptions {
  autoRefresh?: boolean;
  inputPropsFile?: string;
  outputDirectory?: string;
  port?: number;
  pathOptions?: InvocationPathOptions;
  signal?: AbortSignal;
}
export interface StudioServerDependencies extends RendererRunDependencies {
  /** Tests/pack consumers may select an installed studio dist directory explicitly. */
  assetsDirectory?: string;
  /** Bounded candidate lease; tests may shorten it without running an expiry minute. */
  preparedLifetimeMs?: number;
}
export interface StudioServer {
  url: string;
  session(): {
    snapshotUrl: string;
    session: InputSnapshot["session"];
    inputProps?: unknown;
    inputPropsFile?: { path: string; revision: string };
    sourceRevision?: string;
    codeRevisions?: Record<string, string>;
    autoRefresh?: boolean;
    stagedRefresh?: boolean;
  };
  close(): Promise<void>;
}

interface OutputRequest {
  compositionId: string;
  expectedSourceVersion: string;
  frame?: number;
  range?: { start: number; end: number };
}
type StudioOutput = OutputResult & { outputPath: string; url: string };
export interface StudioJob {
  id: string;
  status: "running" | "cancelling" | "succeeded" | "failed" | "cancelled";
  request: OutputRequest;
  createdAt: string;
  updatedAt: string;
  result?: StudioOutput;
  error?: { code: string; message: string };
}

function within(root: string, path: string): boolean {
  const name = relative(root, path);
  return (
    !name ||
    (!isAbsolute(name) &&
      name !== ".." &&
      !name.startsWith("..\\") &&
      !name.startsWith("../"))
  );
}

const revision = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

async function readAssets(directory?: string): Promise<StudioAssets> {
  const root =
    directory ??
    dirname(createRequire(import.meta.url).resolve("@velocast/studio"));
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
      "studio.assets_incompatible: installed studio assets do not match the browser protocol",
    );
  const platform: Record<string, Uint8Array> = {};
  for (const name of manifest.assets) {
    if (typeof name !== "string" || !/^[a-zA-Z0-9_-]+\.js$/.test(name))
      throw new Error("studio.assets_invalid: invalid platform module name");
    const bytes = await readFile(join(root, "platform", name));
    if (
      createHash("sha256").update(bytes).digest("hex") !== manifest.sha256[name]
    )
      throw new Error(
        "studio.assets_corrupt: platform module checksum differs",
      );
    platform[name] = bytes;
  }
  if (!(manifest.entryScript in platform))
    throw new Error("studio.assets_invalid: entry module is missing");
  const ui = new Map<string, Buffer>();
  let bytes = 0;
  const scan = async (path: string, prefix = "") => {
    for (const item of await readdir(path, { withFileTypes: true })) {
      if (item.isSymbolicLink())
        throw new Error(
          "studio.assets_invalid: linked UI assets are not allowed",
        );
      const name = prefix + item.name;
      if (item.isDirectory()) await scan(join(path, item.name), name + "/");
      else if (item.isFile()) {
        const content = await readFile(join(path, item.name));
        bytes += content.length;
        if (bytes > 16 * 1024 * 1024 || ui.size >= 256)
          throw new Error("studio.assets_limit: UI assets exceed limits");
        ui.set(name, content);
      }
    }
  };
  await scan(join(root, "ui"));
  if (!ui.has("index.html"))
    throw new Error("studio.assets_missing: build or reinstall the studio UI");
  return { entryScript: manifest.entryScript, platform, ui };
}

class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
async function body(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > MAX_STUDIO_INPUT_BYTES) {
      request.resume();
      throw new RequestError(
        413,
        "studio.request_limit",
        "Request body exceeds 1 MiB",
      );
    }
    chunks.push(chunk);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError(
      400,
      "studio.invalid_request",
      "Expected a JSON object",
    );
  }
  if (!isObjectRecord(value))
    throw new RequestError(
      400,
      "studio.invalid_request",
      "Expected a JSON object",
    );
  return value;
}
function onlyKeys(value: Record<string, unknown>, names: string[]): void {
  if (Object.keys(value).some((name) => !names.includes(name)))
    throw new RequestError(
      400,
      "studio.invalid_request",
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
export async function createStudioServer(
  config: Config,
  options: StudioServerOptions = {},
  dependencies: StudioServerDependencies = {},
): Promise<StudioServer> {
  if (config.source !== undefined)
    throw new Error(
      "studio.source_unsupported: source adapter studio is not available yet; use compositions, inspect, frame or render with this config",
    );
  const paths = options.pathOptions ?? dependencies.pathOptions;
  const source = resolveCompositionRenderSource(config, paths);
  if (source.kind !== "entry" || !source.snapshotRoot)
    throw new Error(
      "studio.static_entry_required: studio needs entry and renderer.snapshotRoot for a built static project",
    );
  const inputPropsPath = resolveCliInputPropsPath(
    options.inputPropsFile ?? config.inputPropsFile,
    paths,
  );
  if (inputPropsPath && within(source.snapshotRoot, inputPropsPath))
    throw new Error(
      "studio.inputs_overlap_source: --input-props-file must be outside snapshotRoot so saved edits survive builds",
    );
  const outputDirectory = resolveCliOutputPath(
    options.outputDirectory ?? ".velocast/studio-output",
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
      "studio.output_overlaps_source: output directory must be outside the frozen source root",
    );
  const assets = await readAssets(dependencies.assetsDirectory);
  const owner = new AbortController();
  const codeConfig = codeSourceConfig(config.studio, getInvocationCwd(paths));
  const codeStore = new StudioCodeStore(
    codeConfig.root,
    codeConfig.sources,
    owner.signal,
  );
  const clients = new StudioClients();
  const pending = new Set<Promise<void>>();
  const artifacts = new Map<string, string>();
  const jobs = new Map<
    string,
    { record: StudioJob; controller: AbortController; done: Promise<void> }
  >();
  let active:
    | {
        snapshot: InputSnapshot;
        media: VideoFrameHttp;
        inputProps?: unknown;
        inputPropsFile?: { path: string; revision: string };
        sourceRevision: string;
        codeRevisions?: Record<string, string>;
      }
    | undefined;
  let prepared: typeof active;
  let preparedTimer: ReturnType<typeof setTimeout> | undefined;
  let origin = "",
    closed = false,
    refreshing = false,
    savingCode = false,
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
  const captureSnapshot = async () => {
    const sourceRevision = await studioSourceRevision(
      source.snapshotRoot!,
      inputPropsPath,
    );
    let media: VideoFrameHttp | undefined;
    const snapshot = await createInputSnapshot({
      root: source.snapshotRoot!,
      entryPath: fileURLToPath(source.url),
      inputPropsPath,
      studio: {
        parentOrigin: origin,
        entryScript: assets.entryScript,
        assets: {
          ...assets.platform,
          "config.js": Buffer.from(
            `export const studioConfig = ${JSON.stringify({ parentOrigin: origin })};\n`,
          ),
        },
      },
      handleMediaRequest: async (request, response, identity) => {
        runtime ??= acquisition.acquire(config.renderer?.binary, owner.signal);
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
        (await studioSourceRevision(source.snapshotRoot!, inputPropsPath))
      )
        throw new RequestError(
          409,
          "studio.build_in_progress",
          "Source is still changing; waiting for a completed build",
        );
      const propsBytes = snapshot.inputPropsPath
        ? await readFile(snapshot.inputPropsPath)
        : undefined;
      const inputProps = propsBytes
        ? JSON.parse(propsBytes.toString("utf8").replace(/^\uFEFF/, ""))
        : undefined;
      const codeRevisions = codeStore.compositions().length
        ? await readSourceReceipt(snapshot.url, owner.signal)
        : undefined;
      return {
        snapshot,
        inputProps,
        ...(propsBytes && inputPropsPath
          ? {
              inputPropsFile: {
                path: inputPropsPath,
                revision: revision(propsBytes),
              },
            }
          : {}),
        sourceRevision,
        ...(codeRevisions ? { codeRevisions } : {}),
        media: {
          handle: async () => {
            throw new Error("private studio media owner");
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
  const capture = async () => {
    try {
      return await captureSnapshot();
    } catch (error) {
      if (
        active &&
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
      )
        throw new RequestError(
          409,
          "studio.build_in_progress",
          "Build files are being replaced; waiting for a completed build",
          { cause: error },
        );
      throw error;
    }
  };
  const descriptor = (value = active) => {
    if (!value) throw new Error("studio.not_ready: session is not initialized");
    return {
      snapshotUrl: value.snapshot.url,
      session: value.snapshot.session,
      sourceRevision: value.sourceRevision,
      ...(value.codeRevisions ? { codeRevisions: value.codeRevisions } : {}),
      autoRefresh: options.autoRefresh !== false,
      stagedRefresh: true,
      ...(value.inputPropsFile ? { inputPropsFile: value.inputPropsFile } : {}),
      ...(value.inputProps === undefined
        ? {}
        : { inputProps: value.inputProps }),
    };
  };
  const codeDescriptor = (saved: CodeSource): CodeSource => {
    const displayedRevision = active?.codeRevisions?.[saved.compositionId];
    return displayedRevision ? { ...saved, displayedRevision } : saved;
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
        "studio.candidate_lifetime: expected 1..60000 milliseconds",
      );
    preparedTimer = setTimeout(() => {
      if (prepared !== value) return;
      prepared = undefined;
      const cleanup = release(value).catch((error) => {
        console.warn("studio.candidate_cleanup_failed", error);
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
        "Studio source changed; refresh before requesting this operation",
      );
  };
  const available = () => {
    if (refreshing || savingCode)
      throw new RequestError(
        409,
        "studio.refresh_busy",
        "Wait for the current source operation to finish",
      );
    if (outputBusy)
      throw new RequestError(
        409,
        "studio.output_busy",
        "An output job is already running",
      );
  };
  const outputRequest = (input: Record<string, unknown>): OutputRequest => {
    onlyKeys(input, [
      "compositionId",
      "expectedSourceVersion",
      "frame",
      "range",
    ]);
    expected(input);
    available();
    if (
      typeof input.compositionId !== "string" ||
      !input.compositionId.trim() ||
      input.compositionId.length > 256 ||
      (input.frame === undefined) === (input.range === undefined)
    )
      throw new RequestError(
        400,
        "studio.invalid_output",
        "Supply a composition ID and exactly one frame or range",
      );
    if (
      input.range !== undefined &&
      (!isObjectRecord(input.range) ||
        Object.keys(input.range).length !== 2 ||
        !Number.isSafeInteger(input.range.start) ||
        !Number.isSafeInteger(input.range.end) ||
        Number(input.range.start) < 0 ||
        Number(input.range.end) <= Number(input.range.start))
    )
      throw new RequestError(
        400,
        "studio.invalid_output",
        "Range must have exact nonnegative start and exclusive end frames",
      );
    if (
      input.frame !== undefined &&
      (!Number.isSafeInteger(input.frame) || Number(input.frame) < 0)
    )
      throw new RequestError(
        400,
        "studio.invalid_output",
        "Frame must be a nonnegative integer",
      );
    return input as unknown as OutputRequest;
  };
  const runOutput = async (
    input: OutputRequest,
    signal: AbortSignal,
  ): Promise<StudioOutput> => {
    const name =
      randomUUID() +
      (input.range === undefined
        ? ".png"
        : `.${resolveRendererContainer(config) ?? "mp4"}`);
    const output = join(outputDirectory, name);
    let result: OutputResult | undefined;
    await executeRendererJob(
      input.range === undefined
        ? {
            kind: "frame",
            config,
            compositionId: input.compositionId,
            frame: input.frame,
            output,
            options: { json: true, inputPropsFile: options.inputPropsFile },
          }
        : {
            kind: "composition",
            config,
            compositionId: input.compositionId,
            output,
            options: {
              json: true,
              inputPropsFile: options.inputPropsFile,
              startFrame: input.range.start,
              endFrame: input.range.end,
              concurrency: 1,
              assembly: "reference",
            },
          },
      {
        ...dependencies,
        pathOptions: paths,
        runtimeAcquisition: acquisition,
        expectedSourceVersion: input.expectedSourceVersion,
        signal: AbortSignal.any([owner.signal, signal]),
        onOutputResult: (value) => {
          result = value;
        },
      },
    );
    if (!result || result.status !== "success")
      throw new Error(
        "studio.output_result_missing: output completed without success metadata",
      );
    artifacts.set(name, output);
    return {
      ...result,
      outputPath: output,
      url: `${origin}/artifacts/${name}`,
    };
  };
  const startJob = (input: OutputRequest): StudioJob => {
    const now = new Date().toISOString();
    const record: StudioJob = {
      id: randomUUID(),
      status: "running",
      request: input,
      createdAt: now,
      updatedAt: now,
    };
    const controller = new AbortController();
    outputBusy = true;
    const done = Promise.resolve().then(async () => {
      try {
        record.result = await runOutput(input, controller.signal);
        record.status = "succeeded";
      } catch (error) {
        record.status =
          controller.signal.aborted || owner.signal.aborted
            ? "cancelled"
            : "failed";
        record.error =
          record.status === "cancelled"
            ? {
                code: "studio.cancelled",
                message: "Output cancelled; owned work has stopped",
              }
            : outputError(error);
      } finally {
        record.updatedAt = new Date().toISOString();
        outputBusy = false;
      }
    });
    jobs.set(record.id, { record, controller, done });
    // Retain a bounded session history; completed output files remain available.
    for (const [id, job] of jobs) {
      if (jobs.size <= 100) break;
      if (job.record.status !== "running" && job.record.status !== "cancelling")
        jobs.delete(id);
    }
    pending.add(done);
    void done.finally(() => pending.delete(done));
    return record;
  };
  const serve = async (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    request.setTimeout(10000, () => request.destroy());
    try {
      if (closed || !active)
        throw new RequestError(503, "studio.closed", "Studio is not available");
      if (
        request.headers.host !== new URL(origin).host ||
        (request.headers.origin && request.headers.origin !== origin)
      )
        throw new RequestError(
          403,
          "studio.origin_mismatch",
          "Only the local studio origin may use this service",
        );
      const url = new URL(request.url ?? "/", origin);
      if (url.origin !== origin)
        throw new RequestError(
          403,
          "studio.origin_mismatch",
          "Foreign request origin",
        );
      if (request.method === "GET" && url.pathname === "/api/session") {
        json(response, 200, descriptor());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/capabilities") {
        json(response, 200, {
          apiVersion: 1,
          operations: {
            session: "GET /api/session",
            changes: "GET /api/changes",
            clients: "GET /api/clients",
            control: "POST /api/control",
            agentConnection: "GET /api/agent-connection",
            inputs: "GET /api/inputs",
            code: "GET /api/code?compositionId=:id&includeSource=true",
            editCode: "POST /api/code",
            replaceCode: "POST /api/code/replace",
            codeHistory: "POST /api/code/history",
            recoverCode: "POST /api/code/recover",
            startJob: "POST /api/jobs",
            listJobs: "GET /api/jobs",
            job: "GET /api/jobs/:id",
            cancelJob: "POST /api/jobs/:id/cancel",
            prepareRefresh: "POST /api/prepare-refresh",
            commitRefresh: "POST /api/commit-refresh",
            discardRefresh: "POST /api/discard-refresh",
          },
          code: {
            compositions: codeStore.compositions(),
            editRequired: [
              "compositionId",
              "expectedSourceVersion",
              "expectedRevision",
              "edits",
            ],
            replaceRequired: [
              "compositionId",
              "expectedSourceVersion",
              "expectedRevision",
              "source",
            ],
            historyRequired: [
              "compositionId",
              "expectedSourceVersion",
              "expectedRevision",
              "action",
            ],
            build:
              "Build with studioSourcePlugin from velocast/vite. The displayed codeRevisions must match saved revisions before export.",
            lifecycle:
              "Writes mapped source files, with durable undo and recovery. External source edits are observed. Project code is trusted local code.",
          },
          control: {
            required: [
              "clientId",
              "expectedRevision",
              "expectedSourceVersion",
              "action",
            ],
            actions: [
              "play",
              "pause",
              "seek",
              "select",
              "composition",
              "inspect",
            ],
            inspection:
              "inspect requires elementId, a paused clean tab and one rendered Layer match; acknowledgement includes resolved DOM state",
            lifecycle:
              "Commands target one explicit browser and finish only after acknowledgement. Read context again after a timeout or conflict.",
          },
          outputRequest: {
            required: ["compositionId", "expectedSourceVersion"],
            exactlyOne: ["frame", "range"],
            frame: "zero-based integer",
            range: { start: "inclusive frame", end: "exclusive frame" },
          },
          jobStatuses: [
            "running",
            "cancelling",
            "succeeded",
            "failed",
            "cancelled",
          ],
          limits: {
            concurrentOutputs: 1,
            retainedJobs: 100,
            requestBytes: MAX_STUDIO_INPUT_BYTES,
            inputPropsBytes: MAX_STUDIO_INPUT_BYTES,
            historyEntries: 50,
            codeBytes: MAX_STUDIO_CODE_BYTES,
            codeEdits: 100,
            browserClients: 32,
            clientExpirySeconds: 30,
          },
          lifecycle:
            "Jobs survive HTTP disconnection. Cancellation and shutdown join owned work. Completed output files survive shutdown.",
        });
        return;
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/agent-connection"
      ) {
        json(response, 200, {
          command: process.execPath,
          args: [
            fileURLToPath(new URL("../bin.js", import.meta.url)),
            "mcp",
            "--url",
            origin,
          ],
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/clients") {
        json(response, 200, { clients: clients.list() });
        return;
      }
      if (url.pathname.startsWith("/api/clients/")) {
        const clientId = url.pathname.slice("/api/clients/".length);
        if (request.method === "POST") {
          json(response, 200, clients.heartbeat(clientId, await body(request)));
          return;
        }
        if (request.method === "DELETE") {
          clients.disconnect(clientId);
          json(response, 200, { disconnected: true });
          return;
        }
      }
      if (request.method === "POST" && url.pathname === "/api/control") {
        const input = await body(request);
        expected(input);
        const commandOwner = new AbortController();
        const disconnected = () => {
          if (!response.writableEnded) commandOwner.abort();
        };
        response.once("close", disconnected);
        try {
          json(
            response,
            200,
            await clients.control(
              input,
              AbortSignal.any([owner.signal, commandOwner.signal]),
            ),
          );
        } finally {
          response.removeListener("close", disconnected);
        }
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/inputs") {
        json(response, 200, await readStudioInputs(inputPropsPath));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/code") {
        const id = url.searchParams.get("compositionId");
        if (!id?.trim())
          throw new StudioCodeError(
            400,
            "studio.code_composition",
            "compositionId is required",
          );
        json(
          response,
          200,
          codeDescriptor(
            await (url.searchParams.get("includeSource") === "true"
              ? codeStore.readSource(id)
              : codeStore.read(id)),
          ),
        );
        return;
      }
      if (
        request.method === "POST" &&
        [
          "/api/code",
          "/api/code/history",
          "/api/code/replace",
          "/api/code/recover",
        ].includes(url.pathname)
      ) {
        const input = await body(request);
        const history = url.pathname.endsWith("/history");
        const replace = url.pathname.endsWith("/replace");
        const recover = url.pathname.endsWith("/recover");
        onlyKeys(input, [
          "compositionId",
          "expectedSourceVersion",
          "expectedRevision",
          ...(recover
            ? []
            : [history ? "action" : replace ? "source" : "edits"]),
        ]);
        expected(input);
        available();
        if (
          typeof input.compositionId !== "string" ||
          !input.compositionId.trim()
        )
          throw new StudioCodeError(
            400,
            "studio.code_composition",
            "compositionId is required",
          );
        if (!recover && !active?.codeRevisions?.[input.compositionId])
          throw new StudioCodeError(
            400,
            "studio.code_build_untracked",
            "Link source builds with studioSourcePlugin from velocast/vite, then rebuild before editing",
          );
        savingCode = true;
        try {
          json(
            response,
            200,
            codeDescriptor(
              recover
                ? await codeStore.recover(input.compositionId)
                : replace
                  ? await codeStore.replace(
                      input.compositionId,
                      input.expectedRevision,
                      input.source as string,
                    )
                  : history
                    ? await codeStore.history(
                        input.compositionId,
                        input.expectedRevision,
                        input.action,
                      )
                    : await codeStore.edit(
                        input.compositionId,
                        input.expectedRevision,
                        input.edits as CodeEdit[],
                      ),
            ),
          );
        } finally {
          savingCode = false;
        }
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/jobs") {
        json(response, 200, {
          jobs: [...jobs.values()].map(({ record }) => record),
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/jobs") {
        json(response, 202, startJob(outputRequest(await body(request))));
        return;
      }
      const jobPath = /^\/api\/jobs\/([a-z0-9-]+)(\/cancel)?$/.exec(
        url.pathname,
      );
      if (jobPath) {
        const job = jobs.get(jobPath[1]!);
        if (!job)
          throw new RequestError(
            404,
            "studio.job_not_found",
            "Output job was not found in this session",
          );
        if (request.method === "POST" && jobPath[2]) {
          if (job.record.status === "running") {
            job.record.status = "cancelling";
            job.record.updatedAt = new Date().toISOString();
            job.controller.abort(
              new Error("studio.cancelled: output cancelled"),
            );
          }
          await job.done;
          json(response, 200, job.record);
          return;
        }
        if (request.method === "GET" && !jobPath[2]) {
          json(response, 200, job.record);
          return;
        }
        throw new RequestError(405, "studio.method", "Unsupported job method");
      }
      if (request.method === "GET" && url.pathname === "/api/changes") {
        json(response, 200, {
          enabled: options.autoRefresh !== false,
          revision:
            options.autoRefresh === false
              ? active.sourceRevision
              : await studioSourceRevision(
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
        if (refreshing || outputBusy || savingCode)
          throw new RequestError(
            409,
            "studio.refresh_busy",
            "Wait for the current operation to finish",
          );
        if (
          !prepared ||
          input.candidateSessionId !== prepared.snapshot.session.sessionId
        )
          throw new RequestError(
            409,
            "studio.candidate_stale",
            "Prepared source is no longer available",
          );
        refreshing = true;
        try {
          const candidate = prepared;
          clearPreparedTimer();
          if (
            url.pathname === "/api/commit-refresh" &&
            candidate.sourceRevision !==
              (await studioSourceRevision(source.snapshotRoot!, inputPropsPath))
          )
            throw new RequestError(
              409,
              "studio.candidate_stale",
              "Project files changed after preparation; prepare the latest source before committing",
            );
          prepared = undefined;
          if (url.pathname === "/api/commit-refresh") {
            const old = active;
            active = candidate;
            await release(old);
          } else await release(candidate);
          json(response, 200, descriptor());
        } finally {
          if (prepared) leasePrepared(prepared);
          refreshing = false;
        }
        return;
      }
      if (
        request.method === "POST" &&
        ["/api/refresh", "/api/prepare-refresh"].includes(url.pathname)
      ) {
        if (refreshing || outputBusy || savingCode)
          throw new RequestError(
            409,
            "studio.refresh_busy",
            "A source refresh is already running",
          );
        const input = await body(request);
        onlyKeys(input, ["expectedSourceVersion"]);
        expected(input);
        if (refreshing || outputBusy || savingCode)
          throw new RequestError(
            409,
            "studio.refresh_busy",
            "A source refresh is already running",
          );
        refreshing = true;
        try {
          const next = await capture();
          if (closed) {
            await release(next);
            throw new RequestError(
              503,
              "studio.closed",
              "Studio closed during source refresh",
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
      if (request.method !== "GET" && request.method !== "HEAD")
        throw new RequestError(405, "studio.method", "Unsupported method");
      let content: Buffer | undefined,
        type = "application/octet-stream";
      if (url.pathname.startsWith("/artifacts/")) {
        const path = artifacts.get(url.pathname.slice("/artifacts/".length));
        if (path) {
          type =
            (
              {
                ".png": "image/png",
                ".mp4": "video/mp4",
                ".webm": "video/webm",
                ".mov": "video/quicktime",
                ".mkv": "video/x-matroska",
              } as Record<string, string>
            )[extname(path)] ?? "application/octet-stream";
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
          "studio.not_found",
          "Studio resource was not found",
        );
      response.writeHead(200, {
        "Content-Type": type,
        "Content-Length": content.length,
      });
      response.end(request.method === "HEAD" ? undefined : content);
    } catch (error) {
      if (!response.headersSent)
        json(
          response,
          error instanceof RequestError ||
            error instanceof StudioInputsError ||
            error instanceof StudioCodeError ||
            error instanceof StudioClientError
            ? error.status
            : 500,
          {
            code:
              error instanceof RequestError ||
              error instanceof StudioInputsError ||
              error instanceof StudioCodeError ||
              error instanceof StudioClientError
                ? error.code
                : "studio.request_failed",
            message: error instanceof Error ? error.message : String(error),
          },
        );
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
      clients.close();
      clearPreparedTimer();
      for (const { record } of jobs.values()) {
        if (record.status === "running") {
          record.status = "cancelling";
          record.updatedAt = new Date().toISOString();
        }
      }
      owner.abort(new Error("studio session closed"));
      options.signal?.removeEventListener("abort", stop);
      const stopped = new Promise<void>((done) => {
        if (!server.listening) {
          done();
          return;
        }
        server.close(() => done());
        server.closeAllConnections();
      });
      await Promise.allSettled([runtime]);
      await Promise.allSettled([...pending]);
      const cleanup = await Promise.allSettled([
        release(active),
        release(prepared),
        stopped,
      ]);
      const errors = cleanup.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1)
        throw new AggregateError(
          errors,
          `studio.cleanup_failed: ${errors.map((error) => (error instanceof Error ? error.message : String(error))).join("; ")}`,
        );
    })());
  const stop = () => {
    void close();
  };
  try {
    options.signal?.throwIfAborted();
    const port = options.port ?? 0;
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error("studio.invalid_port: port must be 0..65535");
    await new Promise<void>((yes, no) => {
      server.once("error", no);
      server.listen(port, "127.0.0.1", yes);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("studio.listen_failed");
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

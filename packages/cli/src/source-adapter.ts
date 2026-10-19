import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import type { PreparedSource } from "@velocast/core";
import type { RenderRequest, RendererRunDependencies } from "./commands.js";
import {
  OUTPUT_API_VERSION,
  validateCompositionManifest,
} from "./generated/renderer-contracts.js";
import {
  failedOutputResult,
  OutputFailureError,
  printOutputResult,
  type OutputResult,
} from "./output-result.js";
import { parseOutputFrame } from "./output-request.js";
import { resolveCliInputPropsPath, resolveCliOutputPath } from "./paths.js";
import { assertSourceConfig, resolveSourceEntry } from "./render-source.js";
import { renderSourceOutput } from "./source-output.js";
import {
  resolveRendererAudioCodec,
  resolveRendererContainer,
} from "./renderer-options.js";

type NativeExecutor = (
  request: RenderRequest,
  dependencies: RendererRunDependencies,
) => Promise<void>;

/** Own source preparation, capture, finalization and publication for every public entrypoint. */
export async function executeSourceJob(
  request: RenderRequest,
  dependencies: RendererRunDependencies,
  executeNative: NativeExecutor,
): Promise<void> {
  const controller = new AbortController();
  const signal = dependencies.signal ?? controller.signal;
  const interrupt = () =>
    controller.abort(new Error("source.cancelled: output interrupted"));
  if (!dependencies.signal) {
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
  }
  const json =
    "json" in (request.options ?? {}) &&
    (request.options as { json?: boolean }).json === true;
  const report =
    dependencies.onOutputResult ??
    ((result: OutputResult) => printOutputResult(result, json));
  let source: PreparedSource | undefined;
  let closed = false;
  let temporary: string | undefined;
  const close = async () => {
    if (!source || closed) return;
    closed = true;
    await source.close();
  };
  let result: OutputResult = {
    apiVersion: OUTPUT_API_VERSION,
    status: "success",
    operation:
      request.kind === "inspect"
        ? "inspect"
        : request.kind === "frame"
          ? "frame"
          : "render",
    renderSession: { sessionId: randomUUID() },
    sourceMode: "unversioned",
    composition: null,
    compositions: [],
    request: {
      compositionId:
        "compositionId" in request ? (request.compositionId ?? null) : null,
      frame: null,
      range: null,
    },
    outputPath: null,
    error: null,
  };
  try {
    signal.throwIfAborted();
    assertSourceConfig(request.config);
    if (
      request.kind !== "inspect" &&
      request.kind !== "frame" &&
      request.kind !== "composition"
    )
      throw new Error(
        "source.operation_unsupported: source adapters support compositions, inspect, frame and render",
      );
    if (dependencies.expectedSourceVersion !== undefined)
      throw new Error(
        "source.version_unsupported: source adapters do not provide snapshot identity; render directly from the source config",
      );
    const adapter = request.config.source!;
    if (
      request.kind === "composition" &&
      (request.options?.startFrame !== undefined ||
        request.options?.endFrame !== undefined)
    )
      throw new Error(
        "source.range_unsupported: source adapters currently require a full composition render",
      );
    if (request.kind !== "inspect") {
      result.outputPath = resolveCliOutputPath(
        request.output,
        dependencies.pathOptions,
      );
      const extension = extname(result.outputPath).toLowerCase();
      if (
        request.kind === "frame"
          ? extension !== ".png"
          : ![".mp4", ".mov", ".webm", ".mkv"].includes(extension)
      )
        throw new Error(
          request.kind === "frame"
            ? "source.output_invalid: frame output must use .png"
            : "source.output_invalid: composition output must use .mp4, .mov, .webm, or .mkv",
        );
      assertDiagnosticPaths(request, result.outputPath, dependencies);
    }
    if (request.kind === "frame")
      result.request.frame = parseOutputFrame(request.frame);
    const propsPath = resolveCliInputPropsPath(
      request.options?.inputPropsFile,
      dependencies.pathOptions,
    );
    const inputProps: unknown = propsPath
      ? JSON.parse((await readFile(propsPath, "utf8")).replace(/^\uFEFF/, ""))
      : {};
    if (
      !inputProps ||
      typeof inputProps !== "object" ||
      Array.isArray(inputProps)
    )
      throw new Error(
        "source.props_invalid: input props must be a JSON object",
      );
    freezeJson(inputProps);
    source = await adapter.prepare({
      entry: resolveSourceEntry(adapter.entry, dependencies.pathOptions),
      compositionId: request.compositionId,
      inputProps: inputProps as Record<string, unknown>,
      operation: result.operation,
      signal,
    });
    signal.throwIfAborted();
    const ids = new Set<string>();
    for (const composition of source.compositions) {
      validateCompositionManifest(composition);
      if (!composition.id.trim() || ids.has(composition.id))
        throw new Error(
          "source.invalid_compositions: composition IDs must be nonempty and unique",
        );
      ids.add(composition.id);
    }
    result.compositions = source.compositions.map((composition) => ({
      ...composition,
    }));
    result.composition =
      result.compositions.find(
        (composition) => composition.id === request.compositionId,
      ) ?? null;
    if (request.compositionId !== undefined && !result.composition)
      throw new Error(
        `source.composition_missing: composition ${request.compositionId} was not found`,
      );
    if (request.kind === "inspect") {
      await close();
      signal.throwIfAborted();
      report(result);
      return;
    }
    const composition = result.composition!;
    if (
      request.kind === "frame" &&
      result.request.frame! >= composition.durationFrames
    )
      throw new Error(
        "output.frame_out_of_bounds: frame must be less than composition durationFrames",
      );
    if (request.kind === "composition")
      result.request.range = {
        startFrame: 0,
        endFrame: composition.durationFrames,
      };
    const prepared = source;
    const override =
      request.kind === "frame" ? prepared.renderFrame : prepared.renderVideo;
    if (
      request.kind === "composition" &&
      prepared.renderVideo &&
      extname(result.outputPath!).toLowerCase() !== ".mp4"
    )
      throw new Error(
        "source.output_unsupported: source-owned video callbacks currently require .mp4 output",
      );
    if (override) assertReferenceOptions(request);
    else if (!prepared.url)
      throw new Error(
        "source.capture_unavailable: source must provide a capture URL or a renderer for this operation",
      );
    temporary = await mkdtemp(join(tmpdir(), "velocast-source-"));
    const frozenProps = join(temporary, "input-props.json");
    await writeFile(frozenProps, JSON.stringify(inputProps));
    const native = async (output: string, nativeSignal: AbortSignal) => {
      const { source: _source, ...config } = request.config;
      void _source;
      let nativeResult: OutputResult | undefined;
      await (dependencies.executeNativeSourceJob ?? executeNative)(
        {
          ...request,
          config: { ...config, serve: { url: prepared.url! } },
          output,
          options: {
            ...request.options,
            json: true,
            inputPropsFile: frozenProps,
          },
        },
        {
          ...dependencies,
          signal: nativeSignal,
          onOutputResult: (value) => {
            nativeResult = value;
          },
        },
      );
      if (nativeResult?.status === "failure")
        throw new OutputFailureError(nativeResult, nativeResult.error, false);
      if (!nativeResult)
        throw new Error(
          "source.result_missing: native capture did not report output metadata",
        );
      if (nativeResult) {
        for (const field of [
          "id",
          "width",
          "height",
          "fps",
          "durationFrames",
          "target",
        ] as const) {
          if (
            (nativeResult.composition?.[field] ?? null) !==
            (composition[field] ?? null)
          )
            throw new Error(
              `source.manifest_mismatch: native composition ${field} differs from prepared source metadata`,
            );
        }
      }
      // Keep native session identity when native capture was used; never claim a snapshot.
      if (nativeResult)
        result = { ...nativeResult, outputPath: result.outputPath };
    };
    if (request.kind === "composition") {
      await (dependencies.renderSourceOutput ?? renderSourceOutput)({
        output: result.outputPath!,
        container: resolveRendererContainer(
          request.config,
          request.options?.container,
        ),
        audioCodec: resolveRendererAudioCodec(
          request.config,
          request.options?.audioCodec,
        ),
        signal,
        renderVideo: async (path, videoSignal) => {
          if (prepared.renderVideo)
            await prepared.renderVideo(path, videoSignal);
          else await native(path, videoSignal);
        },
        renderAudio: async (path, audioSignal) => {
          const audio = prepared.renderAudio
            ? await prepared.renderAudio(path, audioSignal)
            : null;
          await close();
          return audio;
        },
      });
    } else {
      await mkdir(dirname(result.outputPath!), { recursive: true });
      const stage = await mkdtemp(
        join(
          dirname(result.outputPath!),
          `.${basename(result.outputPath!)}.velocast-`,
        ),
      );
      try {
        const candidate = join(stage, "frame.png");
        if (prepared.renderFrame)
          await prepared.renderFrame(result.request.frame!, candidate, signal);
        else await native(candidate, signal);
        await assertPng(candidate, composition.width, composition.height);
        await close();
        signal.throwIfAborted();
        await rename(candidate, result.outputPath!);
      } finally {
        await rm(stage, { recursive: true, force: true });
      }
    }
    report(result);
  } catch (error) {
    try {
      await close();
    } catch {
      // Preserve the preparation/capture failure when cleanup also fails.
    }
    const failure = failedOutputResult({}, error);
    result = { ...result, status: "failure", error: failure.error };
    report(result);
    throw new OutputFailureError(result, error, json);
  } finally {
    try {
      await close();
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true });
      if (!dependencies.signal) {
        process.removeListener("SIGINT", interrupt);
        process.removeListener("SIGTERM", interrupt);
      }
    }
  }
}

function freezeJson(value: unknown): void {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
}

function assertReferenceOptions(request: RenderRequest): void {
  const options = request.options ?? {};
  for (const [key, value] of Object.entries(options)) {
    if (key === "--" && Array.isArray(value) && value.length === 0) continue;
    if (
      value !== undefined &&
      !["json", "inputPropsFile", "frame", "config", "output"].includes(key)
    )
      throw new Error(
        `source.option_unsupported: source renderer override cannot honor ${key}`,
      );
  }
  for (const [key, value] of Object.entries(request.config.renderer ?? {})) {
    // The media runtime context honors binary selection for source-owned output.
    if (key === "binary") continue;
    if (value !== undefined)
      throw new Error(
        `source.option_unsupported: source renderer override cannot honor renderer.${key}`,
      );
  }
}

function assertDiagnosticPaths(
  request: RenderRequest,
  output: string,
  dependencies: RendererRunDependencies,
): void {
  const options = request.options as
    { report?: string; events?: string } | undefined;
  const key = (path: string) =>
    process.platform === "win32" ? path.toLowerCase() : path;
  for (const diagnostic of [
    options?.report,
    options?.events,
    request.config.renderer?.reportPath,
    request.config.renderer?.eventLogPath,
  ]) {
    if (
      diagnostic &&
      key(resolveCliOutputPath(diagnostic, dependencies.pathOptions)) ===
        key(output)
    )
      throw new Error(
        "source.output_conflict: diagnostic paths must differ from the output",
      );
  }
}

async function assertPng(
  path: string,
  width: number,
  height: number,
): Promise<void> {
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile())
    throw new Error(
      "source.frame_invalid: frame renderer did not produce a regular PNG file",
    );
  const bytes = await readFile(path);
  if (
    bytes.length < 33 ||
    !bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.toString("ascii", 12, 16) !== "IHDR" ||
    bytes.readUInt32BE(16) !== width ||
    bytes.readUInt32BE(20) !== height
  )
    throw new Error(
      "source.frame_invalid: frame renderer did not produce a PNG with composition dimensions",
    );
  let offset = 8;
  let hasImageData = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (
      end > bytes.length ||
      (offset === 8 && (type !== "IHDR" || length !== 13))
    )
      break;
    if (type === "IHDR" && offset !== 8) break;
    if (type === "IDAT") hasImageData = true;
    if (type === "IEND") {
      if (length === 0 && hasImageData && end === bytes.length) return;
      break;
    }
    offset = end;
  }
  throw new Error(
    "source.frame_invalid: frame PNG has incomplete or invalid chunks",
  );
}

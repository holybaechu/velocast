import type { HeadlessBrowser, LogLevel } from "@remotion/renderer";
import { BROWSER_PROTOCOL_VERSION } from "@velocast/core";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { isMainThread } from "node:worker_threads";
import type { VideoConfig } from "remotion/no-react";
import { loadProjectRemotionRuntime } from "./runtime-loader.js";
import { createUpstreamRemotionBridgeScript } from "./upstream-browser.js";

export { SUPPORTED_REMOTION_VERSIONS } from "./profiles.js";
export type { VideoConfig } from "remotion/no-react";

export interface PrepareRemotionSourceOptions {
  entryPoint: string;
  compositionId: string;
  inputProps?: Record<string, unknown>;
  browserExecutable?: string;
  /** Parent for an owned temporary directory. Its existing contents are never removed. */
  workDirectory?: string;
  signal?: AbortSignal;
  logLevel?: LogLevel;
  timeoutInMilliseconds?: number;
  onProgress?: (
    phase: "bundle" | "audio" | "reference",
    progress: number,
  ) => void;
}

export interface PreparedRemotionSource {
  composition: VideoConfig;
  /** Original Remotion runtime with the Velocast browser bridge installed. */
  url: string;
  /** Evaluates and mixes the original timeline. Supports upstream-encoded .aac and lossless .wav. */
  renderAudio(outputPath: string): Promise<string | null>;
  /** Compatibility reference using the original Remotion capture and encoder. */
  renderReference(outputPath: string): Promise<void>;
  renderReferenceFrame(frame: number, outputPath: string): Promise<void>;
  close(): Promise<void>;
}

const NO_AUDIO_ERROR =
  "The output format has neither audio nor video. This can happen if you are rendering an audio codec and the output file has no audio or the muted flag was passed.";

let bundling: Promise<unknown> = Promise.resolve();

function bundleProject<T>(operation: () => Promise<T>): Promise<T> {
  // Upstream changes process.cwd() while compiling. Serialize our calls and
  // restore cwd even when upstream throws before its own restoration point.
  const pending = bundling.then(async () => {
    const originalDirectory = process.cwd();
    try {
      return await operation();
    } finally {
      if (isMainThread && process.cwd() !== originalDirectory)
        process.chdir(originalDirectory);
    }
  });
  bundling = pending.catch(() => undefined);
  return pending;
}

/**
 * Keeps Remotion's original webpack entry, React contexts, media server and mixer.
 * Only the copy of index.html used by native capture receives the browser bridge.
 * Always close the source after capture, including on failure.
 */
export function prepareRemotionSource(
  options: PrepareRemotionSourceOptions,
): Promise<PreparedRemotionSource> {
  return openRemotionSource(options, false);
}

export type DiscoverRemotionCompositionsOptions = Omit<
  PrepareRemotionSourceOptions,
  "compositionId"
>;

/** Resolves original composition metadata and releases the bundle, server and browser. */
export function discoverRemotionCompositions(
  options: DiscoverRemotionCompositionsOptions,
): Promise<VideoConfig[]> {
  return openRemotionSource({ ...options, compositionId: "" }, true);
}

function openRemotionSource(
  options: PrepareRemotionSourceOptions,
  discover: true,
): Promise<VideoConfig[]>;
function openRemotionSource(
  options: PrepareRemotionSourceOptions,
  discover: false,
): Promise<PreparedRemotionSource>;
async function openRemotionSource(
  options: PrepareRemotionSourceOptions,
  discover: boolean,
): Promise<PreparedRemotionSource | VideoConfig[]> {
  options.signal?.throwIfAborted();
  const entryPoint = resolve(options.entryPoint);
  const runtime = loadProjectRemotionRuntime(entryPoint);
  const { bundle } = runtime.bundler;
  const {
    makeCancelSignal,
    openBrowser,
    renderMedia,
    renderStill,
    getCompositions,
    selectComposition,
    RenderInternals,
  } = runtime.renderer;
  const serialize = (data: Record<string, unknown>) =>
    runtime.serialize({ data, indent: undefined, staticBase: null })
      .serializedString;
  const logLevel = options.logLevel ?? "warn";
  const timeoutInMilliseconds = options.timeoutInMilliseconds ?? 30_000;
  // Snapshot before the first await: caller edits during bundling must not change
  // the timeline used by native capture, metadata resolution or the audio pass.
  const serializedInputProps = serialize(options.inputProps ?? {});
  const inputProps = runtime.deserialize(serializedInputProps);
  const temporaryParent = resolve(options.workDirectory ?? tmpdir());
  await mkdir(temporaryParent, { recursive: true });
  const workingDirectory = await mkdtemp(
    join(temporaryParent, "velocast-remotion-"),
  );
  const { cancel, cancelSignal } = makeCancelSignal();
  let browser: HeadlessBrowser | undefined;
  let server:
    Awaited<ReturnType<typeof RenderInternals.serveStatic>> | undefined;
  let downloadMap:
    ReturnType<typeof RenderInternals.makeDownloadMap> | undefined;
  let closed = false;
  let prepared = false;
  let closePromise: Promise<void> | undefined;
  const operations = new Set<Promise<unknown>>();
  const closeBrowser = (instance: HeadlessBrowser): Promise<void> => {
    if (runtime.profile.browserClose === "options") {
      return (
        instance as unknown as {
          close(options: { silent: boolean }): Promise<void>;
        }
      ).close({ silent: true });
    }
    return instance.close(true, logLevel, false);
  };

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closed = true;
    cancel();
    options.signal?.removeEventListener("abort", onAbort);
    closePromise = (async () => {
      const failures: unknown[] = [];
      const attempt = async (action: () => Promise<unknown>) => {
        try {
          await action();
        } catch (error) {
          failures.push(error);
        }
      };
      // Closing our browser also interrupts metadata selection, which has no public
      // cancel signal. Wait for all render cleanup before removing bundle assets.
      if (browser) await attempt(() => closeBrowser(browser!));
      await Promise.allSettled([...operations]);
      if (server) await attempt(() => server!.close());
      if (downloadMap)
        await attempt(() =>
          rm(downloadMap!.assetDir, { recursive: true, force: true }),
        );
      await attempt(() =>
        rm(workingDirectory, { recursive: true, force: true }),
      );
      if (failures.length)
        throw new AggregateError(
          failures,
          "Failed to fully close the Remotion source",
        );
    })();
    return closePromise;
  };
  const onAbort = () => {
    cancel();
    // During preparation, the catch below owns cleanup after any pending resource
    // acquisition. Once returned, abort closes the entire source automatically.
    if (prepared) void close().catch(() => {});
    else if (browser) void closeBrowser(browser).catch(() => {});
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const assertOpen = () => {
    options.signal?.throwIfAborted();
    if (closed) throw new Error("The Remotion source has been closed");
  };

  try {
    assertOpen();
    const bundleDirectory = await bundleProject(() => {
      assertOpen();
      return bundle({
        entryPoint,
        outDir: join(workingDirectory, "bundle"),
        enableCaching: false,
        onProgress: (progress) =>
          options.onProgress?.("bundle", progress / 100),
      });
    });
    assertOpen();
    downloadMap = RenderInternals.makeDownloadMap();
    server = await RenderInternals.serveStatic(bundleDirectory, {
      port: null,
      downloadMap,
      remotionRoot: dirname(entryPoint),
      concurrency: 1,
      ...{ [runtime.profile.serverThreads]: 1 },
      logLevel,
      indent: false,
      offthreadVideoCacheSizeInBytes: null,
      binariesDirectory: null,
      forceIPv4: true,
    });
    assertOpen();
    const serveUrl = `http://localhost:${server.port}`;
    browser = await openBrowser("chrome", {
      browserExecutable: options.browserExecutable,
      logLevel,
    });
    assertOpen();
    const metadataOptions = {
      serveUrl,
      inputProps: runtime.deserialize(serializedInputProps),
      puppeteerInstance: browser,
      ...(!runtime.profile.metadataLogLevelBug || logLevel === "verbose"
        ? { logLevel }
        : {}),
      timeoutInMilliseconds,
    };
    if (discover) {
      const compositions = await getCompositions(serveUrl, metadataOptions);
      assertOpen();
      await close();
      return compositions;
    }
    const selectedComposition = await selectComposition({
      serveUrl,
      id: options.compositionId,
      inputProps: runtime.deserialize(serializedInputProps),
      puppeteerInstance: browser,
      // 4.0.244 treats every supplied logLevel as verbose due to a precedence
      // bug. Omission retains its quiet default; request verbosity explicitly.
      ...(!runtime.profile.metadataLogLevelBug || logLevel === "verbose"
        ? { logLevel }
        : {}),
      timeoutInMilliseconds,
    });
    assertOpen();
    const serializedComposition = serialize(selectedComposition);
    const composition = runtime.deserialize<VideoConfig>(serializedComposition);
    const script = createUpstreamRemotionBridgeScript({
      inputProps,
      composition: {
        ...composition,
        serializedResolvedPropsWithCustomSchema: serialize(composition.props),
      },
      serializedInputPropsWithCustomSchema: serializedInputProps,
      mediaProxyPort: server.port,
      timeoutInMilliseconds,
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      profile: runtime.profile.id,
    });
    const html = await readFile(join(bundleDirectory, "index.html"), "utf8");
    const bundleScript = /<script\s+src="[^"]*bundle\.js"><\/script>/;
    if (!bundleScript.test(html))
      throw new Error("Unsupported Remotion bundle: missing bundle script");
    await writeFile(
      join(bundleDirectory, "velocast.html"),
      html.replace(
        bundleScript,
        (tag) =>
          `<script>${script.replace(/<\/script/gi, "<\\/script")}</script>${tag}`,
      ),
    );
    assertOpen();

    const render = async (
      outputPath: string,
      phase: "audio" | "reference",
    ): Promise<string | null> => {
      assertOpen();
      const outputLocation = resolve(outputPath);
      const extension = extname(outputLocation).toLowerCase();
      if (phase === "audio" && extension !== ".aac" && extension !== ".wav") {
        throw new Error(
          `Unsupported Remotion audio output extension ${JSON.stringify(extension)}. Use .aac or .wav.`,
        );
      }
      await mkdir(dirname(outputLocation), { recursive: true });
      assertOpen();
      const operation = renderMedia({
        serveUrl,
        composition: runtime.deserialize<VideoConfig>(serializedComposition),
        inputProps: runtime.deserialize(serializedInputProps),
        codec:
          phase === "audio" ? (extension === ".aac" ? "aac" : "wav") : "h264",
        ...(phase === "reference" ? { imageFormat: "png" as const } : {}),
        outputLocation,
        puppeteerInstance: browser,
        concurrency: 1,
        cancelSignal,
        logLevel,
        timeoutInMilliseconds,
        overwrite: true,
        onProgress: ({ progress }) => options.onProgress?.(phase, progress),
      });
      operations.add(operation);
      try {
        await operation;
        assertOpen();
        return outputLocation;
      } catch (error) {
        options.signal?.throwIfAborted();
        if (
          phase === "audio" &&
          error instanceof Error &&
          error.message === NO_AUDIO_ERROR
        )
          return null;
        throw error;
      } finally {
        operations.delete(operation);
      }
    };
    prepared = true;
    return {
      composition: runtime.deserialize<VideoConfig>(serializedComposition),
      url: `${serveUrl}/velocast.html`,
      renderAudio: (outputPath) => render(outputPath, "audio"),
      renderReference: async (outputPath) => {
        await render(outputPath, "reference");
      },
      renderReferenceFrame: async (frame, outputPath) => {
        assertOpen();
        if (
          !Number.isSafeInteger(frame) ||
          frame < 0 ||
          frame >= composition.durationInFrames
        )
          throw new Error(
            "Frame must be an integer within the composition duration",
          );
        const output = resolve(outputPath);
        const extension = extname(output).toLowerCase();
        if (![".png", ".jpeg", ".jpg", ".webp"].includes(extension))
          throw new Error(
            "Reference frame output must be .png, .jpeg, .jpg or .webp",
          );
        await mkdir(dirname(output), { recursive: true });
        assertOpen();
        const operation = renderStill({
          serveUrl,
          composition: runtime.deserialize<VideoConfig>(serializedComposition),
          inputProps: runtime.deserialize(serializedInputProps),
          frame,
          output,
          imageFormat:
            extension === ".png"
              ? "png"
              : extension === ".webp"
                ? "webp"
                : "jpeg",
          puppeteerInstance: browser,
          cancelSignal,
          logLevel,
          timeoutInMilliseconds,
          overwrite: true,
        });
        operations.add(operation);
        try {
          await operation;
          assertOpen();
        } catch (error) {
          options.signal?.throwIfAborted();
          throw error;
        } finally {
          operations.delete(operation);
        }
      },
      close,
    };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

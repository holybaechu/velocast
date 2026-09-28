import { randomUUID } from "node:crypto";
import { BROWSER_PROTOCOL_VERSION } from "@velocast/core";
import {
  launchCdpBrowser,
  runMediaOperation,
  type CdpBrowser,
  type MediaProbe,
} from "velocast/source-media";
import {
  mkdir,
  rename,
  copyFile,
  stat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { isMainThread } from "node:worker_threads";
import type { VideoConfig } from "remotion/no-react";
import { loadProjectRemotionRuntime } from "./runtime-loader.js";
import { createUpstreamRemotionBridgeScript } from "./upstream-browser.js";
import { serveRemotionBundle } from "./media-server.js";
import { remotionAudioPlan, type RemotionMediaAsset } from "./audio-plan.js";
export { SUPPORTED_REMOTION_VERSIONS } from "./profiles.js";
export type { VideoConfig } from "remotion/no-react";
export interface PrepareRemotionSourceOptions {
  entryPoint: string;
  compositionId: string;
  inputProps?: Record<string, unknown>;
  browserExecutable?: string;
  workDirectory?: string;
  signal?: AbortSignal;
  logLevel?: "trace" | "verbose" | "info" | "warn" | "error";
  timeoutInMilliseconds?: number;
  onProgress?: (
    phase: "bundle" | "audio" | "reference",
    progress: number,
  ) => void;
}
export interface PreparedRemotionSource {
  composition: VideoConfig;
  url: string;
  /** Original timeline audio, decoded and mixed through WebCodecs. */
  renderAudio(outputPath: string): Promise<string | null>;
  /** Original browser output assembled through the WebCodecs encoder. */
  renderReference(outputPath: string): Promise<void>;
  renderReferenceFrame(frame: number, outputPath: string): Promise<void>;
  close(): Promise<void>;
}
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

export function prepareRemotionSource(
  options: PrepareRemotionSourceOptions,
): Promise<PreparedRemotionSource> {
  return openRemotionSource(options, false);
}
export type DiscoverRemotionCompositionsOptions = Omit<
  PrepareRemotionSourceOptions,
  "compositionId"
>;
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
  const runtime = loadProjectRemotionRuntime(resolve(options.entryPoint));
  const serialize = (data: Record<string, unknown>) =>
    runtime.serialize({ data, indent: undefined, staticBase: null })
      .serializedString;
  const serializedInputProps = serialize(options.inputProps ?? {});
  const timeout = options.timeoutInMilliseconds ?? 30_000;
  const parent = resolve(options.workDirectory ?? tmpdir());
  await mkdir(parent, { recursive: true });
  const workspace = await mkdtemp(join(parent, "velocast-remotion-"));
  const owner = new AbortController(),
    signal = options.signal
      ? AbortSignal.any([owner.signal, options.signal])
      : owner.signal;
  let browser: CdpBrowser | undefined,
    server: Awaited<ReturnType<typeof serveRemotionBundle>> | undefined;
  let tail: Promise<unknown> = Promise.resolve(),
    closePromise: Promise<void> | undefined,
    closed = false;
  const check = () => {
    signal.throwIfAborted();
    if (closed) throw new Error("The Remotion source has been closed");
  };
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closed = true;
    owner.abort();
    options.signal?.removeEventListener("abort", onAbort);
    closePromise = (async () => {
      const failures: unknown[] = [];
      try {
        await browser?.close();
      } catch (error) {
        failures.push(error);
      }
      await tail.catch(() => {});
      try {
        await server?.close();
      } catch (error) {
        failures.push(error);
      }
      const target = await realpath(workspace);
      if (
        dirname(target) !== (await realpath(parent)) ||
        !basename(target).startsWith("velocast-remotion-")
      )
        throw new Error("remotion.cleanup_scope");
      await rm(target, { recursive: true, force: true });
      if (failures.length)
        throw new AggregateError(
          failures,
          "Failed to fully close the Remotion source",
        );
    })();
    return closePromise;
  };
  const onAbort = () => {
    void close().catch(() => {});
  };
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(() => {
      check();
      return operation();
    });
    tail = result.catch(() => {});
    return result;
  };
  try {
    const bundle = await bundleProject(() => {
      check();
      return runtime.bundler.bundle({
        entryPoint: resolve(options.entryPoint),
        outDir: join(workspace, "bundle"),
        enableCaching: false,
        onProgress: (progress) =>
          options.onProgress?.("bundle", progress / 100),
      });
    });
    check();
    server = await serveRemotionBundle(bundle, workspace, signal);
    check();
    const html = await readFile(join(bundle, "index.html"), "utf8");
    const bundleScript = /<script\s+src="[^"]*bundle\.js"><\/script>/;
    const inject = (script: string) => {
      if (!bundleScript.test(html))
        throw new Error("Unsupported Remotion bundle: missing bundle script");
      return html.replace(
        bundleScript,
        (tag) =>
          `<script>${script.replace(/<\/script/gi, "<\\/script")}</script>${tag}`,
      );
    };
    const bootstrap = `window.process ??= {env:{}}; window.process.env.NODE_ENV='production'; Object.assign(window,${JSON.stringify({ remotion_inputProps: serializedInputProps, remotion_puppeteerTimeout: timeout, remotion_initialFrame: 0, remotion_attempt: 1, remotion_proxyPort: server.port, remotion_audioEnabled: false, remotion_videoEnabled: false, remotion_isMainTab: true, remotion_mediaCacheSizeInBytes: null, remotion_initialMemoryAvailable: 536870912, remotion_sampleRate: 48000, remotion_logLevel: options.logLevel ?? "warn" })});`;
    await writeFile(join(bundle, "metadata.html"), inject(bootstrap));
    browser = await launchCdpBrowser(`${server.url}/metadata.html`, {
      executable: options.browserExecutable,
      timeoutMs: timeout,
    });
    check();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const wait = async (expression: string): Promise<void> => {
      const started = Date.now();
      for (;;) {
        check();
        try {
          if (await browser!.evaluate<boolean>(`Boolean(${expression})`))
            return;
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !/context.*(destroyed|not found)|Cannot find context/i.test(
              error.message,
            )
          )
            throw error;
        }
        if (Date.now() - started > timeout)
          throw new Error("remotion.browser_timeout");
        await new Promise((resolve) => setTimeout(resolve, 8));
      }
    };
    await wait("typeof window.remotion_setBundleMode === 'function'");
    await browser.evaluate(
      "window.remotion_setBundleMode({type:'evaluation'})",
    );
    await wait("window.remotion_renderReady === true");
    type Raw = Record<string, unknown> & {
      serializedResolvedPropsWithCustomSchema: string;
      serializedDefaultPropsWithCustomSchema: string;
    };
    const raw = await browser.evaluate<Raw[]>(
      discover
        ? "window.getStaticCompositions()"
        : `window.remotion_calculateComposition(${JSON.stringify(options.compositionId)}).then(value=>[value])`,
    );
    const compositions = raw.map(
      (item) =>
        ({
          ...item,
          ...(discover ? {} : { id: options.compositionId }),
          props: runtime.deserialize(
            item.serializedResolvedPropsWithCustomSchema,
          ),
          defaultProps: runtime.deserialize(
            item.serializedDefaultPropsWithCustomSchema,
          ),
        }) as unknown as VideoConfig,
    );
    check();
    if (discover) {
      await close();
      return compositions;
    }
    const composition = compositions[0]!;
    if (
      !composition ||
      !Number.isSafeInteger(composition.durationInFrames) ||
      composition.durationInFrames < 1 ||
      composition.durationInFrames > 250000
    )
      throw new Error("remotion.composition_limit: require 1..250000 frames");
    const serializedComposition = serialize(composition);
    const script = createUpstreamRemotionBridgeScript({
      inputProps: runtime.deserialize(serializedInputProps),
      composition: {
        ...composition,
        serializedResolvedPropsWithCustomSchema: serialize(composition.props),
      },
      serializedInputPropsWithCustomSchema: serializedInputProps,
      mediaProxyPort: server.port,
      timeoutInMilliseconds: timeout,
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      profile: runtime.profile.id,
    });
    await writeFile(join(bundle, "velocast.html"), inject(script));
    const url = `${server.url}/velocast.html`;
    const begin = async () => {
      check();
      await browser!.call("Emulation.setDeviceMetricsOverride", {
        width: composition.width,
        height: composition.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const target = `${url}?run=${Date.now()}`;
      await browser!.call("Page.navigate", { url: target });
      await wait(
        `location.href === ${JSON.stringify(target)} && window.__velocast !== undefined`,
      );
      await browser!.evaluate("window.__velocast.getCompositions()");
      check();
    };
    const seek = async (frame: number) => {
      check();
      await browser!.evaluate(
        `window.__velocast.seekFrame(${JSON.stringify(composition.id)},${frame})`,
      );
      check();
    };
    const screenshot = async (output: string) => {
      const extension = extname(output).toLowerCase(),
        format =
          extension === ".png"
            ? "png"
            : extension === ".webp"
              ? "webp"
              : [".jpg", ".jpeg"].includes(extension)
                ? "jpeg"
                : undefined;
      if (!format)
        throw new Error(
          "Reference frame output must be .png, .jpeg, .jpg or .webp",
        );
      await mkdir(dirname(resolve(output)), { recursive: true });
      const image = await browser!.call<{ data: string }>(
        "Page.captureScreenshot",
        { format, captureBeyondViewport: false },
      );
      check();
      await writeFile(resolve(output), Buffer.from(image.data, "base64"));
    };
    const audioSources = new Map<string, Promise<string | null>>();
    const freezeAudio = (
      src: string,
      type: "audio" | "video",
    ): Promise<string | null> => {
      const key = `${type}:${src}`;
      let pending = audioSources.get(key);
      if (!pending) {
        pending = (async () => {
          const path = await server!.freeze(src);
          if (type === "video") {
            const probe = await runMediaOperation<MediaProbe>(
              { kind: "probe", path },
              { signal },
            );
            if (!probe.audio) return null;
          }
          return path;
        })();
        audioSources.set(key, pending);
      }
      return pending;
    };
    const collect = async (capture: boolean) => {
      await begin();
      const frames: RemotionMediaAsset[][] = [],
        framePaths: string[] = [];
      for (let frame = 0; frame < composition.durationInFrames; frame++) {
        await seek(frame);
        const assets = await browser!.evaluate<RemotionMediaAsset[]>(
          "window.remotion_collectAssets ? window.remotion_collectAssets().filter(a=>a.type==='audio'||a.type==='video') : []",
        );
        frames.push(assets);
        if (capture) {
          const output = join(workspace, `frame-${frame}.png`);
          await screenshot(output);
          framePaths.push(output);
        }
        options.onProgress?.(
          capture ? "reference" : "audio",
          (frame + 1) / composition.durationInFrames,
        );
      }
      return {
        plan: await remotionAudioPlan(
          frames,
          composition.fps,
          (composition as VideoConfig & { defaultSampleRate?: number })
            .defaultSampleRate ?? 48000,
          freezeAudio,
        ),
        framePaths,
      };
    };
    const publish = async (
      operation: { kind: string; [key: string]: unknown },
      output: string,
    ): Promise<void> => {
      const candidate = join(
        workspace,
        `output-${randomUUID()}${extname(output)}`,
      );
      try {
        await runMediaOperation(
          { ...operation, outputPath: candidate },
          { signal },
        );
        check();
        const file = await stat(candidate);
        if (!file.isFile() || file.size === 0)
          throw new Error("remotion.invalid_media_output");
        await mkdir(dirname(resolve(output)), { recursive: true });
        check();
        try {
          await rename(candidate, resolve(output));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
          const sibling = join(
            dirname(resolve(output)),
            `.velocast-publish-${randomUUID()}${extname(output)}`,
          );
          try {
            await copyFile(candidate, sibling);
            check();
            await rename(sibling, resolve(output));
          } finally {
            await rm(sibling, { force: true });
          }
        }
      } finally {
        await rm(candidate, { force: true });
      }
    };
    const audio = async (output: string): Promise<string | null> => {
      if (extname(output).toLowerCase() !== ".wav")
        throw new Error(
          "remotion.audio_format: use .wav; source assembly encodes AAC through WebCodecs",
        );
      const { plan } = await collect(false);
      if (!plan.clips.length) return null;
      await mkdir(dirname(resolve(output)), { recursive: true });
      await publish(
        { kind: "mix-audio", plan, channels: 2, format: "wav" },
        output,
      );
      check();
      return resolve(output);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    check();
    return {
      composition: runtime.deserialize<VideoConfig>(serializedComposition),
      url,
      renderAudio: (output) => enqueue(() => audio(output)),
      renderReference: (output) =>
        enqueue(async () => {
          const { plan, framePaths } = await collect(true);
          let audioPath: string | undefined;
          if (plan.clips.length) {
            audioPath = join(workspace, `audio-${Date.now()}.wav`);
            await runMediaOperation(
              {
                kind: "mix-audio",
                plan,
                channels: 2,
                format: "wav",
                outputPath: audioPath,
              },
              { signal },
            );
          }
          await publish(
            {
              kind: "encode-frames",
              framePaths,
              fps: composition.fps,
              width: composition.width,
              height: composition.height,
              bitrate: 8_000_000,
              codec: "h264",
              audioPath,
            },
            output,
          );
          check();
        }),
      renderReferenceFrame: (frame, output) =>
        enqueue(async () => {
          if (
            !Number.isSafeInteger(frame) ||
            frame < 0 ||
            frame >= composition.durationInFrames
          )
            throw new Error(
              "Frame must be an integer within the composition duration",
            );
          await begin();
          await seek(frame);
          await screenshot(output);
        }),
      close,
    };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

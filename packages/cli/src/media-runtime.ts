import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { RendererRuntimeAcquisition } from "./renderer-runtime.js";
import { getInvocationCwd } from "./paths.js";
import { resolveDeveloperElectronRuntime } from "./electron-runtime.js";

export interface MediaProbe {
  duration: number;
  videoTrackCount?: number;
  audioTrackCount?: number;
  video?: {
    duration?: number;
    width: number;
    height: number;
    codedWidth: number;
    codedHeight: number;
    rotation: number;
    codec: string;
    colorSpace?: {
      transfer?: string;
      primaries?: string;
      matrix?: string;
      fullRange?: boolean;
    };
    timeBase: { numerator: number; denominator: number };
    frames?: Array<{ pts: number; duration: number; keyframe: boolean }>;
  };
  audio?: {
    codec?: string;
    sampleRate: number;
    channels: number;
    duration: number;
  };
}
export type MediaOperation = { kind: string; [key: string]: unknown };
export interface MediaOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}
export type MediaRunner = <T = unknown>(
  operation: MediaOperation,
  options?: MediaOptions,
) => Promise<T>;
export interface MediaSession {
  run: MediaRunner;
  close(): Promise<void>;
}
export type MediaSessionFactory = (
  options?: MediaOptions,
) => Promise<MediaSession>;
export interface MediaRuntimeContext {
  configuredBinary?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}
const contextKey = Symbol.for("velocast.media-runtime-context.v1");
const shared = globalThis as unknown as Record<
  symbol,
  AsyncLocalStorage<MediaRuntimeContext> | undefined
>;
// Source adapters can load the installed CLI while a development CLI runs from
// TypeScript. Both module instances must share the same async request scope.
const mediaContexts = (shared[contextKey] ??=
  new AsyncLocalStorage<MediaRuntimeContext>());
export function withMediaRuntimeContext<T>(
  context: MediaRuntimeContext,
  operation: () => T,
): T {
  return mediaContexts.run(
    Object.freeze({
      ...context,
      env: Object.freeze({ ...(context.env ?? process.env) }),
    }),
    operation,
  );
}
const require = createRequire(import.meta.url);
function mediaClient(options: MediaOptions) {
  options.signal?.throwIfAborted();
  const context = mediaContexts.getStore();
  let env = options.env ?? context?.env ?? process.env;
  const cwd = context?.cwd ?? getInvocationCwd({ env });
  let renderer = env.VELOCAST_RENDERER_BINARY;
  if (
    context ||
    renderer ||
    !env.VELOCAST_ELECTRON_HOST_SCRIPT ||
    !env.VELOCAST_ELECTRON_BINARY
  ) {
    const installed = new RendererRuntimeAcquisition({ env, cwd }).inspect(
      context?.configuredBinary,
    );
    if (installed) {
      env = installed.env;
      renderer = installed.binary;
    }
  }
  const runtime = resolveDeveloperElectronRuntime(
    resolve(cwd, renderer ?? "velocast-renderer"),
    cwd,
    env,
  );
  const client = require(
    join(dirname(runtime.hostScript), "media-client.cjs"),
  ) as {
    runMediaOperation: MediaRunner;
    createMediaSession: MediaSessionFactory;
  };
  return {
    client,
    options: {
      ...options,
      env: {
        ...env,
        VELOCAST_ELECTRON_BINARY: runtime.electron,
        VELOCAST_ELECTRON_HOST_SCRIPT: runtime.hostScript,
        VELOCAST_NODE_BINARY: process.execPath,
      },
    },
  };
}
/** The same pinned host performs every media operation in developer and installed runtimes. */
export const runMediaOperation: MediaRunner = async <T>(
  operation: MediaOperation,
  options: MediaOptions = {},
): Promise<T> => {
  const resolved = mediaClient(options);
  return resolved.client.runMediaOperation<T>(operation, resolved.options);
};
/** A caller-owned utility process with reusable demux/decode state. */
export const createMediaSession: MediaSessionFactory = async (options = {}) => {
  const resolved = mediaClient(options);
  return resolved.client.createMediaSession(resolved.options);
};

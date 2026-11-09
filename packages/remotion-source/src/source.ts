import type { CompositionManifest, SourceAdapter } from "@velocast/core";
import {
  discoverRemotionCompositions,
  prepareRemotionSource,
} from "./upstream-host.js";

export interface RemotionSourceOptions {
  /** Remotion's unchanged registerRoot() entry file. Resolved relative to the config. */
  entry: string;
  /** Capture uses Velocast's native GPU handoff. */
  backend?: "native";
  browserExecutable?: string;
  workDirectory?: string;
  timeoutInMilliseconds?: number;
}

function asManifest(composition: {
  id: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
}): CompositionManifest {
  return {
    id: composition.id,
    width: composition.width,
    height: composition.height,
    fps: composition.fps,
    durationFrames: composition.durationInFrames,
    target: "#remotion-canvas",
  };
}

/** Node source adapter for an original Remotion project. No browser work starts here. */
export function remotionSource(options: RemotionSourceOptions): SourceAdapter {
  if (!options || typeof options.entry !== "string" || !options.entry.trim()) {
    throw new Error("remotion.entry_invalid: entry must be a non-empty path");
  }
  const backend = options.backend ?? "native";
  if (backend !== "native") {
    throw new Error(
      "remotion.backend_invalid: the reference PNG-capture backend was removed; use backend: 'native' or omit backend (requires native GPU capture)",
    );
  }
  const entry = options.entry.trim();
  const browserExecutable = options.browserExecutable;
  const workDirectory = options.workDirectory;
  const timeoutInMilliseconds = options.timeoutInMilliseconds;

  const adapter: SourceAdapter = {
    kind: "remotion",
    entry,
    async prepare(context) {
      context.signal.throwIfAborted();
      const common = {
        entryPoint: context.entry,
        inputProps: context.inputProps,
        browserExecutable,
        workDirectory,
        timeoutInMilliseconds,
        signal: context.signal,
      };
      if (context.operation === "inspect" && !context.compositionId) {
        const compositions = await discoverRemotionCompositions(common);
        context.signal.throwIfAborted();
        return {
          compositions: compositions.map(asManifest),
          close: async () => undefined,
        };
      }
      if (!context.compositionId) {
        throw new Error("remotion.composition_required: choose a composition");
      }
      const prepared = await prepareRemotionSource({
        ...common,
        compositionId: context.compositionId,
      });
      if (context.operation === "inspect") {
        const composition = asManifest(prepared.composition);
        await prepared.close();
        context.signal.throwIfAborted();
        return {
          compositions: [composition],
          close: async () => undefined,
        };
      }
      return {
        compositions: [asManifest(prepared.composition)],
        url: prepared.url,
        renderAudio: async (outputPath: string, signal: AbortSignal) => {
          signal.throwIfAborted();
          const audio = await prepared.renderAudio(
            outputPath.replace(/\.(aac|m4a)$/i, ".wav"),
          );
          signal.throwIfAborted();
          return audio;
        },
        close: prepared.close,
      };
    },
  };
  return Object.freeze(adapter);
}

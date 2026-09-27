import { createContext, useContext } from "react";
import type { SequenceTiming } from "@velocast/core";
import type { VideoConfig } from "@velocast/react";
import type { AudioDeclarationRuntime } from "./audio.js";

export interface CompatibilityContext {
  readonly id: string;
  readonly defaultProps: Record<string, unknown>;
  readonly config: VideoConfig;
  readonly audio: AudioDeclarationRuntime;
}
export const RemotionCompatibilityContext = createContext<CompatibilityContext | null>(null);
export const RemotionSequenceContext = createContext<readonly SequenceTiming[]>(Object.freeze([]));
export function useRemotionSequences(): readonly SequenceTiming[] {
  return useContext(RemotionSequenceContext);
}
export function useCompatibilityContext(): CompatibilityContext {
  const context = useContext(RemotionCompatibilityContext);
  if (!context) throw new Error("VELOCAST_REMOTION_CONTEXT_MISSING: register through @velocast/remotion before using the pinned remotion bridge");
  return context;
}

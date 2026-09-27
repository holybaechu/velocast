import type { CompositionManifest } from "./types.js";

/** A Node-side project integration. Each prepare call owns an isolated lifecycle. */
export interface SourceAdapter {
  readonly kind: string;
  readonly entry: string;
  prepare(context: SourceAdapterContext): Promise<PreparedSource>;
}

export interface SourceAdapterContext {
  /** Absolute project entry, resolved relative to the Velocast config file. */
  entry: string;
  compositionId?: string;
  /** JSON input captured once for discovery, video and audio. */
  inputProps: Record<string, unknown>;
  signal: AbortSignal;
  operation: "inspect" | "frame" | "render";
}

export interface PreparedSource {
  compositions: readonly CompositionManifest[];
  /** Browser frame protocol URL for native capture. */
  url?: string;
  renderAudio?(outputPath: string, signal: AbortSignal): Promise<string | null>;
  /** Optional source renderer override; otherwise the CLI uses native capture. */
  renderVideo?(outputPath: string, signal: AbortSignal): Promise<void>;
  renderFrame?(
    frame: number,
    outputPath: string,
    signal: AbortSignal,
  ): Promise<void>;
  /** Release all resources. The coordinator calls this before publishing output. */
  close(): Promise<void>;
}

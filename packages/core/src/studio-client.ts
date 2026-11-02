import type { CompositionManifest } from "./types.js";

/** A browser's observed state, distinct from the server's saved source. */
export interface StudioClientState {
  revision: number;
  sourceVersion: string;
  compositions: CompositionManifest[];
  compositionId?: string;
  frame?: number;
  selectedElementId?: string;
  sourceRevision?: string;
  dirty: boolean;
  ready: boolean;
  exportReady: boolean;
  playing: boolean;
  error?: string;
}

export interface StudioClient extends StudioClientState {
  clientId: string;
  updatedAt: string;
}

export type StudioControl =
  | { action: "play" | "pause" }
  | { action: "seek"; frame: number }
  | { action: "select"; elementId: string }
  | { action: "composition"; compositionId: string };

export type StudioClientCommand = StudioControl & {
  id: string;
  expectedRevision: number;
  expectedSourceVersion: string;
};

export interface StudioClientAcknowledgement {
  id: string;
  status: "succeeded" | "failed";
  error?: string;
}

export interface StudioHeartbeat {
  state: StudioClientState;
  acknowledgements?: StudioClientAcknowledgement[];
}

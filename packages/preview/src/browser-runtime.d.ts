import type { RenderSession } from "@velocast/core";
export interface BrowserRuntime {
  assertProtocol(version: number): number;
  bindSession(session: RenderSession): Promise<void>;
  renderEnvironment(width: number, height: number): void;
  selectTarget(selector: string): void;
  waitForReady(): Promise<void> | void;
  completeFrame<T>(
    seek: (signal?: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}
/** Generated at build time from the trusted native runtime source, not eval. */
export const browserRuntime: BrowserRuntime;
export const browserProtocolVersion: number;

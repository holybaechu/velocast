export type { BrowserProtocolOptions } from "./runtime.js";
export {
  defaultVelocastRuntime,
  defaultVelocastRuntime as runtime,
  VelocastRuntime,
} from "./runtime.js";
import { defaultVelocastRuntime } from "./runtime.js";
import type {
  BrowserProtocol,
  CompositionManifest,
  FrameAdapter,
  FrameAdapterRegistrationOptions,
  VelocastGlobal,
} from "./types.js";
import type { BrowserProtocolOptions } from "./runtime.js";

export function installBrowserProtocol(
  options: BrowserProtocolOptions = {},
): BrowserProtocol {
  return defaultVelocastRuntime.installBrowserProtocol(options);
}

export function registerFrameAdapter(
  compositionId: string,
  adapter: FrameAdapter,
  options: FrameAdapterRegistrationOptions,
): BrowserProtocol {
  return defaultVelocastRuntime.registerFrameAdapter(
    compositionId,
    adapter,
    options,
  );
}

/** Lists the prepared catalog. For projects, await protocol.getCompositions() or setInputProps() first. */
export function getRenderableCompositions(): CompositionManifest[] {
  return defaultVelocastRuntime.getRenderableCompositions();
}

export function clearFrameAdaptersForTest(): void {
  defaultVelocastRuntime.clearFrameAdaptersForTest();
}

export const velocastGlobal: VelocastGlobal = defaultVelocastRuntime.global;

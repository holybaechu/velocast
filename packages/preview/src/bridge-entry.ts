import { installChildBridge } from "./child-bridge.js";
import { browserRuntime, browserProtocolVersion } from "./browser-runtime.js";
import { previewConfig } from "./config.js";

installChildBridge(
  window,
  previewConfig.parentOrigin,
  browserRuntime,
  browserProtocolVersion,
);

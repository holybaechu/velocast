import { installChildBridge } from "./child-bridge.js";
import { browserRuntime, browserProtocolVersion } from "./browser-runtime.js";
import { studioConfig } from "./config.js";

installChildBridge(
  window,
  studioConfig.parentOrigin,
  browserRuntime,
  browserProtocolVersion,
);

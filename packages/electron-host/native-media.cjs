"use strict";
let registered = false;
const { loadNodeAv } = require("./native-binding.cjs");
// DEBUG-native-stage: temporary first-frame crash probe; remove after diagnosis.
function installNativeStageProbe() {
  const trace = process.env.VELOCAST_MEDIA_TRACE;
  if (!trace) return loadNodeAv();
  const fs = require("node:fs");
  const log = (operation, phase, target, args, error) => {
    try {
      const frame =
        operation === "SoftwareScaleContext.scaleFrame" ? args[0] : target;
      fs.appendFileSync(
        trace,
        JSON.stringify({
          stage: "DEBUG-native-stage",
          pid: process.pid,
          operation,
          phase,
          width: frame?.width,
          height: frame?.height,
          ...(error === undefined
            ? {}
            : { error: String(error?.message ?? error) }),
        }) + "\n",
        { mode: 0o600 },
      );
    } catch {
      // Diagnostics must not change native method results or failure handling.
    }
  };
  log("node-av.load", "before", null, []);
  const native = loadNodeAv();
  log("node-av.load", "after", null, []);
  for (const [name, method] of [
    ["CodecContext", "open2"],
    ["Frame", "fromBuffer"],
    ["SoftwareScaleContext", "scaleFrame"],
  ]) {
    const prototype = native[name].prototype;
    const original = prototype[method];
    const operation = `${name}.${method}`;
    prototype[method] = function (...args) {
      log(operation, "before", this, args);
      let result;
      try {
        result = Reflect.apply(original, this, args);
      } catch (error) {
        log(operation, "throw", this, args, error);
        throw error;
      }
      if (result && typeof result.then === "function") {
        // Observe settlement but return the exact original promise.
        result.then(
          () => log(operation, "after", this, args),
          (error) => log(operation, "reject", this, args, error),
        );
      } else {
        log(operation, "after", this, args);
      }
      return result;
    };
  }
  return native;
}
function registerNativeMedia() {
  if (!registered) {
    installNativeStageProbe();
    require("mediabunny").registerEncoder(
      require("./native-audio.cjs").NativeAudioEncoder,
    );
    require("mediabunny").registerDecoder(
      require("./native-prores.cjs").NativeProresDecoder,
    );
    // Native software decoding is deterministic across GPU drivers; hardware
    // interop remains available through the explicit WebCodecs backend.
    require("@mediabunny/server").registerMediabunnyServer({
      hardwareContext: null,
    });
    registered = true;
  }
}
module.exports = { registerNativeMedia };

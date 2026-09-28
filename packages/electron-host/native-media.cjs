"use strict";
let registered = false;
function registerNativeMedia() {
  if (!registered) {
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

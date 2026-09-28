"use strict";
const { createRequire } = require("node:module");
const { basename } = require("node:path");
const { constants } = require("node:os");
let controlledNodeAv;

function loadNodeAv() {
  const linuxElectron =
    process.platform === "linux" && process.versions.electron;
  if (linuxElectron && controlledNodeAv) return controlledNodeAv;
  // Resolve from the server extension, whose node-av dependency may have a
  // different location from this host under a package manager's layout.
  const fromServer = createRequire(require.resolve("@mediabunny/server"));
  if (!linuxElectron) return fromServer("node-av");

  if (
    Object.keys(require.cache ?? {}).some(
      (file) => basename(file) === "node-av.node",
    )
  )
    throw new Error("media.node_av_loaded_without_deepbind");

  // At 4K, x264 can ask memalign for 2 MiB while Electron's PartitionAlloc
  // rejects alignments above 1 MiB. Bind the addon/FFmpeg allocator symbols
  // ahead of Electron's allocator interposition when the native addon loads.
  const { RTLD_LAZY, RTLD_DEEPBIND } = constants.dlopen ?? {};
  if (!Number.isInteger(RTLD_LAZY) || !Number.isInteger(RTLD_DEEPBIND))
    throw new Error(
      "media.node_av_deepbind_unavailable: Linux Electron requires RTLD_DEEPBIND",
    );
  const original = process.dlopen;
  if (typeof original !== "function")
    throw new Error("media.node_av_dlopen_unavailable");
  let addonLoaded = false;
  process.dlopen = function (module, filename, flags) {
    if (basename(filename) === "node-av.node") {
      const result = Reflect.apply(original, this, [
        module,
        filename,
        (flags ?? RTLD_LAZY) | RTLD_DEEPBIND,
      ]);
      addonLoaded = true;
      return result;
    }
    return Reflect.apply(original, this, arguments);
  };
  try {
    const av = fromServer("node-av");
    if (!addonLoaded) throw new Error("media.node_av_deepbind_not_applied");
    controlledNodeAv = av;
    return av;
  } finally {
    process.dlopen = original;
  }
}

module.exports = { loadNodeAv };

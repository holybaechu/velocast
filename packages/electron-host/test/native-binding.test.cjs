"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "../native-binding.cjs"),
  "utf8",
);

function fixture({
  platform = "linux",
  electron = true,
  deepbind = 8,
  fail = false,
  skipAddon = false,
} = {}) {
  const calls = [];
  const original = function (...args) {
    calls.push({ receiver: this, args });
  };
  const fakeProcess = {
    platform,
    versions: electron ? { electron: "44.0.0" } : { node: "24.0.0" },
    dlopen: original,
  };
  const value = { loaded: true };
  let imports = 0;
  let shouldFail = fail;
  const fromServer = (name) => {
    imports++;
    assert.equal(name, "node-av");
    if (!skipAddon) {
      fakeProcess.dlopen({ id: "default" }, "/binary/node-av.node");
      fakeProcess.dlopen({ id: "explicit" }, "/binary/node-av.node", 2);
    }
    fakeProcess.dlopen({ id: "other" }, "/binary/other.node", 4);
    if (shouldFail) throw new Error("native import failed");
    return value;
  };
  const fakeRequire = (name) => {
    if (name === "node:module")
      return {
        createRequire: (origin) => {
          assert.equal(origin, "/server/mediabunny-server.cjs");
          return fromServer;
        },
      };
    if (name === "node:path") return path;
    if (name === "node:os")
      return {
        constants: { dlopen: { RTLD_LAZY: 1, RTLD_DEEPBIND: deepbind } },
      };
    throw new Error(`Unexpected require: ${name}`);
  };
  fakeRequire.resolve = (name) => {
    assert.equal(name, "@mediabunny/server");
    return "/server/mediabunny-server.cjs";
  };
  fakeRequire.cache = {};
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module,
    require: fakeRequire,
    process: fakeProcess,
  });
  return {
    loadNodeAv: module.exports.loadNodeAv,
    fakeProcess,
    original,
    fakeRequire,
    calls,
    value,
    imports: () => imports,
    setFailure: (value) => {
      shouldFail = value;
    },
  };
}

test("Linux Electron deep-binds only node-av and restores the native loader", () => {
  const f = fixture();
  assert.equal(f.loadNodeAv(), f.value);
  assert.equal(f.fakeProcess.dlopen, f.original);
  assert.equal(f.imports(), 1);
  assert.equal(f.loadNodeAv(), f.value);
  assert.equal(f.imports(), 1, "controlled import must be reused");
  assert.deepEqual(
    f.calls.map(({ args }) => [args[1], args[2], args.length]),
    [
      ["/binary/node-av.node", 9, 3],
      ["/binary/node-av.node", 10, 3],
      ["/binary/other.node", 4, 3],
    ],
  );
  assert.ok(f.calls.every(({ receiver }) => receiver === f.fakeProcess));
});

test("Linux Electron restores the native loader after a failed import", () => {
  const f = fixture({ fail: true });
  assert.throws(() => f.loadNodeAv(), /native import failed/);
  assert.equal(f.fakeProcess.dlopen, f.original);
  f.setFailure(false);
  assert.equal(f.loadNodeAv(), f.value);
  assert.equal(f.imports(), 2, "a failed import must not be cached");
});

test("Linux Electron rejects an addon already loaded outside the adapter", () => {
  const f = fixture();
  f.fakeRequire.cache["/binary/node-av.node"] = { exports: {} };
  assert.throws(() => f.loadNodeAv(), /media.node_av_loaded_without_deepbind/);
  assert.equal(f.imports(), 0);
  assert.equal(f.fakeProcess.dlopen, f.original);
});

test("Linux Electron rejects a cached Node AV import without a controlled addon load", () => {
  const f = fixture({ skipAddon: true });
  assert.throws(() => f.loadNodeAv(), /media.node_av_deepbind_not_applied/);
  assert.equal(f.imports(), 1);
  assert.equal(f.fakeProcess.dlopen, f.original);
});

for (const config of [
  { platform: "win32", electron: true },
  { platform: "darwin", electron: true },
  { platform: "linux", electron: false },
]) {
  test(`${config.platform} ${config.electron ? "Electron" : "Node"} keeps normal addon loading`, () => {
    const f = fixture(config);
    assert.equal(f.loadNodeAv(), f.value);
    assert.equal(f.fakeProcess.dlopen, f.original);
    assert.deepEqual(
      f.calls.map(({ args }) => [args[1], args[2], args.length]),
      [
        ["/binary/node-av.node", undefined, 2],
        ["/binary/node-av.node", 2, 3],
        ["/binary/other.node", 4, 3],
      ],
    );
  });
}

test("Linux Electron reports missing RTLD_DEEPBIND before loading node-av", () => {
  const f = fixture({ deepbind: null });
  assert.throws(() => f.loadNodeAv(), /media.node_av_deepbind_unavailable/);
  assert.equal(f.imports(), 0);
  assert.equal(f.fakeProcess.dlopen, f.original);
});

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function fixture(failure, probeError) {
  const calls = [];
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "owned-windows-tree.cjs"), "utf8"), {
    module,
    require(name) {
      if (name === "node:child_process") return {
        execFile(binary, args, options, callback) {
          calls.push({ binary, args, options });
          callback(failure, "", "");
        },
      };
      return require(name);
    },
    process: {
      env: { SystemRoot: "C:\\Windows" },
      kill(pid, signal) {
        calls.push({ pid, signal });
        if (probeError) throw probeError;
      },
    },
  });
  return { stop: module.exports.stopOwnedWindowsTree, calls };
}
const child = { pid: 12345, exitCode: null, signalCode: null };

test("taskkill exit race accepts only OS absence of the owned PID", async () => {
  const f = fixture(Object.assign(new Error("localized output is irrelevant"), { code: 255 }), { code: "ESRCH" });
  await f.stop(child);
  assert.equal(f.calls[0].binary, path.join("C:\\Windows", "System32", "taskkill.exe"));
  assert.deepEqual(Array.from(f.calls[0].args), ["/pid", "12345", "/t", "/f"]);
  assert.equal(f.calls[0].options.timeout, 5000);
  assert.deepEqual(f.calls[1], { pid: 12345, signal: 0 });
});

for (const probe of [undefined, { code: "EPERM" }]) {
  test(`taskkill failure is preserved when the owned PID is ${probe ? "inaccessible" : "live"}`, async () => {
    const failure = Object.assign(new Error("termination denied"), { code: 255 });
    const f = fixture(failure, probe);
    await assert.rejects(f.stop(child), (error) => error === failure);
  });
}
for (const properties of [{ code: "ENOENT" }, { code: 255, killed: true }, { code: 255, signal: "SIGTERM" }]) {
  test(`taskkill launch/timeout/signal failure is not an exit race: ${JSON.stringify(properties)}`, async () => {
    const failure = Object.assign(new Error("taskkill failed"), properties);
    const f = fixture(failure, { code: "ESRCH" });
    await assert.rejects(f.stop(child), (error) => error === failure);
    assert.equal(f.calls.length, 1);
  });
}
test("successful tree termination needs no absence probe", async () => {
  const f = fixture();
  await f.stop(child);
  assert.equal(f.calls.length, 1);
});
test("already observed exit is never targeted again", async () => {
  const f = fixture();
  await f.stop({ ...child, exitCode: 0 });
  await f.stop({ ...child, signalCode: "SIGTERM" });
  assert.equal(f.calls.length, 0);
});

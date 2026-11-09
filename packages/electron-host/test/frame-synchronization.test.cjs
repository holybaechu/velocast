"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const protocol = require("../protocol.cjs");

function fixture({ manualClock = false, diagnosticFailure = false, viewportMs = 0, decodeFailure = false } = {}) {
  const events = [];
  const diagnostics = [];
  const timers = new Map();
  let now = 0;
  let host, finishSeek, finishSnapshot;
  const png = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(png);
  png.writeUInt32BE(160, 16);
  png.writeUInt32BE(100, 20);
  const encoder = {
    frames: 0,
    settings: { startFrame: 240, width: 160, height: 100 },
    async dispose() { events.push("dispose"); },
    async encode(bytes, index, frame, token) {
      events.push("encode");
      assert.equal(bytes.equals(png), true);
      this.frames++;
      return { index, frames: this.frames, frame, token };
    },
  };
  const contents = {
    getOSProcessId: () => 567,
    executeJavaScript(script) {
      if (script === "({width: innerWidth, height: innerHeight})") {
        now += viewportMs;
        events.push("viewport");
        return Promise.resolve({ width: 160, height: 100 });
      }
      events.push("seek");
      return new Promise((resolve, reject) => {
        finishSeek = (error) => {
          if (error) reject(error);
          else {
            host.onTitle(null, "velocast-script-result:seek-241:ok:{}");
            resolve();
          }
        };
      });
    },
    debugger: {
      isAttached: () => true,
      sendCommand(method, parameters) {
        if (method === "Emulation.setDeviceMetricsOverride") {
          events.push("override");
          return Promise.resolve();
        }
        assert.equal(method, "Page.captureScreenshot");
        assert.deepEqual({ ...parameters.clip }, { x: 0, y: 0, width: 160, height: 100, scale: 1 });
        events.push("snapshot");
        return new Promise((resolve, reject) => {
          finishSnapshot = (...errors) =>
            errors.length ? reject(errors[0]) : resolve({ data: png.toString("base64") });
        });
      },
    },
  };
  const dependencies = {
    "electron/main": {
      nativeImage: { createFromBuffer(bytes) {
        assert.ok(bytes.equals(png), "decoder receives the PNG with valid header and geometry");
        if (decodeFailure) events.push("decode-invalid");
        return { isEmpty: () => decodeFailure };
      } },
      app: {
        on() {},
        commandLine: { appendSwitch() {} },
        whenReady: () => new Promise(() => {}),
        exit() { events.push("exit"); },
        getAppMetrics() {
          if (diagnosticFailure) throw new Error("metrics failed");
          return Array.from({ length: 20 }, (_, pid) => ({
            pid, type: "GPU", cpu: { percentCPUUsage: 12, cumulativeCPUUsage: 1.25 }, secret: "secret-metrics",
          }));
        },
      },
    },
    "./protocol.cjs": protocol,
    "./software-frame.cjs": {},
    "./profile-directory.cjs": {},
    "node:perf_hooks": { performance: { now: () => now } },
  };
  const module = { exports: {} };
  vm.runInNewContext(
    `(function(require,module){${fs.readFileSync(path.join(__dirname, "../main.cjs"), "utf8")}\nmodule.exports={dispatch,onTitle,cleanup,setup(w,e){window=w;webcodecsEncoder=e;snapshotViewport={width:160,height:100};}};})`,
    {
      process: { env: {}, pid: 123, stderr: { write: (line) => diagnostics.push(line) } },
      Buffer,
      setTimeout: manualClock ? (callback, milliseconds) => {
        const timer = {};
        timers.set(timer, { callback, milliseconds, due: now + milliseconds });
        return timer;
      } : setTimeout,
      clearTimeout: manualClock ? (timer) => timers.delete(timer) : clearTimeout,
    },
  )((name) => dependencies[name] ?? require(name), module);
  host = module.exports;
  host.setup({ webContents: contents, setContentSize(width, height) {
    assert.equal(width, 160);
    assert.equal(height, 100);
    events.push("resize");
  }, isDestroyed: () => false, destroy() { events.push("destroy"); } }, encoder);
  return {
    host,
    encoder,
    events,
    diagnostics,
    timers,
    advance(milliseconds) {
      now += milliseconds;
      for (const [timer, entry] of [...timers]) {
        if (entry.due <= now && timers.delete(timer)) entry.callback();
      }
    },
    expireSnapshot() {
      now += 1800;
      const timer = [...timers.values()].find(({ milliseconds }) => milliseconds === 1800);
      assert.ok(timer, "snapshot deadline is armed");
      timer.callback();
    },
    command: {
      method: "webcodecs-frame",
      index: 0,
      frame: 240,
      token: "seek-241",
      script: "seek",
    },
    finishSeek: (error) => finishSeek(error),
    finishSnapshot: (...errors) => finishSnapshot(...errors),
  };
}
const turn = () => new Promise(setImmediate);

test("full-size resize fence uses the remaining setup budget before subsequent authoring", async () => {
  const f = fixture({ manualClock: true, viewportMs: 700 });
  let prepared = false;
  const result = f.host.dispatch({ method: "resize", width: 160, height: 100 })
    .then(() => { prepared = true; f.events.push("authoring-init"); });
  void result.catch(() => {});
  await turn();
  assert.deepEqual(f.events, ["resize", "override", "viewport", "snapshot"]);
  f.advance(2000);
  await turn();
  assert.equal(prepared, false);
  assert.equal(f.encoder.frames, 0);
  f.finishSnapshot();
  await result;
  assert.deepEqual(f.events, ["resize", "override", "viewport", "snapshot", "authoring-init"]);
  const report = JSON.parse(f.diagnostics[0].replace("[electron-snapshot] ", ""));
  assert.equal(report.event, "initialization_snapshot_completed");
  assert.equal(report.phase, "resize");
  assert.equal(report.elapsedMs, 2000);
  assert.equal(report.timeoutMs, 3800);
  assert.equal(report.settlement, "fulfilled");
  assert.equal(f.timers.size, 0);

  // The same host's next actual frame must still fail at 1800ms; no late encode.
  const failed = assert.rejects(f.host.dispatch(f.command), /Electron compositor snapshot timed out/);
  f.finishSeek();
  await turn();
  f.advance(1800);
  await failed;
  f.finishSnapshot();
  await turn();
  assert.equal(f.encoder.frames, 0);
});

test("resize decode validation failure cannot emit initialization completion", async () => {
  const f = fixture({ manualClock: true, decodeFailure: true });
  const failed = assert.rejects(
    f.host.dispatch({ method: "resize", width: 160, height: 100 }),
    { message: "capture.invalid_snapshot" },
  );
  await turn();
  f.finishSnapshot();
  await failed;
  assert.deepEqual(f.events, ["resize", "override", "viewport", "snapshot", "decode-invalid"]);
  assert.equal(f.encoder.frames, 0);
  assert.equal(f.timers.size, 0);
  const reports = f.diagnostics.map(line => JSON.parse(line.replace("[electron-snapshot] ", "")));
  assert.equal(reports.some(report => report.event === "initialization_snapshot_completed"), false);
});

test("resize cannot restart the setup budget after viewport work or accept a late snapshot", async () => {
  const f = fixture({ manualClock: true, viewportMs: 700 });
  let prepared = false;
  const result = f.host.dispatch({ method: "resize", width: 160, height: 100 })
    .then(() => { prepared = true; });
  const failed = assert.rejects(result, /Electron compositor snapshot timed out/);
  await turn();
  f.advance(3799);
  await turn();
  assert.equal(f.diagnostics.length, 0, "resize has not expired before its remaining setup budget");
  f.advance(1);
  await failed;
  f.finishSnapshot();
  await turn();
  assert.equal(prepared, false);
  assert.equal(f.encoder.frames, 0);
  assert.equal(f.timers.size, 0);
  const reports = f.diagnostics.map(line => JSON.parse(line.replace("[electron-snapshot] ", "")));
  assert.deepEqual(reports.map(report => report.event), ["failed", "settled_after_failure"]);
  assert.equal(reports[0].phase, "resize");
  assert.equal(reports[0].timeoutMs, 3800);
});

test("an exhausted resize setup budget cannot submit another screenshot", async () => {
  const f = fixture({ manualClock: true, viewportMs: 4500 });
  await assert.rejects(
    f.host.dispatch({ method: "resize", width: 160, height: 100 }),
    /Electron surface resize timed out/,
  );
  assert.deepEqual(f.events, ["resize", "override", "viewport"]);
  assert.equal(f.encoder.frames, 0);
  assert.equal(f.timers.size, 0);
});

test("capture waits for this seek and its immutable snapshot before encoding", async () => {
  const f = fixture();
  const result = f.host.dispatch(f.command);
  f.host.onTitle(null, "velocast-script-result:old-token:ok:{}");
  await turn();
  assert.deepEqual(f.events, ["seek"]);
  f.finishSeek();
  await turn();
  assert.deepEqual(f.events, ["seek", "snapshot"]);
  assert.equal(f.encoder.frames, 0);
  f.finishSnapshot();
  const reply = await result;
  assert.deepEqual(f.events, ["seek", "snapshot", "encode"]);
  assert.equal(reply.frame, 240);
  assert.equal(reply.token, "seek-241");
  assert.equal(reply.cpuReadback, true);
  assert.deepEqual(f.diagnostics, []);
});

test("failed seeks and failed snapshots never submit a frame", async () => {
  for (const stage of ["seek", "snapshot"]) {
    const f = fixture();
    const rejected = assert.rejects(
      f.host.dispatch(f.command),
      /fixture failure/,
    );
    f.finishSeek(stage === "seek" ? new Error("fixture failure") : undefined);
    if (stage === "snapshot") {
      await turn();
      f.finishSnapshot(new Error("fixture failure"));
    }
    await rejected;
    assert.equal(f.encoder.frames, 0);
    assert.equal(f.events.includes("encode"), false);
  }
});

test("out-of-order or inconsistent frame identities fail before seeking", async () => {
  for (const change of [
    { index: 1 },
    { frame: 0 },
    { frame: 241 },
    { token: "" },
  ]) {
    const f = fixture();
    await assert.rejects(
      f.host.dispatch({ ...f.command, ...change }),
      /invalid_sequence|invalid_frame_identity/,
    );
    assert.deepEqual(f.events, []);
  }
});

for (const settlement of ["fulfilled", "rejected", "pending"]) {
  test(`snapshot deadline reports pending work and observes ${settlement} without encoding or delaying cleanup`, async () => {
    const f = fixture({ manualClock: true });
    const failed = assert.rejects(f.host.dispatch(f.command), /Electron compositor snapshot timed out/);
    f.finishSeek();
    await turn();
    f.expireSnapshot();
    await failed;
    const parse = (line) => JSON.parse(line.replace("[electron-snapshot] ", ""));
    const report = parse(f.diagnostics[0]);
    assert.equal(report.event, "failed");
    assert.equal(report.settlement, "pending");
    assert.equal(report.frame, 240);
    assert.equal(report.index, 0);
    assert.equal(report.startFrame, 240);
    assert.equal(report.sequence, 1);
    assert.equal(report.width, 160);
    assert.equal(report.height, 100);
    assert.equal(report.elapsedMs, 1800);
    assert.equal(report.timeoutMs, 1800);
    assert.equal(typeof report.submittedAtMs, "number");
    assert.equal(report.submittedUptimeMs, 0);
    assert.equal(report.rendererPid, 567);
    assert.equal(report.previousMs, null);
    assert.equal(report.processes.length, 16);
    assert.equal(report.processes[0].cumulativeCPUSeconds, 1.25);
    assert.equal(f.timers.size, 0);
    await f.host.cleanup();
    assert.deepEqual(f.events, ["seek", "snapshot", "dispose", "destroy", "exit"]);
    if (settlement === "fulfilled") f.finishSnapshot();
    if (settlement === "rejected") f.finishSnapshot(new Error("secret-cdp-error"));
    await turn();
    assert.equal(f.encoder.frames, 0);
    assert.equal(f.diagnostics.length, settlement === "pending" ? 1 : 2);
    if (settlement !== "pending") {
      const late = parse(f.diagnostics[1]);
      assert.equal(late.event, "settled_after_failure");
      assert.equal(late.settlement, settlement);
      assert.equal(late.closed, true);
      assert.equal(late.sequence, report.sequence);
    }
    assert.ok(f.diagnostics.every(line => line.length < 2500));
    assert.doesNotMatch(f.diagnostics.join(""), /secret|seek-241|base64|script|data/);
  });
}

test("snapshot rejection preserves the exact primary value even if diagnostic collection fails", async () => {
  for (const primary of [new Error("secret-original-error"), undefined]) {
    const f = fixture({ manualClock: true, diagnosticFailure: true });
    const failed = assert.rejects(f.host.dispatch(f.command), error => error === primary);
    f.finishSeek();
    await turn();
    f.finishSnapshot(primary);
    await failed;
    assert.equal(f.timers.size, 0);
    assert.equal(f.encoder.frames, 0);
    await f.host.cleanup();
    assert.deepEqual(f.events, ["seek", "snapshot", "dispose", "destroy", "exit"]);
  }
});

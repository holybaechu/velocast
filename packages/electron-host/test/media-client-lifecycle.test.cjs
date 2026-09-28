"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { createRequire } = require("node:module");

function fixture({
  transientLocks = 0,
  removalError,
  killerCode = 0,
  osGone = false,
  cooperative = false,
  probeDenied = false,
} = {}) {
  const events = [],
    directories = [];
  let main,
    killerComplete = false,
    parentComplete = false,
    removals = 0,
    yielded = 0;
  const file = path.join(__dirname, "../media-client.cjs"),
    realRequire = createRequire(file);
  const finishMain = (code) => {
    if (parentComplete) return;
    parentComplete = true;
    main.exitCode = code;
    events.push("parent-exit");
    main.emit("close", code);
  };
  const spawn = (binary, _args, options) => {
    const child = new EventEmitter();
    child.pid = 1234;
    child.kill = () => {
      if (child === main) finishMain(1);
      else child.emit("close", 1);
      return true;
    };
    if (binary.endsWith("taskkill.exe")) {
      events.push("taskkill-start");
      setTimeout(() => finishMain(1), osGone ? 40 : 5);
      setTimeout(() => {
        killerComplete = true;
        events.push("taskkill-exit");
        child.emit("close", killerCode);
      }, 20);
    } else {
      main = child;
      child.stdin = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin.end = () => {
        events.push("stdin-end");
        if (cooperative) setTimeout(() => finishMain(0), 5);
      };
      child.stdin.write = (line) => {
        const command = JSON.parse(line);
        fs.writeFileSync(
          command.response,
          JSON.stringify(
            cooperative
              ? { ok: true, result: { decoded: true } }
              : { ok: false, error: "fixture operation failed" },
          ),
        );
      };
      directories.push(options.env.VELOCAST_MEDIA_SCRATCH);
      fs.writeFileSync(
        options.env.VELOCAST_MEDIA_READY,
        JSON.stringify({ ok: true }),
      );
    }
    return child;
  };
  const fakeFs = Object.create(fs);
  Object.defineProperty(fakeFs, "promises", {
    value: {
      ...fs.promises,
      rm: async (directory, options) => {
        if (options.recursive) {
          events.push("remove");
          removals++;
          assert.equal(parentComplete, true, "cleanup preceded parent close");
          if (!cooperative)
            assert.equal(
              killerComplete,
              true,
              "cleanup preceded tree-killer close",
            );
          if (removals <= transientLocks) {
            setTimeout(() => yielded++, 0);
            throw Object.assign(new Error("transient profile lock"), {
              code: "EPERM",
            });
          }
          if (removalError)
            throw Object.assign(new Error("persistent cleanup denial"), {
              code: removalError,
            });
        }
        return fs.promises.rm(directory, options);
      },
    },
  });
  const simulatedProcess = {
    ...process,
    platform: "win32",
    kill(_pid, signal) {
      assert.equal(signal, 0);
      if (probeDenied)
        throw Object.assign(new Error("probe access denied"), {
          code: "EPERM",
        });
      if (osGone)
        throw Object.assign(new Error("owned process is gone"), {
          code: "ESRCH",
        });
      return true;
    },
  };
  const module = { exports: {} };
  const load = vm.runInNewContext(
    `(function(require,module,exports,__dirname){${fs.readFileSync(file, "utf8")}\n})`,
    {
      process: simulatedProcess,
      Buffer,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      AggregateError,
    },
  );
  load(
    (name) =>
      name === "node:child_process"
        ? { spawn }
        : name === "node:fs"
          ? fakeFs
          : realRequire(name),
    module,
    module.exports,
    path.dirname(file),
  );
  return {
    client: module.exports,
    events,
    directories,
    get removals() {
      return removals;
    },
    get yielded() {
      return yielded;
    },
    async cleanup() {
      for (const directory of directories)
        await fs.promises.rm(directory, { recursive: true, force: true });
    },
  };
}

test("cleanup awaits the delayed tree killer and asynchronously retries transient profile locks", async () => {
  const f = fixture({ transientLocks: 2 });
  try {
    await assert.rejects(
      f.client.runMediaOperation(
        { kind: "probe" },
        { electronBinary: "fake-electron", timeoutMs: 1000 },
      ),
      /fixture operation failed/,
    );
    assert.ok(
      f.events.indexOf("taskkill-exit") > f.events.indexOf("parent-exit"),
    );
    assert.ok(f.events.indexOf("remove") > f.events.indexOf("taskkill-exit"));
    assert.equal(f.removals, 3);
    assert.equal(f.yielded, 2);
    assert.equal(fs.existsSync(f.directories[0]), false);
  } finally {
    await f.cleanup();
  }
});

test("successful cooperative shutdown also yields between delayed profile-unlock retries", async () => {
  const f = fixture({ cooperative: true, transientLocks: 2 });
  try {
    const result = await f.client.runMediaOperation(
      { kind: "probe" },
      { electronBinary: "fake-electron", timeoutMs: 1000 },
    );
    assert.equal(result.decoded, true);
    assert.equal(f.events.includes("taskkill-start"), false);
    assert.ok(f.events.indexOf("remove") > f.events.indexOf("parent-exit"));
    assert.equal(f.removals, 3);
    assert.equal(f.yielded, 2);
  } finally {
    await f.cleanup();
  }
});

test("taskkill255 accepts OS absence while still awaiting delayed Node process close", async () => {
  const f = fixture({ killerCode: 255, osGone: true });
  try {
    await assert.rejects(
      f.client.runMediaOperation(
        { kind: "probe" },
        { electronBinary: "fake-electron", timeoutMs: 1000 },
      ),
      (error) => {
        assert.equal(error.message, "fixture operation failed");
        return true;
      },
    );
    assert.ok(f.events.indexOf("remove") > f.events.indexOf("parent-exit"));
    assert.equal(fs.existsSync(f.directories[0]), false);
  } finally {
    await f.cleanup();
  }
});

test("persistent cleanup failures retain the original operation error and report cleanup failure", async () => {
  const f = fixture({ removalError: "EACCES" });
  try {
    await assert.rejects(
      f.client.runMediaOperation(
        { kind: "probe" },
        { electronBinary: "fake-electron", timeoutMs: 1000 },
      ),
      (error) => {
        assert.match(error.message, /fixture operation failed/);
        assert.match(error.message, /persistent cleanup denial/);
        assert.equal(error.cause.message, "fixture operation failed");
        return true;
      },
    );
    assert.equal(fs.existsSync(f.directories[0]), true);
  } finally {
    await f.cleanup();
  }
});

for (const probeDenied of [false, true])
  test(`a failed tree kill with ${probeDenied ? "denied PID probe" : "a live PID"} remains an error and retains scratch`, async () => {
    const f = fixture({ killerCode: 255, probeDenied });
    try {
      await assert.rejects(
        f.client.runMediaOperation(
          { kind: "probe" },
          { electronBinary: "fake-electron", timeoutMs: 1000 },
        ),
        /media.tree_termination_failed/,
      );
      assert.equal(f.removals, 0);
      assert.equal(fs.existsSync(f.directories[0]), true);
    } finally {
      await f.cleanup();
    }
  });

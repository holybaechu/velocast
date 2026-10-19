"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { createRequire } = require("node:module");
const os = require("node:os");
const { createMediaSession } = require("../media-client.cjs");

function fixture({
  transientLocks = 0,
  removalError,
  killerCode = 0,
  osGone = false,
  cooperative = false,
  probeDenied = false,
  inheritedPipes = false,
  electron = false,
  afterOpen,
  onPipeline,
} = {}) {
  const events = [],
    directories = [],
    hostExited = Promise.withResolvers();
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
    main.emit("exit", code);
    if (!inheritedPipes) main.emit("close", code);
    hostExited.resolve();
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
      for (const [name, stream] of [
        ["stdin", child.stdin],
        ["stderr", child.stderr],
      ]) {
        stream.destroy = () => {
          if (stream.destroyed) return;
          stream.destroyed = true;
          events.push(`${name}-destroy`);
          if (
            inheritedPipes &&
            parentComplete &&
            child.stdin.destroyed &&
            child.stderr.destroyed
          ) {
            events.push("pipes-close");
            child.emit("close", child.exitCode);
          }
        };
      }
      child.stdin.end = () => {
        events.push("stdin-end");
        if (cooperative) setTimeout(() => finishMain(0), 5);
      };
      child.stdin.write = (line) => {
        const command = JSON.parse(line);
        const operation = JSON.parse(fs.readFileSync(command.request, "utf8"));
        const result = { decoded: true };
        if (cooperative && operation.outputPath) {
          fs.copyFileSync(operation.path, operation.outputPath);
          result.path = operation.outputPath;
        }
        fs.writeFileSync(
          command.response,
          JSON.stringify(
            cooperative
              ? { ok: true, result }
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
      open: async (...args) => {
        const handle = await fs.promises.open(...args);
        await afterOpen?.(...args);
        return handle;
      },
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
    versions: electron
      ? { ...process.versions, electron: "44.0.0" }
      : process.versions,
    env: { ...process.env },
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
  if (electron) delete simulatedProcess.env.VELOCAST_NODE_BINARY;
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
      AbortSignal,
    },
  );
  load(
    (name) =>
      name === "node:child_process"
        ? { spawn }
        : name === "node:fs"
          ? fakeFs
          : name === "node:stream/promises" && onPipeline
            ? {
                pipeline: (...streams) => {
                  onPipeline(streams[1]);
                  return realRequire(name).pipeline(...streams);
                },
              }
            : realRequire(name),
    module,
    module.exports,
    path.dirname(file),
  );
  return {
    client: module.exports,
    events,
    directories,
    hostExited: hostExited.promise,
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

test("utilities ignore a stale inherited worker executable", async () => {
  const f = fixture({ cooperative: true });
  try {
    const result = await f.client.runMediaOperation(
      { kind: "probe" },
      {
        electronBinary: "fake-electron",
        env: { VELOCAST_NODE_BINARY: "C:\\stale\\node.exe" },
      },
    );
    assert.equal(result.decoded, true);
  } finally {
    await f.cleanup();
  }
});

test("Electron utility callers no longer require a stock Node video worker", async () => {
  const f = fixture({ cooperative: true, electron: true });
  try {
    const result = await f.client.runMediaOperation(
      { kind: "probe" },
      { electronBinary: "fake-electron" },
    );
    assert.equal(result.decoded, true);
  } finally {
    await f.cleanup();
  }
});

test("startup cancellation after readiness joins the host before rejecting", async () => {
  const f = fixture(),
    controller = new AbortController(),
    interruption = new Error("startup interrupted");
  let session;
  try {
    const starting = f.client.createMediaSession({
      electronBinary: "fake-electron",
      signal: controller.signal,
    }).then((result) => (session = result));
    controller.abort(interruption);
    await assert.rejects(starting, (error) => error === interruption);
    assert.ok(f.events.indexOf("remove") > f.events.indexOf("taskkill-exit"));
    assert.equal(fs.existsSync(f.directories[0]), false);
  } finally {
    await session?.close();
    await f.cleanup();
  }
});

test("cleanup awaits the delayed tree killer and asynchronously retries transient profile locks", async () => {
  const f = fixture({ transientLocks: 2 });
  try {
    const session = await f.client.createMediaSession({
      electronBinary: "fake-electron",
      timeoutMs: 1000,
    });
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => session.run({ kind: "probe" })),
    );
    assert.match(results[0].reason.message, /fixture operation failed/);
    for (const result of results.slice(1))
      assert.match(result.reason.message, /session_closed/);
    await session.close();
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

for (const abort of [false, true])
  test(
    `close joins publication and queued requests${abort ? " during owner abort with a distinct call signal" : ""}`,
    { timeout: 3000 },
    async () => {
      const started = Promise.withResolvers(),
        release = Promise.withResolvers(),
        controller = new AbortController(),
        callController = new AbortController(),
        interruption = new Error("publication interrupted"),
        directory = fs.mkdtempSync(
          path.join(os.tmpdir(), "velocast-publication-test-"),
        ),
        source = path.join(directory, "source.bin"),
        destination = path.join(directory, "destination.bin"),
        bytes = Buffer.from("complete staged result");
      const f = fixture({
        cooperative: true,
        async afterOpen(file) {
          if (file !== destination) return;
          started.resolve();
          await release.promise;
        },
      });
      let session, requests, closing;
      try {
        fs.writeFileSync(source, bytes);
        session = await f.client.createMediaSession({
          electronBinary: "fake-electron",
          signal: controller.signal,
        });
        requests = Promise.allSettled([
          session.run(
            { kind: "copy", path: source, outputPath: destination },
            { signal: callController.signal },
          ),
          session.run({ kind: "probe" }),
          session.run({ kind: "probe" }),
        ]);
        await started.promise;
        let closed = false;
        closing = session.close();
        assert.equal(session.close(), closing);
        void closing.then(() => {
          closed = true;
        });
        if (abort) controller.abort(interruption);
        assert.equal(callController.signal.aborted, false);
        await f.hostExited;
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(
          closed,
          false,
          "close returned before owned publication settled",
        );
        assert.equal(
          f.removals,
          0,
          "scratch removed during active publication",
        );
        release.resolve();
        await closing;
        const destinationAtClose = fs.existsSync(destination)
          ? fs.readFileSync(destination)
          : null;
        assert.deepEqual(destinationAtClose, abort ? null : bytes);
        const results = await requests;
        assert.equal(results[0].status, abort ? "rejected" : "fulfilled");
        if (abort) assert.equal(results[0].reason, interruption);
        for (const result of results.slice(1))
          assert.match(result.reason.message, /session_closed/);
        assert.deepEqual(fs.readFileSync(source), bytes);
        if (abort) assert.equal(fs.existsSync(destination), false);
        else assert.deepEqual(fs.readFileSync(destination), bytes);
        assert.equal(fs.existsSync(f.directories[0]), false);
        const eventsAtClose = [...f.events];
        await assert.rejects(session.run({ kind: "probe" }), /session_closed/);
        await session.close();
        assert.deepEqual(f.events, eventsAtClose, "work continued after close");
      } finally {
        release.resolve();
        await closing;
        await requests;
        await session?.close();
        await f.cleanup();
        await fs.promises.rm(directory, { recursive: true, force: true });
      }
    },
  );

test(
  "mid-copy call cancellation retains its abort cause and rolls back only owned output",
  { timeout: 3000 },
  async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "velocast-publication-test-"),
    );
    const source = path.join(directory, "source.bin"),
      destination = path.join(directory, "destination.bin"),
      bytes = Buffer.alloc(1024 * 1024, 0x7f),
      ownerController = new AbortController(),
      controller = new AbortController(),
      interruption = new Error("mid-copy interruption");
    let copiedBytes = 0;
    let session;
    const f = fixture({
      cooperative: true,
      onPipeline(writer) {
        writer.once("drain", () => {
          copiedBytes = fs.statSync(destination).size;
          controller.abort(interruption);
        });
      },
    });
    try {
      fs.writeFileSync(source, bytes);
      session = await f.client.createMediaSession({
        electronBinary: "fake-electron",
        signal: ownerController.signal,
      });
      await assert.rejects(
        session.run(
          { kind: "copy", path: source, outputPath: destination },
          { signal: controller.signal },
        ),
        (error) => {
          assert.equal(error.code, "ABORT_ERR");
          assert.equal(error.cause, interruption);
          return true;
        },
      );
      assert.equal(ownerController.signal.aborted, false);
      assert.ok(copiedBytes > 0 && copiedBytes < bytes.length);
      assert.equal(fs.existsSync(destination), false);
      assert.deepEqual(fs.readFileSync(source), bytes);
      assert.equal(fs.existsSync(f.directories[0]), false);
    } finally {
      await session?.close();
      await f.cleanup();
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  },
);

test("publication failure preserves source and an existing destination", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "velocast-publication-test-"),
  );
  const source = path.join(directory, "source.bin"),
    destination = path.join(directory, "destination.bin"),
    f = fixture({ cooperative: true });
  try {
    fs.writeFileSync(source, "source bytes");
    fs.writeFileSync(destination, "another writer's bytes");
    await assert.rejects(
      f.client.runMediaOperation(
        { kind: "copy", path: source, outputPath: destination },
        { electronBinary: "fake-electron" },
      ),
      { code: "EEXIST" },
    );
    assert.equal(fs.readFileSync(source, "utf8"), "source bytes");
    assert.equal(
      fs.readFileSync(destination, "utf8"),
      "another writer's bytes",
    );
    assert.equal(fs.existsSync(f.directories[0]), false);
  } finally {
    await f.cleanup();
    await fs.promises.rm(directory, { recursive: true, force: true });
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

test(
  "cooperative exit releases inherited pipe ends without waiting for descendant EOF",
  { timeout: 3000 },
  async () => {
    const f = fixture({ cooperative: true, inheritedPipes: true });
    try {
      const result = await f.client.runMediaOperation(
        { kind: "probe" },
        { electronBinary: "fake-electron", timeoutMs: 1000 },
      );
      assert.equal(result.decoded, true);
      assert.equal(f.events.includes("taskkill-start"), false);
      assert.ok(
        f.events.indexOf("stdin-destroy") > f.events.indexOf("parent-exit"),
      );
      assert.ok(
        f.events.indexOf("stderr-destroy") > f.events.indexOf("parent-exit"),
      );
      assert.ok(f.events.indexOf("remove") > f.events.indexOf("pipes-close"));
      assert.equal(fs.existsSync(f.directories[0]), false);
    } finally {
      await f.cleanup();
    }
  },
);

test(
  "forced exit waits for tree termination before releasing inherited pipes",
  { timeout: 3000 },
  async () => {
    const f = fixture({ inheritedPipes: true });
    try {
      await assert.rejects(
        f.client.runMediaOperation(
          { kind: "probe" },
          { electronBinary: "fake-electron", timeoutMs: 1000 },
        ),
        /fixture operation failed/,
      );
      assert.ok(
        f.events.indexOf("stdin-destroy") > f.events.indexOf("taskkill-exit"),
      );
      assert.ok(
        f.events.indexOf("stderr-destroy") > f.events.indexOf("taskkill-exit"),
      );
      assert.ok(f.events.indexOf("remove") > f.events.indexOf("pipes-close"));
      assert.equal(fs.existsSync(f.directories[0]), false);
    } finally {
      await f.cleanup();
    }
  },
);

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

test(
  "real process exit releases stderr still inherited by a live descendant",
  { skip: process.platform !== "win32", timeout: 20000 },
  async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "velocast-inherited-pipe-test-"),
    );
    const started = path.join(directory, "started"),
      finished = path.join(directory, "finished");
    const waitFor = async (predicate) => {
      const deadline = Date.now() + 12000;
      while (!predicate()) {
        assert.ok(Date.now() < deadline, "fixture did not finish");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    let session;
    try {
      session = await createMediaSession({
        electronBinary: process.execPath,
        hostScript: path.join(__dirname, "support/media-main.cjs"),
        env: { PIPE_TEST_ROOT: directory },
        timeoutMs: 5000,
      });
      await waitFor(() => fs.existsSync(started));
      assert.equal((await session.run({ kind: "probe" })).complete, true);
      await session.close();
      session = null;
      assert.equal(
        fs.existsSync(finished),
        false,
        "session close waited for descendant EOF instead of releasing its pipe ends",
      );
      assert.doesNotThrow(
        () => process.kill(Number(fs.readFileSync(started, "utf8")), 0),
        "fixture descendant must still own the inherited write end",
      );
    } finally {
      fs.writeFileSync(path.join(directory, "stop"), "stop");
      await session?.close();
      const pid = Number(fs.readFileSync(started, "utf8"));
      // Existence probes are read-only; never signal a potentially recycled PID.
      await waitFor(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          return error.code === "ESRCH";
        }
      });
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

for (const exitedBeforeClose of [false, true])
  test(
    `real POSIX shutdown terminates the owned group after ${exitedBeforeClose ? "an already-exited" : "a cooperative"} leader`,
    { skip: process.platform === "win32", timeout: 5000 },
    async () => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "velocast-owned-group-test-"),
      );
      const ownerPath = path.join(directory, "owner.json"),
        heartbeat = path.join(directory, "heartbeat");
      const waitFor = async (predicate) => {
        const deadline = Date.now() + 3000;
        while (!predicate()) {
          assert.ok(Date.now() < deadline, "fixture did not finish");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      };
      let session, owner;
      try {
        session = await createMediaSession({
          electronBinary: process.execPath,
          hostScript: path.join(__dirname, "support/media-main.cjs"),
          env: {
            PIPE_TEST_ROOT: directory,
            PIPE_TEST_OWNED_GROUP: "1",
            PIPE_TEST_EXIT_AFTER_REQUEST: exitedBeforeClose ? "1" : "0",
          },
          timeoutMs: 2000,
        });
        owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
        await waitFor(() => fs.existsSync(heartbeat));
        assert.equal((await session.run({ kind: "probe" })).complete, true);
        if (exitedBeforeClose)
          await waitFor(() => {
            try {
              process.kill(owner.pid, 0);
              return false;
            } catch (error) {
              return error.code === "ESRCH";
            }
          });
        await session.close();
        const writesAtClose = fs.statSync(heartbeat).size;
        assert.equal(fs.existsSync(owner.scratch), false);
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.equal(
          fs.statSync(heartbeat).size,
          writesAtClose,
          "owned descendant kept writing after session close",
        );
      } finally {
        if (!owner && fs.existsSync(ownerPath))
          owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
        fs.writeFileSync(path.join(directory, "stop"), "stop");
        if (owner)
          try {
            process.kill(-owner.pid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        await session?.close();
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

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

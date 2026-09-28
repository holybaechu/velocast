"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pipeline } = require("node:stream/promises");

function cleanupFailure(primary, cleanup) {
  if (!primary) return cleanup;
  if (primary === cleanup || primary.errors?.includes(cleanup)) return primary;
  return new AggregateError(
    [primary, cleanup],
    `${primary.message ?? primary}; cleanup failed: ${cleanup.message ?? cleanup}`,
    { cause: primary },
  );
}

async function waitBounded(work, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function removeOwnedDirectory(directory) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (
        attempt >= 10 ||
        !["EPERM", "EBUSY", "ENOTEMPTY"].includes(error.code)
      )
        throw error;
      // Yield while Chromium/Windows finishes releasing profile files. A sync
      // retry here blocks other sessions' exit notifications and cleanup.
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(100 * (attempt + 1), 500)),
      );
    }
  }
}

async function createMediaSession(options = {}) {
  options.signal?.throwIfAborted();
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "velocast-media-client-"),
  );
  const profile = path.join(directory, "profile"),
    ready = path.join(directory, "ready.json");
  fs.mkdirSync(profile);
  const env = {
    ...process.env,
    ...options.env,
    VELOCAST_MEDIA_READY: ready,
    VELOCAST_ELECTRON_PROFILE_DIRECTORY: profile,
    VELOCAST_MEDIA_SCRATCH: directory,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  let child,
    stderr = "",
    exitError,
    exited = false,
    sequence = 0,
    queued = 0,
    killPromise,
    closed = false,
    tail = Promise.resolve(),
    closePromise;
  let joined = Promise.resolve();
  const sessionAbort = () => {
    void close(true).catch(() => {});
  };
  const kill = () => {
    if (killPromise) return killPromise;
    if (!child?.pid || exited) return Promise.resolve();
    killPromise = (async () => {
      if (process.platform === "win32") {
        await new Promise((resolve, reject) => {
          const killer = spawn(
            path.join(
              process.env.SystemRoot || "C:\\Windows",
              "System32",
              "taskkill.exe",
            ),
            ["/pid", String(child.pid), "/t", "/f"],
            { windowsHide: true, stdio: "ignore" },
          );
          let failure;
          const timer = setTimeout(() => {
            failure = new Error("media.tree_termination_timeout");
            killer.kill();
            child.kill();
            reject(failure);
          }, 10000);
          killer.once("error", (error) => {
            failure = error;
            child.kill();
          });
          killer.once("close", (code) => {
            clearTimeout(timer);
            if (failure) reject(failure);
            else if (code === 0) resolve();
            else {
              // Windows can finish the owned process before Node receives its
              // exit notification; taskkill then returns 128 or 255. Accept
              // only the OS's explicit no-such-process proof, not a stale flag.
              let absent = false;
              try {
                process.kill(child.pid, 0);
              } catch (error) {
                absent = error.code === "ESRCH";
              }
              if (absent) resolve();
              else {
                child.kill();
                reject(
                  new Error(
                    `media.tree_termination_failed: taskkill exited ${code}`,
                  ),
                );
              }
            }
          });
        });
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") {
            child.kill();
            throw error;
          }
        }
      }
    })();
    // Abort callbacks initiate termination without awaiting; close still observes
    // this exact promise and must finish it before touching the owned directory.
    void killPromise.catch(() => {});
    return killPromise;
  };
  const close = (force = false) => {
    if (force) void kill();
    if (closePromise) return closePromise;
    closed = true;
    closePromise = (async () => {
      child?.stdin.end();
      try {
        if (!killPromise) {
          try {
            await waitBounded(joined, 3000, "media.graceful_shutdown_timeout");
          } catch {
            await kill();
          }
        }
        if (killPromise) await killPromise;
        await waitBounded(joined, 10000, "media.process_join_timeout");
      } catch (error) {
        child?.kill();
        try {
          await waitBounded(joined, 10000, "media.process_join_timeout");
        } catch (joinError) {
          error = cleanupFailure(error, joinError);
        }
        throw cleanupFailure(
          error,
          new Error(`media.scratch_retained: ${directory}`),
        );
      } finally {
        options.signal?.removeEventListener("abort", sessionAbort);
      }
      // Parent and forced tree termination are complete before asynchronous,
      // bounded retries remove this invocation-owned OS temporary directory.
      await removeOwnedDirectory(directory);
    })();
    return closePromise;
  };
  const readResult = (file, signal, timeoutMs) =>
    new Promise((resolve, reject) => {
      let timer, poll;
      const finish = (error, value) => {
        clearTimeout(timer);
        clearInterval(poll);
        signal?.removeEventListener("abort", abort);
        error ? reject(error) : resolve(value);
      };
      const abort = () => {
        kill();
        finish(signal.reason ?? new Error("media.aborted"));
      };
      const check = () => {
        if (fs.existsSync(file)) {
          try {
            finish(null, JSON.parse(fs.readFileSync(file, "utf8")));
          } catch (error) {
            finish(error);
          }
        } else if (exited)
          finish(exitError ?? new Error(`media.host_exited: ${stderr}`));
      };
      timer = setTimeout(() => {
        kill();
        finish(new Error("media.timeout"));
      }, timeoutMs);
      poll = setInterval(check, 10);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else check();
    });
  try {
    const binary =
      options.electronBinary ??
      env.VELOCAST_ELECTRON_BINARY ??
      require("electron");
    const script = options.hostScript
      ? path.join(path.dirname(options.hostScript), "media-main.cjs")
      : path.join(__dirname, "media-main.cjs");
    child = spawn(binary, [script], {
      env,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "ignore", "pipe"],
    });
    child.stdin.on("error", (error) => {
      exitError ??= error;
    });
    child.stderr.on("data", (data) => {
      stderr = (stderr + data).slice(-16000);
    });
    joined = new Promise((resolve) => {
      child.once("error", (error) => {
        exitError = error;
      });
      child.once("close", (code) => {
        exited = true;
        if (code !== 0)
          exitError ??= new Error(`media.host_failed (${code}): ${stderr}`);
        resolve();
      });
    });
    const result = await readResult(
      ready,
      options.signal,
      options.timeoutMs ?? 30000,
    );
    if (!result.ok) throw new Error(result.error);
  } catch (error) {
    try {
      await close(true);
    } catch (cleanup) {
      error = cleanupFailure(error, cleanup);
    }
    throw error;
  }
  options.signal?.addEventListener("abort", sessionAbort, { once: true });
  const execute = async (operation, callOptions = {}) => {
    if (closed || exited) throw new Error("media.session_closed");
    const signal = callOptions.signal ?? options.signal;
    const id = ++sequence,
      request = path.join(directory, `${id}.request.json`),
      response = path.join(directory, `${id}.response.json`);
    const outputPath = operation.outputPath;
    const stagedOutput =
      typeof outputPath === "string"
        ? path.join(directory, `${id}.output${path.extname(outputPath)}`)
        : null;
    let destinationIdentity;
    try {
      signal?.throwIfAborted();
      if (stagedOutput && !path.isAbsolute(outputPath))
        throw new Error("media.absolute_path_required");
      fs.writeFileSync(
        request,
        JSON.stringify(
          stagedOutput ? { ...operation, outputPath: stagedOutput } : operation,
        ),
        {
          mode: 0o600,
          flag: "wx",
        },
      );
      child.stdin.write(`${JSON.stringify({ id, request, response })}\n`);
      const result = await readResult(
        response,
        signal,
        callOptions.timeoutMs ?? options.timeoutMs ?? 300000,
      );
      if (!result.ok) throw new Error(result.error);
      if (stagedOutput) {
        signal?.throwIfAborted();
        // The child writes only in this session's owned directory. Exclusive
        // publication cannot overwrite a file created by a concurrent caller.
        const destination = await fs.promises.open(outputPath, "wx", 0o600);
        try {
          destinationIdentity = await destination.stat();
          await pipeline(
            fs.createReadStream(stagedOutput),
            fs.createWriteStream(outputPath, {
              fd: destination.fd,
              autoClose: false,
            }),
            { signal },
          );
        } finally {
          await destination.close();
        }
        signal?.throwIfAborted();
        result.result.path = outputPath;
      }
      return result.result;
    } catch (error) {
      try {
        await close(true);
      } catch (cleanup) {
        error = cleanupFailure(error, cleanup);
      }
      if (destinationIdentity) {
        try {
          const current = fs.statSync(outputPath, { throwIfNoEntry: false });
          if (
            current?.dev === destinationIdentity.dev &&
            current?.ino === destinationIdentity.ino &&
            current?.birthtimeMs === destinationIdentity.birthtimeMs
          )
            fs.rmSync(outputPath, { force: true });
        } catch (cleanup) {
          error = cleanupFailure(error, cleanup);
        }
      }
      throw error;
    } finally {
      if (!closed) {
        await fs.promises.rm(request, { force: true });
        await fs.promises.rm(response, { force: true });
        if (stagedOutput) await fs.promises.rm(stagedOutput, { force: true });
      }
    }
  };
  const run = (operation, callOptions) => {
    if (closed || exited)
      return Promise.reject(new Error("media.session_closed"));
    if (queued >= 4) return Promise.reject(new Error("media.queue_full"));
    queued++;
    const result = tail
      .then(() => execute(operation, callOptions))
      .finally(() => queued--);
    tail = result.catch(() => {});
    return result;
  };
  return { runMediaOperation: run, run, close };
}
async function runMediaOperation(operation, options = {}) {
  const session = await createMediaSession(options);
  let result, failure;
  try {
    result = await session.runMediaOperation(operation, options);
  } catch (error) {
    failure = error;
  }
  try {
    await session.close();
  } catch (cleanup) {
    failure = cleanupFailure(failure, cleanup);
  }
  if (failure) throw failure;
  return result;
}
module.exports = { createMediaSession, runMediaOperation };

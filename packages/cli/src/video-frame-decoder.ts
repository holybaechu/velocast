import {
  spawn as spawnProcess,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import type { Readable } from "node:stream";
import type { VideoPtsIndex } from "./video-pts.js";

export interface DecoderToolEvent {
  command: readonly string[];
  exitStatus: number | null;
  stdoutBytes: number;
  stderr: string;
  elapsedMs: number;
  terminated: boolean;
}

export interface SequentialDecoderOptions {
  binary: string;
  env?: NodeJS.ProcessEnv;
  metadata: VideoPtsIndex;
  maxDecodeFrames: number;
  maxLogBytes: number;
  timeoutMs: number;
  signal: AbortSignal;
  args(startFrameIndex: number, outputFrameIndex: number): string[];
  spawn?: (
    binary: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess;
  onCommand?: (event: DecoderToolEvent) => void;
}

export interface SequentialDecoder {
  decode(frameIndex: number, signal: AbortSignal): Promise<Buffer>;
  close(): Promise<void>;
}

interface SlotWaiter {
  grant: () => void;
  abort: () => void;
}

export const maximumLiveMediaProcesses = 8;
let liveMediaProcesses = 0;
const processWaiters: SlotWaiter[] = [];
const idleDecoders = new Map<symbol, () => void>();

function cancelled(signal: AbortSignal): Error {
  return new Error("video.cancelled: video frame work was cancelled", {
    cause: signal.reason,
  });
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw cancelled(signal);
}

function evictIdleDecoder(): void {
  const first = idleDecoders.entries().next().value as
    [symbol, () => void] | undefined;
  if (!first) return;
  idleDecoders.delete(first[0]);
  first[1]();
}

/**
 * One FIFO budget for probes and live decoder pipes. Warm decoders yield their
 * slot at a request boundary when another source is waiting.
 */
export async function acquireMediaProcess(
  signal: AbortSignal,
): Promise<() => void> {
  checkAbort(signal);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const next = processWaiters.shift();
    if (next) next.grant();
    else liveMediaProcesses--;
  };
  if (liveMediaProcesses < maximumLiveMediaProcesses) {
    liveMediaProcesses++;
    return release;
  }
  return new Promise((done, reject) => {
    const waiter: SlotWaiter = {
      grant: () => {
        signal.removeEventListener("abort", waiter.abort);
        done(release);
      },
      abort: () => {
        const index = processWaiters.indexOf(waiter);
        if (index >= 0) processWaiters.splice(index, 1);
        signal.removeEventListener("abort", waiter.abort);
        reject(cancelled(signal));
      },
    };
    processWaiters.push(waiter);
    signal.addEventListener("abort", waiter.abort, { once: true });
    evictIdleDecoder();
  });
}

function markDecoderActive(id: symbol): void {
  idleDecoders.delete(id);
}

function markDecoderIdle(id: symbol, close: () => void): void {
  idleDecoders.delete(id);
  idleDecoders.set(id, close);
  if (processWaiters.length > 0) evictIdleDecoder();
}

/** showinfo uses Adler-32 initialized to zero over packed, non-padding rows. */
export function videoPixelChecksum(pixels: Uint8Array): string {
  let a = 0,
    b = 0;
  for (let start = 0; start < pixels.length; start += 5552) {
    const end = Math.min(pixels.length, start + 5552);
    for (let index = start; index < end; index++) {
      a += pixels[index]!;
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return (((b << 16) | a) >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

interface FrameOracle {
  pts: number;
  format: string;
  width: number;
  height: number;
  checksum: string;
}

interface DecoderProcess {
  child: ChildProcess;
  command: string[];
  started: number;
  startIndex: number;
  nextIndex: number;
  iterator: AsyncIterator<Buffer>;
  remainder: Buffer;
  stderrLine: string;
  stderrTail: string;
  stderrBytes: number;
  stdoutBytes: number;
  oracles: FrameOracle[];
  oracleWaiters: Array<() => void>;
  exitStatus: number | null;
  closed: Promise<void>;
  release: () => void;
  terminated: boolean;
  reported: boolean;
  hasClosed: boolean;
}

function raceSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  deadlineMs: number,
): Promise<T> {
  checkAbort(signal);
  const timeout = () =>
    new Error("video.process_timeout: media tool exceeded its time budget");
  return new Promise((done, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => finish(() => reject(cancelled(signal)));
    const remainingMs = deadlineMs - performance.now();
    const timer = setTimeout(
      () => finish(() => reject(timeout())),
      Math.max(0, remainingMs),
    );
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      // Buffered data can resolve in a microtask before an overdue timeout
      // callback runs. Check the absolute deadline again before accepting it.
      (value) =>
        finish(() =>
          performance.now() >= deadlineMs ? reject(timeout()) : done(value),
        ),
      (error) => finish(() => reject(error)),
    );
  });
}

function orientationFilters(metadata: VideoPtsIndex): string[] {
  switch (metadata.rotationDegrees) {
    case 90:
      return ["transpose=cclock"];
    case 180:
      return ["hflip", "vflip"];
    case 270:
      return ["transpose=clock"];
    default:
      return [];
  }
}

export function videoNormalizationFilters(metadata: VideoPtsIndex): string[] {
  const filters = orientationFilters(metadata);
  if (metadata.normalization === "hdr-to-sdr-bt709")
    filters.push(
      "zscale=transfer=linear:npl=100",
      "format=gbrpf32le",
      "tonemap=mobius:param=0.3:desat=2",
      "zscale=primaries=bt709:transfer=bt709:matrix=bt709:range=limited",
    );
  filters.push("format=pix_fmts=rgba", "showinfo@velocast_pts=checksum=1");
  return filters;
}

export function createSequentialVideoDecoder(
  options: SequentialDecoderOptions,
): SequentialDecoder {
  const id = Symbol("video-decoder"),
    metadata = options.metadata;
  let process: DecoderProcess | undefined,
    closed = false,
    closePromise: Promise<void> | undefined;

  const report = (value: DecoderProcess) => {
    if (value.reported) return;
    value.reported = true;
    options.onCommand?.({
      command: value.command,
      exitStatus: value.exitStatus,
      stdoutBytes: value.stdoutBytes,
      stderr: value.stderrTail,
      elapsedMs: performance.now() - value.started,
      terminated: value.terminated,
    });
  };

  const stop = async (value: DecoderProcess, terminated = true) => {
    idleDecoders.delete(id);
    const running =
      value.child.exitCode === null && value.child.signalCode === null;
    if (running) {
      value.terminated ||= terminated;
      value.child.kill("SIGKILL");
      value.child.stdout?.destroy();
      value.child.stderr?.destroy();
    } else if (!value.hasClosed) {
      // `exit` can precede `close` while pipe data is still pending. Discard
      // unread pixels but keep draining diagnostics so the final oracle/tail
      // is observed before the process slot is released.
      value.child.stdout?.destroy();
      value.child.stderr?.resume();
    }
    await value.closed;
    report(value);
    if (process === value) process = undefined;
  };

  const start = async (
    startIndex: number,
    outputFrameIndex: number,
    signal: AbortSignal,
  ) => {
    const release = await acquireMediaProcess(signal);
    try {
      checkAbort(signal);
    } catch (error) {
      release();
      throw error;
    }
    const args = options.args(startIndex, outputFrameIndex),
      command = [options.binary, ...args],
      started = performance.now();
    let child: ChildProcess;
    try {
      child = (options.spawn ?? spawnProcess)(options.binary, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        ...(options.env ? { env: options.env } : {}),
      });
    } catch (error) {
      release();
      throw error;
    }
    if (!child.stdout || !child.stderr) {
      release();
      child.kill("SIGKILL");
      throw new Error("video.process_failed: decoder pipes unavailable");
    }
    child.stdout.pause();
    let resolveClosed!: () => void;
    const value: DecoderProcess = {
      child,
      command,
      started,
      startIndex,
      nextIndex: outputFrameIndex,
      iterator: (child.stdout as Readable)[
        Symbol.asyncIterator
      ]() as AsyncIterator<Buffer>,
      remainder: Buffer.alloc(0),
      stderrLine: "",
      stderrTail: "",
      stderrBytes: 0,
      stdoutBytes: 0,
      oracles: [],
      oracleWaiters: [],
      exitStatus: null,
      closed: new Promise<void>((done) => (resolveClosed = done)),
      release,
      terminated: false,
      reported: false,
      hasClosed: false,
    };
    const appendTail = (text: string) => {
      value.stderrTail = (value.stderrTail + text).slice(-options.maxLogBytes);
    };
    child.stderr.on("data", (chunk: Buffer) => {
      value.stderrBytes += chunk.length;
      value.stderrLine += chunk.toString("utf8");
      if (value.stderrLine.length > options.maxLogBytes) {
        void stop(value);
        return;
      }
      const lines = value.stderrLine.split(/\r?\n/);
      value.stderrLine = lines.pop() ?? "";
      for (const line of lines) {
        appendTail(`${line}\n`);
        const frame =
          /\bn:\s*\d+\s+pts:\s*(-?\d+)\b.*\bfmt:(\w+)\b.*\bs:(\d+)x(\d+)\b.*\bchecksum:([A-Fa-f0-9]+)/.exec(
            line,
          );
        if (frame)
          value.oracles.push({
            pts: Number(frame[1]),
            format: frame[2]!,
            width: Number(frame[3]),
            height: Number(frame[4]),
            checksum: frame[5]!.toUpperCase(),
          });
      }
      if (value.oracles.length >= 64) child.stderr!.pause();
      for (const wake of value.oracleWaiters.splice(0)) wake();
    });
    child.once("error", (error) => appendTail(`${String(error)}\n`));
    let finalized = false;
    const finalize = (code: number | null) => {
      if (finalized) return;
      finalized = true;
      value.hasClosed = true;
      value.exitStatus = code;
      appendTail(value.stderrLine);
      value.release();
      idleDecoders.delete(id);
      for (const wake of value.oracleWaiters.splice(0)) wake();
      resolveClosed();
      report(value);
      if (process === value) process = undefined;
    };
    child.once("exit", (code) => {
      value.exitStatus = code;
    });
    child.once("close", finalize);
    process = value;
    return value;
  };

  const nextOracle = async (
    value: DecoderProcess,
    signal: AbortSignal,
    deadlineMs: number,
  ): Promise<FrameOracle> => {
    while (value.oracles.length === 0) {
      if (value.hasClosed)
        throw new Error(
          `video.process_failed: decoder ended before frame metadata: ${value.stderrTail.trim()}`,
        );
      await raceSignal(
        new Promise<void>((done) => value.oracleWaiters.push(done)),
        signal,
        deadlineMs,
      );
    }
    const oracle = value.oracles.shift()!;
    if (value.oracles.length < 32) value.child.stderr?.resume();
    return oracle;
  };

  const readFrame = async (
    value: DecoderProcess,
    signal: AbortSignal,
    deadlineMs: number,
  ): Promise<Buffer> => {
    const output = Buffer.allocUnsafe(metadata.frameBytes);
    let offset = 0;
    if (value.remainder.length > 0) {
      const count = Math.min(value.remainder.length, output.length);
      value.remainder.copy(output, 0, 0, count);
      value.remainder = value.remainder.subarray(count);
      offset = count;
    }
    while (offset < output.length) {
      const item = await raceSignal(
        Promise.resolve(value.iterator.next()),
        signal,
        deadlineMs,
      );
      if (item.done || !item.value)
        throw new Error(
          `video.frame_missing: decoder ended before one complete RGBA frame: ${value.stderrTail.trim()}`,
        );
      const chunk = Buffer.from(item.value);
      value.stdoutBytes += chunk.length;
      const count = Math.min(chunk.length, output.length - offset);
      chunk.copy(output, offset, 0, count);
      offset += count;
      if (count < chunk.length) value.remainder = chunk.subarray(count);
    }
    return output;
  };

  const decode = async (frameIndex: number, signal: AbortSignal) => {
    checkAbort(signal);
    if (closed) throw new Error("video.closed: frame source is closed");
    const target = metadata.frames[frameIndex]!;
    let value = process;
    if (
      value &&
      (frameIndex < value.nextIndex ||
        frameIndex - value.nextIndex > Math.min(options.maxDecodeFrames, 8))
    ) {
      await stop(value);
      value = undefined;
    }
    if (!value) value = await start(target.keyframeIndex, frameIndex, signal);
    markDecoderActive(id);
    const deadlineMs = performance.now() + options.timeoutMs;
    try {
      let selected: Buffer | undefined;
      while (value.nextIndex <= frameIndex) {
        checkAbort(signal);
        const current = metadata.frames[value.nextIndex];
        if (!current)
          throw new Error("video.frame_missing: decoder exceeded PTS index");
        const pixels = await readFrame(value, signal, deadlineMs),
          oracle = await nextOracle(value, signal, deadlineMs);
        if (
          oracle.pts !== current.pts ||
          oracle.format !== "rgba" ||
          oracle.width !== metadata.width ||
          oracle.height !== metadata.height ||
          (value.nextIndex === frameIndex &&
            oracle.checksum !== videoPixelChecksum(pixels))
        )
          throw new Error(
            "video.pts_mismatch: decoded pixels/PTS did not match the indexed source frame",
          );
        if (value.nextIndex === frameIndex) selected = pixels;
        value.nextIndex++;
      }
      if (!selected)
        throw new Error("video.frame_missing: selected frame was not decoded");
      return selected;
    } catch (error) {
      await stop(value);
      throw error;
    } finally {
      if (process === value)
        markDecoderIdle(id, () => {
          void stop(value!);
        });
    }
  };

  const abortLifetime = () => {
    closed = true;
    idleDecoders.delete(id);
    if (process) void stop(process);
  };
  options.signal.addEventListener("abort", abortLifetime, { once: true });

  return {
    decode,
    close() {
      if (!closePromise) {
        closed = true;
        options.signal.removeEventListener("abort", abortLifetime);
        idleDecoders.delete(id);
        closePromise = process ? stop(process) : Promise.resolve();
      }
      return closePromise;
    },
  };
}

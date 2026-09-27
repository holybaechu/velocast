import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, realpath, rename, rm, stat } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { validateAudioPlan } from "@velocast/core";
import type { AudioPlan } from "@velocast/core";
import { buildAudioPlanFfmpegCommand } from "./audio-plan-ffmpeg.js";
import type { AudioPlanFfmpegOptions } from "./audio-plan-ffmpeg.js";

export interface RenderAudioPlanPcmOptions extends AudioPlanFfmpegOptions {
  /** Explicit executable/wrapper argv, default ["ffmpeg"]. Never interpreted by a shell. */
  readonly command?: readonly string[];
  readonly signal?: AbortSignal;
}

async function discoveredSourceChannels(
  plan: AudioPlan,
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, 1 | 2>> {
  const result = new Map<string, 1 | 2>();
  for (const clip of validateAudioPlan(plan).clips) {
    if (result.has(clip.source)) continue;
    const probe = await execute(
      ["ffprobe"],
      [
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=channels",
        "-of",
        "default=nokey=1:noprint_wrappers=1",
        clip.source,
      ],
      process.cwd(),
      signal,
    );
    const channels = Number(probe.stdout.trim());
    if (channels !== 1 && channels !== 2)
      throw new Error(
        `audio.unsupported_channels: ${clip.source} has ${probe.stdout.trim() || "no"} audio channels; only mono/stereo is supported`,
      );
    result.set(clip.source, channels);
  }
  return result;
}

function normalizedSourceKey(source: string): string {
  const value = path.normalize(source);
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function snapshotSourceChannelCounts(
  plan: AudioPlan,
  supplied: ReadonlyMap<string, 1 | 2> | undefined,
): ReadonlyMap<string, 1 | 2> | undefined {
  if (!supplied) return undefined;
  const canonical = new Map<string, 1 | 2>();
  for (const [source, channels] of supplied) {
    if (typeof source !== "string" || !source)
      throw new TypeError(
        "audio source channel map keys must be nonempty strings",
      );
    if (channels !== 1 && channels !== 2)
      throw new RangeError("audio source channel counts must be 1 or 2");
    const key = normalizedSourceKey(source),
      previous = canonical.get(key);
    if (previous !== undefined && previous !== channels)
      throw new Error(
        "audio source channel map has inconsistent normalized paths",
      );
    canonical.set(key, channels);
  }
  const snapshot = new Map<string, 1 | 2>();
  for (const clip of plan.clips) {
    const channels = canonical.get(normalizedSourceKey(clip.source));
    if (channels === undefined)
      throw new Error(`audio source channel map is missing ${clip.source}`);
    snapshot.set(clip.source, channels);
  }
  return snapshot;
}

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new DOMException("Audio rendering was aborted", "AbortError");
}

async function execute(
  command: readonly string[],
  args: readonly string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  abortIfRequested(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(command[0]!, [...command.slice(1), ...args], {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let processError: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");
    child.stdout.on("data", (data: Buffer) => {
      stdout = (stdout + outDecoder.write(data)).slice(-65536);
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr = (stderr + errDecoder.write(data)).slice(-65536);
    });
    const abort = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 500);
      killTimer.unref();
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.on("error", (error) => {
      processError = error;
    });
    child.on("close", (code, terminatedBy) => {
      signal?.removeEventListener("abort", abort);
      if (killTimer) clearTimeout(killTimer);
      stdout = (stdout + outDecoder.end()).slice(-65536);
      stderr = (stderr + errDecoder.end()).slice(-65536);
      if (signal?.aborted)
        return reject(
          new DOMException("Audio rendering was aborted", "AbortError"),
        );
      if (processError) return reject(processError);
      if (code !== 0)
        return reject(
          Object.assign(
            new Error(
              `Audio process exited ${code ?? terminatedBy}: ${stderr}`,
            ),
            { exitCode: code, terminatedBy, stdout, stderr },
          ),
        );
      resolve({ stdout, stderr });
    });
  });
}

function lacksFilterGraphFileOption(error: unknown): boolean {
  if (
    !(error instanceof Error) ||
    !("stderr" in error) ||
    typeof error.stderr !== "string"
  )
    return false;
  const lines = error.stderr.split(/\r?\n/).map((line) => line.trim());
  return (
    lines.includes("Unrecognized option '/filter_complex'.") &&
    lines.includes("Error splitting the argument list: Option not found")
  );
}

async function verifyPcm(
  file: string,
  expectedBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  const details = await stat(file);
  if (!details.isFile() || details.size !== expectedBytes)
    throw new Error(
      `PCM length mismatch: expected ${expectedBytes}, got ${details.size}`,
    );
  const hash = createHash("sha256");
  let carry = Buffer.alloc(0);
  for await (const chunk of createReadStream(file, { highWaterMark: 65536 })) {
    abortIfRequested(signal);
    const bytes = chunk as Buffer;
    hash.update(bytes);
    const joined = carry.length ? Buffer.concat([carry, bytes]) : bytes;
    const complete = joined.length - (joined.length % 4);
    for (let offset = 0; offset < complete; offset += 4)
      if (!Number.isFinite(joined.readFloatLE(offset)))
        throw new Error("PCM output contains non-finite samples");
    carry = Buffer.from(joined.subarray(complete));
  }
  if (carry.length)
    throw new Error("PCM output has an incomplete float sample");
  return hash.digest("hex");
}

async function cleanupOwnedWorkspace(
  parent: string,
  temporary: string,
): Promise<void> {
  const resolvedParent = await realpath(parent);
  const resolvedTemporary = await realpath(temporary);
  if (
    path.dirname(resolvedTemporary) !== resolvedParent ||
    !path.basename(resolvedTemporary).startsWith(".velocast-audio-")
  ) {
    throw new Error("Refusing cleanup outside the owned audio workspace");
  }
  await rm(resolvedTemporary, { recursive: true, force: true });
}

/**
 * Standalone streaming PCM reference, not native mux integration. The direct
 * FFmpeg process is stopped and awaited on cancellation; private files are
 * always cleaned. A validated output is atomically renamed only after the final
 * cancellation check. Cancellation after publication begins does not roll back
 * the committed artifact. Wrappers must propagate termination to their children.
 */
export async function renderAudioPlanPcm(
  plan: AudioPlan,
  options: RenderAudioPlanPcmOptions,
) {
  const signal = options.signal;
  abortIfRequested(signal);
  const suppliedCommand = options.command ?? ["ffmpeg"];
  if (
    !Array.isArray(suppliedCommand) ||
    !suppliedCommand.length ||
    suppliedCommand.some(
      (part) => typeof part !== "string" || !part || part.includes("\0"),
    )
  )
    throw new TypeError("command must be an explicit nonempty argv array");
  const command = Object.freeze([...suppliedCommand]);
  const snapshot = validateAudioPlan(plan);
  const requestedChannelCount = options.channelCount;
  const suppliedSourceChannels = snapshotSourceChannelCounts(
    snapshot,
    options.sourceChannelCounts,
  );
  const sourceChannelCounts =
    suppliedSourceChannels ??
    (await discoveredSourceChannels(snapshot, signal));
  const requested = buildAudioPlanFfmpegCommand(snapshot, {
    ...options,
    channelCount: requestedChannelCount,
    sourceChannelCounts,
  });
  // Do not publish over an input, including aliases/hard links to an existing output.
  const existing = await stat(requested.outputPath).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (existing) {
    if (!existing.isFile()) throw new Error("Audio output must be a file");
    for (const source of requested.sourcePaths) {
      const details = await stat(source);
      if (
        (details.ino !== 0 &&
          details.dev === existing.dev &&
          details.ino === existing.ino) ||
        (await realpath(source)) === (await realpath(requested.outputPath))
      )
        throw new Error("Audio output must not replace a source file alias");
    }
  }
  abortIfRequested(signal);
  const parent = path.dirname(requested.outputPath);
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(path.join(parent, ".velocast-audio-"));
  try {
    const candidate = path.join(temporary, "audio.f32");
    const built = buildAudioPlanFfmpegCommand(snapshot, {
      outputPath: candidate,
      channelCount: requested.channelCount,
      sourceChannelCounts,
    });
    const args = [...built.args];
    const graphIndex = args.indexOf("-filter_complex");
    const graphPath = path.join(temporary, "audio-filter.txt");
    await writeFile(graphPath, built.filterGraph, "utf8");
    args[graphIndex] = "-/filter_complex";
    args[graphIndex + 1] = graphPath;
    let diagnostics;
    try {
      diagnostics = await execute(command, args, temporary, signal);
    } catch (error) {
      // FFmpeg 6.1 needs the legacy spelling, which FFmpeg 9 removed. Retry
      // only an argument-parser rejection, before FFmpeg opens any media files.
      if (!lacksFilterGraphFileOption(error)) throw error;
      args[graphIndex] = "-filter_complex_script";
      diagnostics = await execute(command, args, temporary, signal);
    }
    const sha256 = await verifyPcm(candidate, built.expectedBytes, signal);
    abortIfRequested(signal);
    await rename(candidate, requested.outputPath);
    return {
      outputPath: requested.outputPath,
      bytes: built.expectedBytes,
      sha256,
      sampleRate: built.sampleRate,
      channelCount: built.channelCount,
      durationSamples: built.durationSamples,
      format: built.format,
      diagnostics,
    };
  } finally {
    await cleanupOwnedWorkspace(parent, temporary);
  }
}

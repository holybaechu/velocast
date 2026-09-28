import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, realpath, rename, stat, copyFile, rm } from "node:fs/promises";
import path from "node:path";
import { normalizeAudioPlan } from "@velocast/core";
import type { AudioPlan } from "@velocast/core";
import { runMediaOperation, type MediaRunner } from "./media-runtime.js";
import { mediaWorkspace } from "./media-workspace.js";
export interface RenderAudioPlanPcmOptions {
  readonly outputPath: string;
  readonly channelCount: 1 | 2;
  readonly sourceChannelCounts?: ReadonlyMap<string, 1 | 2>;
  readonly signal?: AbortSignal;
  readonly mediaRunner?: MediaRunner;
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
  signal?.throwIfAborted();
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

/** Sample-accurate WebCodecs PCM rendering, validated before publication. */
export async function renderAudioPlanPcm(
  plan: AudioPlan,
  options: RenderAudioPlanPcmOptions,
) {
  const signal = options.signal;
  abortIfRequested(signal);
  const snapshot = normalizeAudioPlan(plan);
  const outputPath = options.outputPath,
    channelCount = options.channelCount,
    mediaRunner = options.mediaRunner ?? runMediaOperation;
  snapshotSourceChannelCounts(snapshot, options.sourceChannelCounts);
  if (channelCount !== 1 && channelCount !== 2)
    throw new RangeError("channelCount must be 1 or 2");
  if (!path.isAbsolute(outputPath) || /[\0\r\n]/.test(outputPath))
    throw new TypeError(
      "outputPath must be a caller-resolved absolute path without NUL/newlines",
    );
  const expectedBytes = snapshot.durationSamples * channelCount * 4;
  if (!Number.isSafeInteger(expectedBytes))
    throw new RangeError("PCM output byte count must be a safe integer");
  const existing = await stat(outputPath).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  for (const clip of snapshot.clips) {
    if (normalizedSourceKey(clip.source) === normalizedSourceKey(outputPath))
      throw new Error("Audio output must not replace a source file");
    if (existing) {
      const source = await stat(clip.source);
      if (
        (source.ino !== 0 &&
          source.dev === existing.dev &&
          source.ino === existing.ino) ||
        (await realpath(clip.source)) === (await realpath(outputPath))
      )
        throw new Error("Audio output must not replace a source file alias");
    }
  }
  if (existing && !existing.isFile())
    throw new Error("Audio output must be a file");
  const workspace = await mediaWorkspace();
  try {
    const candidate = path.join(workspace.path, "audio.f32");
    await mediaRunner(
      {
        kind: "mix-audio",
        plan: snapshot,
        outputPath: candidate,
        channels: channelCount,
        format: "f32",
      },
      { signal },
    );
    const sha256 = await verifyPcm(candidate, expectedBytes, signal);
    await mkdir(path.dirname(outputPath), { recursive: true });
    abortIfRequested(signal);
    try {
      await rename(candidate, outputPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      const publication = path.join(
        path.dirname(outputPath),
        `.velocast-publish-${randomUUID()}.f32`,
      );
      try {
        await copyFile(candidate, publication);
        abortIfRequested(signal);
        await rename(publication, outputPath);
      } finally {
        await rm(publication, { force: true });
      }
    }
    return {
      outputPath: outputPath,
      bytes: expectedBytes,
      sha256,
      sampleRate: snapshot.sampleRate,
      channelCount: channelCount,
      durationSamples: snapshot.durationSamples,
      format: "f32le" as const,
      diagnostics: { stdout: "", stderr: "" },
    };
  } finally {
    await workspace.close();
  }
}

import { spawn } from "node:child_process";
import {
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { renderSourceOutput } from "./source-output.js";

let directory: string;
let video: string;
let audio: string;
let encodedAudio: string;
let combined: string;
let otherVideo: string;

async function command(executable: string, args: string[]): Promise<string> {
  const child = spawn(executable, args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  const code = await new Promise<number | null>((done, reject) => {
    child.once("error", reject);
    child.once("close", done);
  });
  if (code !== 0) throw new Error(`${executable} failed: ${stderr}`);
  return stdout;
}

async function streams(
  path: string,
): Promise<{ codec_type: string; codec_name: string }[]> {
  const json = await command("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_type,codec_name",
    "-of",
    "json",
    path,
  ]);
  return (
    JSON.parse(json) as {
      streams: { codec_type: string; codec_name: string }[];
    }
  ).streams;
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "velocast-source-output-test-"));
  video = join(directory, "fixture.mp4");
  audio = join(directory, "fixture.wav");
  encodedAudio = join(directory, "fixture.aac");
  combined = join(directory, "combined.mp4");
  otherVideo = join(directory, "other-video.mp4");
  await command("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=32x32:r=10:d=0.6",
    "-an",
    "-c:v",
    "mpeg4",
    video,
  ]);
  await command("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=0.6",
    "-c:a",
    "pcm_s16le",
    audio,
  ]);
  await command("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    audio,
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    encodedAudio,
  ]);
  await command("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=64x64:r=10:d=0.3",
    "-an",
    "-c:v",
    "mpeg4",
    otherVideo,
  ]);
  await command("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    video,
    "-i",
    audio,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    combined,
  ]);
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

it("publishes a valid video with source-supplied AAC audio", async () => {
  const output = join(directory, "with-audio.mp4");
  const order: string[] = [];
  await writeFile(output, "old output");
  expect(
    await renderSourceOutput({
      output,
      renderVideo: async (path) => {
        order.push("video");
        await copyFile(video, path);
      },
      renderAudio: async (path) => {
        order.push("audio");
        await copyFile(audio, path);
        return path;
      },
    }),
  ).toBe(output);
  expect(order).toEqual(["video", "audio"]);
  expect(await streams(output)).toEqual([
    expect.objectContaining({ codec_type: "video" }),
    expect.objectContaining({ codec_type: "audio", codec_name: "aac" }),
  ]);
  expect(
    (await readdir(directory)).filter((name) => name.includes(".velocast-")),
  ).toEqual([]);
});

it("copies encoded AAC audio without introducing a new sample offset", async () => {
  const output = join(directory, "aac-copy.mp4");
  await renderSourceOutput({
    output,
    renderVideo: (path) => copyFile(video, path),
    renderAudio: async (path) => {
      expect(path).toMatch(/\.aac$/);
      await copyFile(encodedAudio, path);
      return path;
    },
  });
  const sourcePcm = join(directory, "source-aac.pcm");
  const muxedPcm = join(directory, "muxed-aac.pcm");
  for (const [input, pcm] of [
    [encodedAudio, sourcePcm],
    [output, muxedPcm],
  ] as const) {
    await command("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      input,
      "-map",
      "0:a:0",
      "-c:a",
      "pcm_s16le",
      "-f",
      "s16le",
      pcm,
    ]);
  }
  expect(await readFile(muxedPcm)).toEqual(await readFile(sourcePcm));
  expect(
    (await streams(output)).find((stream) => stream.codec_type === "audio")
      ?.codec_name,
  ).toBe("aac");
});

it("publishes the video alone when the source returns no audio", async () => {
  const output = join(directory, "silent.mp4");
  await renderSourceOutput({
    output,
    renderVideo: (path) => copyFile(video, path),
    renderAudio: async () => null,
  });
  expect((await streams(output)).map((stream) => stream.codec_type)).toEqual([
    "video",
  ]);
});

it("passes through an upstream MP4 with finished audio", async () => {
  const output = join(directory, "passthrough.mp4");
  await renderSourceOutput({
    output,
    renderVideo: (path) => copyFile(combined, path),
    renderAudio: async () => null,
  });
  expect(await readFile(output)).toEqual(await readFile(combined));
  expect((await streams(output)).map((stream) => stream.codec_type)).toEqual([
    "video",
    "audio",
  ]);
});

it("rejects a second audio track without replacing an existing output", async () => {
  const output = join(directory, "duplicate-audio.mp4");
  await writeFile(output, "original");
  await expect(
    renderSourceOutput({
      output,
      renderVideo: (path) => copyFile(combined, path),
      renderAudio: async (path) => {
        await copyFile(audio, path);
        return path;
      },
    }),
  ).rejects.toThrow(/already has audio/);
  expect(await readFile(output, "utf8")).toBe("original");
});

it("rejects a video changed after the first probe and preserves prior output", async () => {
  const output = join(directory, "changed-video.mp4");
  await writeFile(output, "original");
  await expect(
    renderSourceOutput({
      output,
      renderVideo: (path) => copyFile(video, path),
      renderAudio: async (path) => {
        await copyFile(otherVideo, join(dirname(path), "video.mp4"));
        return null;
      },
    }),
  ).rejects.toThrow(/Final media video/);
  expect(await readFile(output, "utf8")).toBe("original");
});

it("preserves prior output when audio processing fails", async () => {
  const output = join(directory, "failed.mp4");
  await writeFile(output, "original");
  await expect(
    renderSourceOutput({
      output,
      renderVideo: (path) => copyFile(video, path),
      renderAudio: async (path) => {
        await writeFile(path, "not audio");
        return path;
      },
    }),
  ).rejects.toThrow();
  expect(await readFile(output, "utf8")).toBe("original");
  expect(
    (await readdir(directory)).filter((name) => name.includes(".velocast-")),
  ).toEqual([]);
});

it("preserves prior output and skips audio after cancellation", async () => {
  const output = join(directory, "cancelled.mp4");
  await writeFile(output, "original");
  const controller = new AbortController();
  let audioCalled = false;
  await expect(
    renderSourceOutput({
      output,
      signal: controller.signal,
      renderVideo: async (path) => {
        await copyFile(video, path);
        controller.abort();
      },
      renderAudio: async () => {
        audioCalled = true;
        return null;
      },
    }),
  ).rejects.toThrow();
  expect(audioCalled).toBe(false);
  expect(await readFile(output, "utf8")).toBe("original");
  expect(
    (await readdir(directory)).filter((name) => name.includes(".velocast-")),
  ).toEqual([]);
});

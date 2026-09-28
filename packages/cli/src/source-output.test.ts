import { runMediaOperation, type MediaProbe } from "./media-runtime.js";
import { writeTestVideo, writeTestWav } from "./media-test-fixtures.js";
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
let encodedOpus: string;
let automaticAudioCodec: string;
let combined: string;
let otherVideo: string;

async function streams(
  path: string,
): Promise<{ codec_type: string; codec_name: string }[]> {
  const result = await runMediaOperation<MediaProbe>({ kind: "probe", path });
  return [
    ...(result.video
      ? [{ codec_type: "video", codec_name: result.video.codec }]
      : []),
    ...(result.audio
      ? [{ codec_type: "audio", codec_name: result.audio.codec ?? "" }]
      : []),
  ];
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "velocast-source-output-test-"));
  video = join(directory, "fixture.mp4");
  audio = join(directory, "fixture.wav");
  encodedAudio = join(directory, "fixture-audio.mp4");
  encodedOpus = join(directory, "fixture-opus.mp4");
  combined = join(directory, "combined.mp4");
  otherVideo = join(directory, "other-video.mp4");
  await writeTestVideo(video, directory, {
    width: 160,
    height: 100,
    fps: 10,
    frames: 6,
  });
  await writeTestWav(audio, 0.6, 48000);
  await writeTestVideo(otherVideo, directory, {
    width: 64,
    height: 64,
    fps: 10,
    frames: 3,
  });
  await runMediaOperation({
    kind: "mux-audio",
    videoPath: video,
    audioPath: audio,
    outputPath: combined,
  });
  await runMediaOperation({
    kind: "encode-audio",
    path: audio,
    outputPath: encodedAudio,
  });
  await runMediaOperation({
    kind: "encode-audio",
    path: audio,
    outputPath: encodedOpus,
    audioCodec: "opus",
  });
  const encodedStream = (await streams(encodedAudio)).find(
    (stream) => stream.codec_type === "audio",
  );
  if (!encodedStream?.codec_name)
    throw new Error("Generated fixture has no encoded audio track");
  automaticAudioCodec = encodedStream.codec_name;
}, 120_000);

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
}, 120_000);

it("publishes video with source audio using the available WebCodecs codec", async () => {
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
    expect.objectContaining({
      codec_type: "audio",
      codec_name: automaticAudioCodec,
    }),
  ]);
  expect(
    (await readdir(directory)).filter((name) => name.includes(".velocast-")),
  ).toEqual([]);
}, 120_000);

it.each(["auto", "opus"])(
  "copies encoded %s audio without a codec change or new sample offset",
  async (selection) => {
    const inputAudio = selection === "opus" ? encodedOpus : encodedAudio;
    const expectedCodec = (await streams(inputAudio)).find(
      (stream) => stream.codec_type === "audio",
    )?.codec_name;
    expect(expectedCodec).toBeTruthy();
    const output = join(directory, `${selection}-copy.mp4`);
    await renderSourceOutput({
      output,
      renderVideo: (path) => copyFile(video, path),
      renderAudio: async (path) => {
        expect(path).toMatch(/\.wav$/);
        await copyFile(inputAudio, path);
        return path;
      },
    });
    const sourcePcm = join(directory, `source-${selection}.pcm`);
    const muxedPcm = join(directory, `muxed-${selection}.pcm`);
    for (const [input, pcm] of [
      [inputAudio, sourcePcm],
      [output, muxedPcm],
    ] as const) {
      await runMediaOperation({
        kind: "decode-audio",
        path: input,
        outputPath: pcm,
        sampleRate: 48000,
        channels: 1,
        format: "f32",
      });
    }
    expect(await readFile(muxedPcm)).toEqual(await readFile(sourcePcm));
    expect(
      (await streams(output)).find((stream) => stream.codec_type === "audio")
        ?.codec_name,
    ).toBe(expectedCodec);
  },
  120_000,
);

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
}, 120_000);

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
}, 120_000);

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
}, 120_000);

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
}, 120_000);

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
}, 120_000);

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
}, 120_000);

// @vitest-environment node
import { createRequire } from "node:module";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runMediaOperation, type MediaProbe } from "velocast/source-media";
import { writeTestVideo } from "../../cli/src/media-test-fixtures.js";
import {
  prepareRemotionSource,
  discoverRemotionCompositions,
} from "./upstream-host.js";

it("discovers, captures OffthreadVideo and mixes the genuine Remotion sequence/loop timeline without upstream media helpers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "velocast-remotion-real-"));
  let source: Awaited<ReturnType<typeof prepareRemotionSource>> | undefined;
  try {
    const moduleRoot = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../node_modules",
    );
    await symlink(moduleRoot, join(directory, "node_modules"), "junction");
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        name: "remotion-test",
        dependencies: {
          remotion: "4.0.244",
          "@remotion/bundler": "4.0.244",
          react: "18.3.1",
          "react-dom": "18.3.1",
        },
      }),
    );
    await mkdir(join(directory, "public"));
    await writeTestVideo(join(directory, "public", "video.mp4"), directory, {
      width: 160,
      height: 100,
      frames: 6,
      fps: 6,
    });
    const count = 48000,
      wave = Buffer.alloc(44 + count * 4);
    wave.write("RIFF");
    wave.writeUInt32LE(wave.length - 8, 4);
    wave.write("WAVEfmt ", 8);
    wave.writeUInt32LE(16, 16);
    wave.writeUInt16LE(3, 20);
    wave.writeUInt16LE(1, 22);
    wave.writeUInt32LE(48000, 24);
    wave.writeUInt32LE(192000, 28);
    wave.writeUInt16LE(4, 32);
    wave.writeUInt16LE(32, 34);
    wave.write("data", 36);
    wave.writeUInt32LE(count * 4, 40);
    for (let index = 0; index < count; index++)
      wave.writeFloatLE(0.5, 44 + index * 4);
    await writeFile(join(directory, "public", "tone.wav"), wave);
    const entryPoint = join(directory, "index.tsx");
    await writeFile(
      entryPoint,
      `import React from 'react'; import {registerRoot,Composition,AbsoluteFill,Audio,Sequence,Loop,OffthreadVideo,staticFile} from 'remotion';
      const Scene=()=> <AbsoluteFill><OffthreadVideo src={staticFile('video.mp4')} muted style={{width:160,height:100}}/><Sequence from={1} durationInFrames={4}><Loop durationInFrames={2}><Audio src={staticFile('tone.wav')} startFrom={1} volume={f=>f%2===0?0.25:0.5}/></Loop></Sequence></AbsoluteFill>;
      registerRoot(()=> <Composition id="Original" component={Scene} width={160} height={100} fps={6} durationInFrames={6}/>);`,
    );
    const childProcesses = createRequire(import.meta.url)(
      "node:child_process",
    ) as typeof import("node:child_process");
    const originalSpawn = childProcesses.spawn;
    childProcesses.spawn = ((binary: string, ...args: unknown[]) => {
      if (
        /(?:^|[\\/])(?:ffmpeg|ffprobe|remotion|compositor)(?:\.exe)?$/i.test(
          binary,
        )
      )
        throw new Error(`Forbidden external media tool: ${binary}`);
      return Reflect.apply(originalSpawn, childProcesses, [binary, ...args]);
    }) as typeof childProcesses.spawn;
    try {
      const compositions = await discoverRemotionCompositions({
        entryPoint,
        timeoutInMilliseconds: 30000,
      });
      expect(compositions).toMatchObject([
        { id: "Original", durationInFrames: 6, fps: 6 },
      ]);
      source = await prepareRemotionSource({
        entryPoint,
        compositionId: "Original",
        timeoutInMilliseconds: 30000,
      });
      const audio = join(directory, "mixed.wav");
      await source.renderAudio(audio);
      const pcm = join(directory, "mixed.f32");
      await runMediaOperation({
        kind: "decode-audio",
        path: audio,
        outputPath: pcm,
        channels: 2,
        sampleRate: 48000,
        format: "f32",
      });
      const bytes = await readFile(pcm);
      expect(bytes.length).toBe(48000 * 8);
      expect(bytes.readFloatLE(100 * 8)).toBe(0);
      expect(bytes.readFloatLE(9000 * 8)).toBeGreaterThan(0);
      expect(bytes.readFloatLE(9000 * 8)).toBeCloseTo(
        bytes.readFloatLE(25000 * 8),
        5,
      );
      expect(bytes.readFloatLE(45000 * 8)).toBe(0);
      const frame = join(directory, "frame.png");
      await source.renderReferenceFrame(2, frame);
      expect((await readFile(frame)).subarray(0, 8)).toEqual(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );
      const output = join(directory, "reference.mp4");
      await source.renderReference(output);
      const probe = await runMediaOperation<MediaProbe>({
        kind: "probe",
        path: output,
        frames: true,
      });
      expect(probe.video?.frames).toHaveLength(6);
      expect(probe.audio?.channels).toBe(2);
    } finally {
      childProcesses.spawn = originalSpawn;
    }
  } finally {
    await source?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);

import { expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { sliceAudioPlan, type AudioPlan } from "@velocast/core";
import { buildAudioPlanFfmpegCommand } from "./audio-plan-ffmpeg.js";
import { renderAudioPlanPcm } from "./audio-plan-render.js";
import { mixAudioPlanPcm } from "./audio-pcm-reference.js";

it("real FFmpeg sample fades/ducking match PCM oracle and full-versus-range samples", async () => {
  const root = await mkdtemp(join(tmpdir(), "velocast-envelope-"));
  try {
    const source = join(root, "input.wav");
    const channels = [
      Float32Array.from({ length: 800 }, (_, i) => Math.sin(i * 0.13) * 0.3),
      Float32Array.from({ length: 800 }, (_, i) => Math.cos(i * 0.21) * 0.4),
    ];
    const wav = Buffer.alloc(44 + 800 * 8);
    wav.write("RIFF");
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(3, 20);
    wav.writeUInt16LE(2, 22);
    wav.writeUInt32LE(48000, 24);
    wav.writeUInt32LE(48000 * 8, 28);
    wav.writeUInt16LE(8, 32);
    wav.writeUInt16LE(32, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(800 * 8, 40);
    for (let i = 0; i < 800; i++)
      for (let c = 0; c < 2; c++)
        wav.writeFloatLE(channels[c]![i]!, 44 + i * 8 + c * 4);
    await writeFile(source, wav);
    const plan: AudioPlan = {
      sampleRate: 48000,
      durationSamples: 900,
      clips: [
        {
          source,
          startSample: -13,
          sourceStartSample: 5,
          durationSamples: 840,
          gain: 0.6,
          volumeEnvelope: [
            { sample: 0, gain: 0 },
            { sample: 73, gain: 1 },
            { sample: 193, gain: 0.2 },
            { sample: 347, gain: 0.2 },
            { sample: 419, gain: 1 },
            { sample: 840, gain: 0 },
          ],
        },
      ],
    };
    const range = sliceAudioPlan(plan, 37, 711);
    await renderAudioPlanPcm(plan, {
      outputPath: join(root, "production.f32"),
      channelCount: 2,
    });
    const dense = {
      ...plan,
      clips: [
        {
          ...plan.clips[0]!,
          volumeEnvelope: Array.from({ length: 101 }, (_, i) => ({
            sample: i * 8,
            gain: Math.sin(i / 10) * 0.4 + 0.5,
          })),
        },
      ],
    };
    const large = {
      ...plan,
      clips: [
        {
          ...plan.clips[0]!,
          volumeEnvelope: Array.from({ length: 501 }, (_, sample) => ({
            sample,
            gain: Math.sin(sample / 10) * 0.4 + 0.5,
          })),
        },
      ],
    };
    const largePath = join(root, "large-production.f32");
    expect(
      buildAudioPlanFfmpegCommand(large, {
        outputPath: largePath,
        channelCount: 2,
      }).filterGraph.length,
    ).toBeGreaterThan(32767);
    await renderAudioPlanPcm(large, { outputPath: largePath, channelCount: 2 });
    const largeBytes = await readFile(largePath);
    const largeReference = mixAudioPlanPcm(
      large,
      new Map([[source, { sampleRate: 48000, channels }]]),
      2,
    );
    let largeError = 0;
    for (let sample = 0; sample < large.durationSamples; sample++)
      for (let channel = 0; channel < 2; channel++)
        largeError = Math.max(
          largeError,
          Math.abs(
            largeBytes.readFloatLE(sample * 8 + channel * 4) -
              largeReference.channels[channel]![sample]!,
          ),
        );
    expect(largeError).toBeLessThan(1e-7);
    const outputs: Buffer[] = [];
    for (const [index, selected] of [plan, range, dense].entries()) {
      const command = buildAudioPlanFfmpegCommand(selected, {
        outputPath: join(root, `${index}.f32`),
        channelCount: 2,
      });
      const result = spawnSync("ffmpeg", [...command.args], {
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      const output = await readFile(command.outputPath);
      outputs.push(output);
      const reference = mixAudioPlanPcm(
        selected,
        new Map([[source, { sampleRate: 48000, channels }]]),
        2,
      );
      expect(output.length).toBe(selected.durationSamples * 8);
      let error = 0;
      for (let i = 0; i < selected.durationSamples; i++)
        for (let c = 0; c < 2; c++)
          error = Math.max(
            error,
            Math.abs(
              output.readFloatLE(i * 8 + c * 4) - reference.channels[c]![i]!,
            ),
          );
      expect(error).toBeLessThan(1e-7);
    }
    let error = 0;
    for (let i = 0; i < range.durationSamples * 2; i++)
      error = Math.max(
        error,
        Math.abs(
          outputs[0]!.readFloatLE(37 * 8 + i * 4) -
            outputs[1]!.readFloatLE(i * 4),
        ),
      );
    expect(error).toBeLessThan(1e-7);
  } finally {
    expect(dirname(resolve(root))).toBe(resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
});

import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAudioPlanFfmpegCommand } from "./audio-plan-ffmpeg.js";

describe("audio-plan FFmpeg command", () => {
  it("keeps paths in argv and uses sample-accurate trim/offset with explicit audio selection", () => {
    const source = path.resolve("a [track],volume=99; 'quoted'.m4a");
    const output = path.resolve("result.f32");
    const command = buildAudioPlanFfmpegCommand(
      {
        sampleRate: 48000,
        durationSamples: 4800,
        clips: [
          {
            source,
            startSample: 100,
            sourceStartSample: 200,
            durationSamples: 300,
            gain: 0.5,
          },
        ],
      },
      { outputPath: output, channelCount: 1 },
    );
    expect(command.args[command.args.indexOf("-i") + 1]).toBe(source);
    expect(command.args.at(-1)).toBe(output);
    expect(command.filterGraph).not.toContain(source);
    expect(command.filterGraph).toContain("[0:a:0]");
    expect(command.filterGraph).toContain(
      "atrim=start_sample=200:end_sample=500",
    );
    expect(command.filterGraph).toContain("adelay=delays=100S:all=1");
    expect(command.filterGraph).toContain("apad=whole_len=4800");
    expect(command.filterGraph).toContain("normalize=0");
    expect(command.expectedBytes).toBe(19200);
  });

  it("normalizes preroll, selects every audio input explicitly and handles silence", () => {
    const source = path.resolve("song.wav");
    const outputPath = path.resolve("result.f32");
    const clip = {
      source,
      startSample: -10,
      sourceStartSample: 20,
      durationSamples: 100,
      gain: 2,
    };
    const command = buildAudioPlanFfmpegCommand(
      {
        sampleRate: 44100,
        durationSamples: 200,
        clips: [clip, { ...clip, startSample: 100 }],
      },
      { outputPath, channelCount: 2 },
    );
    expect(command.filterGraph).toContain(
      "atrim=start_sample=30:end_sample=120",
    );
    expect(command.filterGraph).toContain("[1:a:0]");
    expect(command.filterGraph).toContain(
      "amix=inputs=3:duration=first:dropout_transition=0:normalize=0",
    );
    expect(command.expectedBytes).toBe(1600);
    const silent = buildAudioPlanFfmpegCommand(
      { sampleRate: 48000, durationSamples: 5, clips: [] },
      { outputPath, channelCount: 1 },
    );
    expect(silent.args).not.toContain("-i");
    expect(silent.filterGraph).toContain("[base]anull[pcm]");
  });

  it("duplicates a discovered mono source at unity for stereo Web Audio parity", () => {
    const source = path.resolve("voice.wav");
    const command = buildAudioPlanFfmpegCommand(
      {
        sampleRate: 48000,
        durationSamples: 10,
        clips: [{ source, startSample: 0, sourceStartSample: 0, durationSamples: 10, gain: 1 }],
      },
      { outputPath: path.resolve("out.f32"), channelCount: 2, sourceChannelCounts: new Map([[source, 1]]) },
    );
    expect(command.filterGraph).toContain("pan=stereo|c0=c0|c1=c0");
  });

  it("rejects unresolved paths, source replacement and unsupported empty streaming plans", () => {
    const source = path.resolve("source.wav");
    const clip = {
      source,
      startSample: 0,
      sourceStartSample: 0,
      durationSamples: 4,
      gain: 1,
    };
    const plan = { sampleRate: 48000, durationSamples: 4, clips: [clip] };
    expect(() =>
      buildAudioPlanFfmpegCommand(plan, {
        outputPath: source,
        channelCount: 1,
      }),
    ).toThrow(/replace/);
    expect(() =>
      buildAudioPlanFfmpegCommand(
        { ...plan, clips: [{ ...clip, source: "relative.wav" }] },
        { outputPath: path.resolve("out.f32"), channelCount: 1 },
      ),
    ).toThrow(/absolute/);
    expect(() =>
      buildAudioPlanFfmpegCommand(
        { ...plan, durationSamples: 0 },
        { outputPath: path.resolve("out.f32"), channelCount: 1 },
      ),
    ).toThrow(/empty/);
  });
});

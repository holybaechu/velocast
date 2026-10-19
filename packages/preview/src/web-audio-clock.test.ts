import { expect, it } from "vitest";
import { PreviewController } from "./controller.js";
import { prepareWebAudioClock } from "./web-audio-clock.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const plan = () => ({
  sampleRate: 48000,
  durationSamples: 48000,
  clips: [
    {
      source: "frozen/song.wav",
      startSample: 4800,
      sourceStartSample: 9600,
      durationSamples: 24000,
      gain: 0.5,
    },
  ],
});
const buffer = (length = 48000, rate = 48000) =>
  ({ sampleRate: rate, length, numberOfChannels: 2 }) as AudioBuffer;
function device() {
  const automation: {
    method: "set" | "ramp";
    value: number;
    time: number;
  }[][] = [];
  const sources: {
    start: number[];
    stops: number;
    disconnected: boolean;
    gain?: number;
  }[] = [];
  let closes = 0;
  let resume = async () => {};
  const context = {
    sampleRate: 48000,
    currentTime: 100,
    state: "running",
    destination: {},
    resume: () => resume(),
    close: async () => {
      closes++;
    },
    createBufferSource() {
      const record = {
        start: [] as number[],
        stops: 0,
        disconnected: false,
        gain: 0,
      };
      sources.push(record);
      return {
        buffer: null,
        playbackRate: { value: 0 },
        onended: null,
        connect(gain: { gain: { value: number } }) {
          record.gain = gain.gain.value;
        },
        disconnect() {
          record.disconnected = true;
        },
        start(...args: number[]) {
          record.start = args;
        },
        stop() {
          record.stops++;
        },
      };
    },
    createGain() {
      const events: (typeof automation)[number] = [];
      automation.push(events);
      return {
        gain: {
          value: 1,
          setValueAtTime(value: number, time: number) {
            events.push({ method: "set", value, time });
          },
          linearRampToValueAtTime(value: number, time: number) {
            events.push({ method: "ramp", value, time });
          },
        },
        connect() {},
        disconnect() {},
      };
    },
  };
  return {
    context,
    sources,
    automation,
    closes: () => closes,
    resumeWith: (operation: () => Promise<void>) => {
      resume = operation;
    },
    options: {
      createContext: () => context as unknown as AudioContext,
      loadBuffer: async () => buffer(),
    },
  };
}

it("schedules original source trim and offset, follows audio time, and replaces sources on seek", async () => {
  const fake = device();
  const clock = await prepareWebAudioClock(plan(), fake.options);
  expect(fake.sources).toHaveLength(0);
  await clock.play();
  expect(fake.sources[0]!.start).toEqual([100.1, 0.2, 0.5]);
  expect(fake.sources[0]!.gain).toBe(0.5);
  fake.context.currentTime = 100.25;
  expect(clock.currentSample()).toBe(12000);
  clock.seek(24000);
  expect(fake.sources[0]).toMatchObject({ stops: 1, disconnected: true });
  expect(fake.sources[1]!.start).toEqual([100.25, 0.6, 0.1]);
  fake.context.currentTime = 101;
  expect(clock.currentSample()).toBe(48000);
  clock.pause();
  expect(fake.sources[1]!.stops).toBe(1);
  await clock.dispose();
  await clock.dispose();
  expect(fake.closes()).toBe(1);
  expect(() => clock.currentSample()).toThrow("preview.audio_closed");
});

it("bounds scheduled audio and its cursor independently of visual ticks, then supports seek, replay and full-plan resume", async () => {
  const fake = device();
  const clock = await prepareWebAudioClock(plan(), fake.options);
  await clock.play(0, 12000);
  expect(fake.sources[0]!.start).toEqual([100.1, 0.2, 0.15]);
  fake.context.currentTime = 101;
  expect(clock.currentSample()).toBe(12000);

  clock.seek(9600);
  expect(fake.sources[0]!.stops).toBe(1);
  expect(fake.sources[1]!.start).toEqual([101, 0.3, 0.05]);
  clock.seek(12000);
  expect(fake.sources[1]!.stops).toBe(1);
  expect(fake.sources).toHaveLength(2);
  await clock.play(4800, 12000);
  expect(fake.sources[2]!.start).toEqual([101, 0.2, 0.15]);
  fake.context.currentTime = 102;
  clock.pause();
  expect(clock.currentSample()).toBe(12000);

  await clock.play();
  expect(fake.sources[3]!.start).toEqual([102, 0.35, 0.35]);
  fake.context.currentTime = 103;
  expect(clock.currentSample()).toBe(48000);
  await clock.dispose();
});

it("changes playback end without moving the cursor and rejects invalid ranges before stopping sound", async () => {
  const fake = device();
  const clock = await prepareWebAudioClock(plan(), fake.options);
  await clock.play(4800, 24000);
  fake.context.currentTime = 100.125;
  expect(clock.currentSample()).toBe(10800);
  for (const end of [-1, 0.5, 48001])
    await expect(clock.play(undefined, end)).rejects.toThrow(
      "preview.audio_position",
    );
  await expect(clock.play(24001, 24000)).rejects.toThrow("preview.audio_range");
  await expect(clock.play(undefined, 9600)).rejects.toThrow(
    "preview.audio_range",
  );
  expect(fake.sources[0]!.stops).toBe(0);
  expect(clock.currentSample()).toBe(10800);

  await clock.play(undefined, 12000);
  expect(fake.sources[0]!.stops).toBe(1);
  expect(fake.sources[1]!.start).toEqual([100.125, 0.325, 0.025]);
  fake.context.currentTime = 101;
  expect(clock.currentSample()).toBe(12000);
  await clock.dispose();
});

it("rejects invalid range changes without cancelling a pending bounded resume", async () => {
  const fake = device();
  const resumed = deferred<void>();
  fake.resumeWith(() => resumed.promise);
  const clock = await prepareWebAudioClock(plan(), fake.options);
  const pending = clock.play(4800, 12000);
  await expect(clock.play(24000, 12000)).rejects.toThrow("preview.audio_range");
  resumed.resolve();
  await pending;
  expect(fake.sources[0]!.start).toEqual([100, 0.2, 0.15]);
  await clock.dispose();
});

it("ends range audio while a visual seek is still pending", async () => {
  const fake = device();
  const clock = await prepareWebAudioClock(plan(), fake.options);
  const seeking = deferred<void>();
  const frame = deferred<number>();
  let tick: (() => void) | undefined;
  const controller = new PreviewController({
    transport: {
      initialize: async () => {},
      seekFrame: async (requested) => {
        if (requested !== 1) return requested;
        seeking.resolve();
        return frame.promise;
      },
      dispose: async () => {},
    },
    prepareAudio: async () => clock,
    scheduler: {
      now: () => fake.context.currentTime * 1000,
      schedule(callback) {
        tick = callback;
        return () => {
          tick = undefined;
        };
      },
    },
  });
  await controller.refresh({
    session: { sessionId: "session", sourceVersion: "version" },
    composition: {
      id: "scene",
      width: 320,
      height: 180,
      fps: 10,
      durationFrames: 10,
    },
    audioPlan: plan(),
  });
  await controller.setPlaybackRange({ start: 0, end: 3 });
  await controller.play();
  fake.context.currentTime = 100.125;
  const callback = tick!;
  tick = undefined;
  callback();
  await seeking.promise;
  expect(tick).toBeUndefined();

  fake.context.currentTime = 102;
  expect(fake.sources[0]!.start).toEqual([100.1, 0.2, 0.2]);
  expect(clock.currentSample()).toBe(14400);
  const disposal = controller.dispose();
  frame.resolve(1);
  await disposal;
});

it("keeps envelope prefix timing and starts seeks at their interpolated gain", async () => {
  const fake = device();
  fake.context.sampleRate = 10;
  const clock = await prepareWebAudioClock(
    {
      sampleRate: 10,
      durationSamples: 20,
      clips: [
        {
          source: "voice.wav",
          startSample: 2,
          sourceStartSample: 0,
          durationSamples: 15,
          gain: 0.5,
          volumeEnvelope: [
            { sample: 3, gain: 0.2 },
            { sample: 6, gain: 1 },
            { sample: 10, gain: 1 },
            { sample: 12, gain: 0.5 },
          ],
        },
      ],
    },
    {
      ...fake.options,
      loadBuffer: async () => buffer(50, 10),
    },
  );
  await clock.play();
  expect(fake.automation[0]).toEqual([
    { method: "set", value: 0.1, time: 100.2 },
    { method: "ramp", value: 0.1, time: 100.2 + 0.3 },
    { method: "ramp", value: 0.5, time: 100.2 + 0.6 },
    { method: "ramp", value: 0.5, time: 100.2 + 1 },
    { method: "ramp", value: 0.25, time: 100.2 + 1.2 },
  ]);
  clock.seek(6);
  expect(fake.automation[1]).toEqual([
    { method: "set", value: 0.5 * (0.2 + 0.8 / 3), time: 100 },
    { method: "ramp", value: 0.5, time: 100.2 },
    { method: "ramp", value: 0.5, time: 100.6 },
    { method: "ramp", value: 0.25, time: 100.8 },
  ]);
  clock.seek(15);
  expect(fake.automation[2]).toEqual([
    { method: "set", value: 0.25, time: 100 },
  ]);
  await clock.dispose();
});

it("reuses decoded source PCM, allows sums above one, and pads missing source tails with silence", async () => {
  const fake = device();
  let loads = 0;
  const input = plan();
  input.clips.push({ ...input.clips[0]!, gain: 2 });
  const clock = await prepareWebAudioClock(input, {
    ...fake.options,
    loadBuffer: async () => {
      loads++;
      return buffer(12000);
    },
  });
  await clock.play();
  expect(loads).toBe(1);
  expect(fake.sources).toHaveLength(2);
  expect(fake.sources.map((source) => source.start[2])).toEqual([0.05, 0.05]);
  expect(fake.sources.map((source) => source.gain)).toEqual([0.5, 2]);
  clock.seek(24000);
  expect(fake.sources).toHaveLength(2);
  fake.context.currentTime = 100.25;
  expect(clock.currentSample()).toBe(36000);
  await clock.dispose();
});

it("pause invalidates pending resume so late completion cannot start old audio", async () => {
  const fake = device();
  const resumed = deferred<void>();
  fake.resumeWith(() => resumed.promise);
  const clock = await prepareWebAudioClock(plan(), fake.options);
  const pending = clock.play(12000);
  clock.pause();
  resumed.resolve();
  await expect(pending).rejects.toThrow("preview.audio_cancelled");
  expect(fake.sources).toHaveLength(0);
  expect(clock.currentSample()).toBe(12000);
  await clock.dispose();
});

it("dispose invalidates pending resume and closes the owned context once", async () => {
  const fake = device();
  const resumed = deferred<void>();
  fake.resumeWith(() => resumed.promise);
  const clock = await prepareWebAudioClock(plan(), fake.options);
  const pending = clock.play();
  await clock.dispose();
  resumed.resolve();
  await expect(pending).rejects.toThrow("preview.audio_closed");
  expect(fake.sources).toHaveLength(0);
  expect(fake.closes()).toBe(1);
});

it("rejects invalid boundaries without disturbing playback and reports blocked resume", async () => {
  const fake = device();
  const clock = await prepareWebAudioClock(plan(), fake.options);
  expect(() => clock.seek(-1)).toThrow("preview.audio_position");
  expect(() => clock.seek(48001)).toThrow("preview.audio_position");
  expect(() => clock.seek(0.5)).toThrow("preview.audio_position");
  fake.context.state = "suspended";
  await expect(clock.play()).rejects.toThrow("preview.audio_suspended");
  expect(fake.sources).toHaveLength(0);
  await clock.dispose();
});

it("cleans up preparation failures and bounds retained decoded buffers", async () => {
  const fake = device();
  await expect(
    prepareWebAudioClock(plan(), { ...fake.options, maxDecodedBytes: 100 }),
  ).rejects.toThrow("preview.audio_limit");
  expect(fake.closes()).toBe(1);
  const mismatch = device();
  await expect(
    prepareWebAudioClock(plan(), {
      ...mismatch.options,
      loadBuffer: async () => buffer(10, 44100),
    }),
  ).rejects.toThrow("preview.audio_format");
  expect(mismatch.closes()).toBe(1);
});

it("joins unabortable decode before closing and never returns cancelled prepared buffers", async () => {
  const fake = device();
  const decoded = deferred<AudioBuffer>();
  const abort = new AbortController();
  let signal: AbortSignal | undefined;
  const prepared = prepareWebAudioClock(plan(), {
    ...fake.options,
    signal: abort.signal,
    loadBuffer: async (_source, _context, inner) => {
      signal = inner;
      return decoded.promise;
    },
  });
  abort.abort(new Error("source replaced"));
  expect(signal?.aborted).toBe(true);
  expect(fake.closes()).toBe(0);
  decoded.resolve(buffer());
  await expect(prepared).rejects.toThrow("source replaced");
  expect(fake.closes()).toBe(1);
});

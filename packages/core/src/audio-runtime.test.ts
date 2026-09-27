import { expect, it } from "vitest";
import { VelocastRuntime } from "./runtime.js";

const options = { width: 320, height: 180, fps: 30, target: "body" };
const plan = () => ({
  sampleRate: 48000,
  durationSamples: 48000,
  clips: [
    {
      source: "song.wav",
      startSample: 0,
      sourceStartSample: 120,
      durationSamples: 1000,
      gain: 0.5,
    },
  ],
});

it("resolves audio after init with retained props and snapshots returned bytes", async () => {
  const runtime = new VelocastRuntime();
  const calls: unknown[] = [];
  const authored = plan();
  const protocol = runtime.registerFrameAdapter(
    "scene",
    {
      id: "audio",
      getDurationFrames: () => 30,
      init: () => {
        calls.push("init");
      },
      seekFrame: () => {},
      getAudioPlan(context) {
        calls.push(context.inputProps);
        return authored;
      },
    },
    options,
  );
  await protocol.setInputProps({ source: "one" });
  const result = await protocol.getAudioPlan!("scene");
  expect(calls).toEqual(["init", { source: "one" }]);
  expect(result).toEqual(authored);
  authored.clips[0]!.gain = 2;
  expect(result!.clips[0]!.gain).toBe(0.5);
  expect(Object.isFrozen(result!.clips[0])).toBe(true);
  await protocol.seekFrame("scene", 1);
  expect(calls).toHaveLength(2);
  await protocol.destroy();
});

it("rejects stale audio identity before init and supports a silent adapter", async () => {
  const runtime = new VelocastRuntime();
  let initialized = false;
  const protocol = runtime.registerFrameAdapter(
    "scene",
    {
      id: "silent",
      getDurationFrames: () => 30,
      seekFrame: () => {},
      init: () => {
        initialized = true;
      },
    },
    options,
  );
  await protocol.beginSession({ sessionId: "one", sourceVersion: "a" });
  await expect(protocol.getAudioPlan!("scene")).rejects.toThrow(
    "VELOCAST_SESSION_MISMATCH",
  );
  expect(initialized).toBe(false);
  await expect(
    protocol.getAudioPlan!("scene", {
      ...options,
      compositionId: "scene",
      durationFrames: 30,
      renderSession: protocol.getSession(),
    }),
  ).resolves.toBeNull();
  await protocol.destroy();
});

it("cancels pending audio without publishing a late plan or overlapping teardown", async () => {
  const runtime = new VelocastRuntime();
  let finish!: (value: ReturnType<typeof plan>) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let signal: AbortSignal | undefined;
  let destroyed = false;
  const protocol = runtime.registerFrameAdapter(
    "scene",
    {
      id: "audio",
      getDurationFrames: () => 30,
      seekFrame: () => {},
      getAudioPlan(context) {
        signal = context.signal;
        entered();
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      destroy: () => {
        destroyed = true;
      },
    },
    options,
  );
  const pending = protocol.getAudioPlan!("scene");
  await started;
  await expect(protocol.getAudioPlan!("scene")).rejects.toThrow(
    "VELOCAST_RUNTIME_BUSY",
  );
  protocol.cancelPending();
  await expect(pending).rejects.toThrow("VELOCAST_REQUEST_CANCELLED");
  expect(signal?.aborted).toBe(true);
  const cleanup = protocol.destroy();
  expect(destroyed).toBe(false);
  finish(plan());
  await cleanup;
  expect(destroyed).toBe(true);
});

it("rejects invalid audio plans with a stable cause before native handoff", async () => {
  const runtime = new VelocastRuntime();
  const protocol = runtime.registerFrameAdapter(
    "scene",
    {
      id: "invalid",
      getDurationFrames: () => 30,
      seekFrame: () => {},
      getAudioPlan: () => ({ ...plan(), sampleRate: 0 }),
    },
    options,
  );
  await expect(protocol.getAudioPlan!("scene")).rejects.toThrow(
    /VELOCAST_AUDIO_PLAN_FAILED.*sampleRate/,
  );
  await protocol.destroy();
});

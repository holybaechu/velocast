import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { expect, it } from "vitest";
import {
  createSequentialVideoDecoder,
  videoPixelChecksum,
  type DecoderToolEvent,
} from "./video-frame-decoder.js";
import { buildVideoPtsIndex } from "./video-pts.js";

const metadata = buildVideoPtsIndex({
  streams: [
    {
      codec_name: "vp8",
      width: 2,
      height: 2,
      pix_fmt: "yuv420p",
      time_base: "1/1000",
    },
  ],
  frames: [
    {
      pts: 0,
      best_effort_timestamp: 0,
      key_frame: 1,
      duration: 40,
    },
  ],
});

interface FakeChild extends ChildProcess {
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  Object.assign(child, {
    stdout: new PassThrough({ highWaterMark: 1 }),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill(signal: NodeJS.Signals = "SIGTERM") {
      if (child.exitCode !== null || child.signalCode !== null) return false;
      child.signalCode = signal;
      queueMicrotask(() => child.emit("close", null, signal));
      return true;
    },
  });
  return child;
}

function oracle(pixels: Uint8Array): string {
  return `[showinfo@velocast_pts @ fixture] n: 0 pts: 0 pts_time:0 fmt:rgba s:2x2 checksum:${videoPixelChecksum(pixels)}\n`;
}

function decoder(
  launch: () => ChildProcess,
  timeoutMs: number,
  events: DecoderToolEvent[] = [],
) {
  const owner = new AbortController();
  return {
    owner,
    value: createSequentialVideoDecoder({
      binary: "fake-decoder",
      metadata,
      maxDecodeFrames: 10,
      maxLogBytes: 4096,
      timeoutMs,
      signal: owner.signal,
      args: () => ["rawvideo"],
      spawn: launch,
      onCommand: (event) => events.push(event),
    }),
  };
}

it("waits for close and accepts an oracle delivered after process exit", async () => {
  const pixels = Buffer.alloc(metadata.frameBytes, 17),
    events: DecoderToolEvent[] = [],
    d = decoder(
      () => {
        const child = fakeChild();
        queueMicrotask(() => {
          child.stdout.end(pixels);
          child.exitCode = 0;
          child.emit("exit", 0, null);
          setTimeout(() => {
            child.stderr.end(oracle(pixels));
            setTimeout(() => child.emit("close", 0, null), 0);
          }, 5);
        });
        return child;
      },
      1000,
      events,
    );
  expect(await d.value.decode(0, d.owner.signal)).toEqual(pixels);
  await d.value.close();
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ exitStatus: 0, terminated: false });
  expect(events[0]!.stderr).toContain("checksum:");
});

it("uses one cumulative deadline across a slow-trickling frame", async () => {
  const pixels = Buffer.alloc(metadata.frameBytes, 23),
    d = decoder(() => {
      const child = fakeChild();
      queueMicrotask(() => {
        child.stderr.write(oracle(pixels));
        for (let index = 0; index < 4; index++)
          setTimeout(() => {
            if (child.signalCode === null)
              child.stdout.write(pixels.subarray(index * 4, index * 4 + 4));
          }, index * 15);
      });
      return child;
    }, 25);
  await expect(d.value.decode(0, d.owner.signal)).rejects.toThrow(
    "video.process_timeout",
  );
  await d.value.close();
});

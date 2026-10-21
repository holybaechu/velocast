import { expect, it } from "vitest";
import {
  acquireMediaProcess,
  maximumLiveMediaProcesses,
  videoPixelChecksum,
} from "./video-frame-decoder.js";
it("bounds concurrent work and removes cancelled FIFO waiters", async () => {
  const signal = new AbortController().signal;
  const slots = await Promise.all(
    Array.from({ length: maximumLiveMediaProcesses }, () =>
      acquireMediaProcess(signal),
    ),
  );
  const owner = new AbortController();
  const cancelled = acquireMediaProcess(owner.signal);
  const rejection = expect(cancelled).rejects.toThrow();
  owner.abort();
  await rejection;
  let acquired = false;
  const next = acquireMediaProcess(signal).then((release) => {
    acquired = true;
    return release;
  });
  await Promise.resolve();
  expect(acquired).toBe(false);
  slots.pop()!();
  (await next)();
  for (const release of slots) release();
});
it("computes the packed plane checksum", () => {
  expect(videoPixelChecksum(new Uint8Array([1, 2, 3]))).toBe("000A0006");
});

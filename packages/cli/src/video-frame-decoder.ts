export const maximumLiveMediaProcesses = 8;
let active = 0;
const waiting: Array<() => void> = [];
const idle = new Map<symbol, () => void>();
function evictIdle(): void {
  const entry = idle.entries().next().value;
  if (entry) {
    idle.delete(entry[0]);
    entry[1]();
  }
}
export function markMediaProcessActive(id: symbol): void {
  idle.delete(id);
}
export function markMediaProcessIdle(id: symbol, close: () => void): void {
  idle.set(id, close);
  if (waiting.length) evictIdle();
}

/** Shared bounded admission for Electron media utility processes. */
export async function acquireMediaProcess(
  signal: AbortSignal,
): Promise<() => void> {
  signal.throwIfAborted();
  if (active >= maximumLiveMediaProcesses)
    await new Promise<void>((resolve, reject) => {
      const ready = () => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        const index = waiting.indexOf(ready);
        if (index >= 0) waiting.splice(index, 1);
        reject(signal.reason);
      };
      waiting.push(ready);
      signal.addEventListener("abort", abort, { once: true });
      evictIdle();
    });
  else active++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = waiting.shift();
    if (next) next();
    else active--;
  };
}
export function videoPixelChecksum(pixels: Uint8Array): string {
  let a = 0,
    b = 0;
  for (let start = 0; start < pixels.length; start += 5552) {
    const end = Math.min(pixels.length, start + 5552);
    for (let index = start; index < end; index++) {
      a += pixels[index]!;
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return (((b << 16) | a) >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

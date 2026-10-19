interface PendingHandle {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
  failed: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

let nextHandle = 0;
const pending = new Map<number, PendingHandle>();

export function hasPendingDelayHandles(): boolean {
  return pending.size > 0;
}

export function delayHandleRevision(): number {
  return nextHandle;
}

export function delayRender(
  label = "delayRender()",
  options: { timeoutInMilliseconds?: number; retries?: number } = {},
): number {
  if (options.retries !== undefined)
    throw new Error(
      "VELOCAST_REMOTION_UNSUPPORTED: delayRender.retries is not supported by this Remotion 4.0.244 bridge slice",
    );
  const timeout = options.timeoutInMilliseconds ?? 30_000;
  if (!Number.isFinite(timeout) || timeout <= 0)
    throw new RangeError(
      "VELOCAST_REMOTION_DELAY_INVALID: timeoutInMilliseconds must be positive",
    );
  const handle = ++nextHandle;
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  // A handle can be created at module evaluation before the host registers its
  // preload waiter. Preserve the rejection for that waiter without an early
  // unhandled-rejection report.
  void promise.catch(() => {});
  const record: PendingHandle = {
    promise,
    resolve,
    reject,
    failed: false,
  };
  record.timer = setTimeout(() => {
    record.failed = true;
    reject(new Error(`VELOCAST_REMOTION_DELAY_TIMEOUT: ${label}`));
  }, timeout);
  pending.set(handle, record);
  return handle;
}

export function continueRender(handle: number): void {
  const record = pending.get(handle);
  if (!record || record.failed)
    throw new Error(
      `VELOCAST_REMOTION_DELAY_UNKNOWN: no pending handle ${handle}`,
    );
  pending.delete(handle);
  clearTimeout(record.timer);
  record.resolve();
}

export function cancelRender(error: unknown): void {
  const reason = error instanceof Error ? error : new Error(String(error));
  if (!pending.size) throw reason;
  for (const record of pending.values()) {
    clearTimeout(record.timer);
    record.failed = true;
    record.reject(reason);
  }
}

export async function waitForDelayHandles(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  while (pending.size) {
    const handles = [...pending.entries()];
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          cleanup();
          reject(signal.reason);
        };
        const cleanup = () => signal.removeEventListener("abort", abort);
        signal.addEventListener("abort", abort, { once: true });
        Promise.all(handles.map(([, record]) => record.promise)).then(
          () => {
            cleanup();
            resolve();
          },
          (error: unknown) => {
            cleanup();
            reject(error);
          },
        );
      });
    } catch (error) {
      // A failure can precede the first preload waiter. Keep it until observed,
      // then release it so a later independent render does not inherit it.
      if (!signal.aborted)
        for (const [handle, record] of handles)
          if (record.failed) pending.delete(handle);
      throw error;
    }
    signal.throwIfAborted();
  }
}

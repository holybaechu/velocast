export function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

export function abortable<T>(
  work: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    // The browser load may still reject after cancellation; always observe it.
    void work.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/** Decode a props-dependent image before committing the composition's layout. */
export async function preloadImage(
  source: string,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  throwIfAborted(options.signal);
  const image = new Image();
  try {
    image.src = source;
    if (typeof image.decode !== "function")
      throw new Error("HTMLImageElement.decode() is required");
    await abortable(image.decode(), options.signal);
    throwIfAborted(options.signal);
  } catch (cause) {
    throwIfAborted(options.signal);
    throw new Error(
      "VELOCAST_REACT_IMAGE_DECODE_FAILED: preload image could not be decoded",
      { cause },
    );
  } finally {
    image.removeAttribute("src");
  }
}

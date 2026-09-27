import { createContext, useContext, useLayoutEffect, useRef } from "react";

export type FrameResourceLoader = (signal: AbortSignal) => Promise<void> | void;

/** One committed React frame owns one group; no global resource queue or cache. */
export class FrameResourceScope {
  private readonly controller = new AbortController();
  private readonly loaders = new Map<object, FrameResourceLoader>();
  private pending: Promise<void> | undefined;
  private sealed = false;
  private readonly abort = () => this.controller.abort(this.parent.reason);
  constructor(private readonly parent: AbortSignal) {
    parent.addEventListener("abort", this.abort, { once: true });
    if (parent.aborted) this.abort();
  }
  register(key: object, load: FrameResourceLoader): void {
    if (this.sealed)
      throw new Error(
        "VELOCAST_REACT_RESOURCE_LATE: frame resources must be declared during the frame commit, not an asynchronous React update",
      );
    this.loaders.set(key, load);
  }
  unregister(key: object): void {
    if (!this.sealed) this.loaders.delete(key);
  }
  cancel(reason: unknown): void {
    this.controller.abort(reason);
  }
  wait(): Promise<void> {
    if (this.pending) return this.pending;
    this.sealed = true;
    const signal = this.controller.signal;
    this.pending = (async () => {
      try {
        // Failure cancels peers, but all started jobs still join before unmount/reuse.
        await Promise.all(
          [...this.loaders.values()].map(async (load) => {
            try {
              signal.throwIfAborted();
              await load(signal);
              signal.throwIfAborted();
            } catch (error) {
              if (!signal.aborted) this.controller.abort(error);
            }
          }),
        );
        signal.throwIfAborted();
      } finally {
        this.loaders.clear();
        this.parent.removeEventListener("abort", this.abort);
      }
    })();
    return this.pending;
  }
}

export const FrameResourceContext = createContext<FrameResourceScope | null>(
  null,
);

/**
 * Prepare imperative per-frame media (for example canvas pixels) after React
 * commits and before capture. Honor the signal before every asynchronous paint.
 * The callback must not schedule another asynchronous React render; preload
 * React state/data with composition options.preload instead.
 */
export function useFrameResource(load: FrameResourceLoader): void {
  const scope = useContext(FrameResourceContext);
  const key = useRef({});
  if (!scope)
    throw new Error(
      "VELOCAST_REACT_CONTEXT_MISSING: frame resources require a registered React composition",
    );
  useLayoutEffect(() => {
    scope.register(key.current, load);
    const token = key.current;
    return () => scope.unregister(token);
  }, [scope, load]);
}

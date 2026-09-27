import {
  createContext,
  useContext,
  useLayoutEffect,
  useSyncExternalStore,
  type ComponentType,
} from "react";
import { resolveSequenceFrame, type SequenceTiming } from "@velocast/core";

export interface VideoConfig {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly durationFrames: number;
}

export interface FrameSnapshot {
  readonly revision: number;
  readonly frame: number;
  readonly inputProps: Readonly<object>;
  readonly config: VideoConfig;
}

export class FrameStore {
  private readonly listeners = new Set<() => void>();
  constructor(private snapshot: FrameSnapshot) {}
  read = (): FrameSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  update(snapshot: FrameSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
  clear(): void {
    this.listeners.clear();
  }
}

const FrameContext = createContext<FrameStore | null>(null);
const noSequences: readonly SequenceTiming[] = Object.freeze([]);
export const SequenceContext = createContext(noSequences);

export function useFrameSnapshot(): FrameSnapshot {
  const store = useContext(FrameContext);
  if (!store)
    throw new Error(
      "VELOCAST_REACT_CONTEXT_MISSING: render inside a registered React composition",
    );
  return useSyncExternalStore(store.subscribe, store.read, store.read);
}

export function useCurrentFrame(): number {
  const snapshot = useFrameSnapshot();
  const sequences = useContext(SequenceContext);
  return resolveSequenceFrame(snapshot.frame, sequences).localFrame;
}
export function useVideoConfig(): VideoConfig {
  return useFrameSnapshot().config;
}
export function useInputProps<Props extends object>(): Readonly<Props> {
  return useFrameSnapshot().inputProps as Readonly<Props>;
}

export function FrameView<Props extends object>({
  store,
  component: Composition,
  onCommit,
}: {
  store: FrameStore;
  component: ComponentType<Props>;
  onCommit: (revision: number) => void;
}) {
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.read,
    store.read,
  );
  useLayoutEffect(() => {
    onCommit(snapshot.revision);
  }, [onCommit, snapshot.revision]);
  return (
    <FrameContext.Provider value={store}>
      <Composition {...(snapshot.inputProps as Props)} />
    </FrameContext.Provider>
  );
}

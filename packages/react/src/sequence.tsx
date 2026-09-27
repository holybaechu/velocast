import { useContext, useMemo, type ReactNode } from "react";
import { resolveSequenceFrame, type SequenceTiming } from "@velocast/core";
import { SequenceContext, useFrameSnapshot } from "./frame-state.js";

export interface SequenceProps {
  /** Start relative to the parent sequence's local frame; defaults to zero. */
  readonly from?: number;
  /** Half-open visibility interval. Zero is an empty sequence. */
  readonly durationFrames: number;
  readonly children?: ReactNode;
}

/** Frame-relative scope without an extra DOM wrapper or playback history. */
export function Sequence({
  from = 0,
  durationFrames,
  children,
}: SequenceProps) {
  const snapshot = useFrameSnapshot();
  const ancestors = useContext(SequenceContext);
  const scope = useMemo<readonly SequenceTiming[]>(
    () => [...ancestors, { from, durationFrames }],
    [ancestors, from, durationFrames],
  );
  const resolved = resolveSequenceFrame(snapshot.frame, [
    { from: 0, durationFrames: snapshot.config.durationFrames },
    ...scope,
  ]);
  if (!resolved.isActive) return null;
  return (
    <SequenceContext.Provider value={scope}>
      {children}
    </SequenceContext.Provider>
  );
}

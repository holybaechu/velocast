import {
  Children,
  Fragment,
  createContext,
  isValidElement,
  useContext,
  type CSSProperties,
  type ReactNode,
  type ReactElement,
} from "react";
import { Sequence, useCurrentFrame, useVideoConfig } from "./remotion.js";

interface LayoutProps {
  readonly layout?: "absolute-fill" | "none";
  readonly style?: CSSProperties;
  readonly className?: string;
  /** Timeline label only; it has no rendered effect. */
  readonly name?: string;
}
export interface SeriesSequenceProps extends LayoutProps {
  readonly durationInFrames: number;
  readonly offset?: number;
  readonly children?: ReactNode;
}
function SeriesSequence(props: SeriesSequenceProps): never {
  void props;
  throw new Error(
    "VELOCAST_REMOTION_SERIES_CHILD: Series.Sequence must be a direct child of Series (fragments are allowed)",
  );
}
function integer(value: number, name: string, positive = false) {
  if (!Number.isSafeInteger(value) || (positive && value <= 0))
    throw new RangeError(
      `VELOCAST_REMOTION_TIMING: ${name} must be a ${positive ? "positive " : ""}safe integer`,
    );
  return value;
}
function flattened(children: ReactNode): ReactNode[] {
  const result: ReactNode[] = [];
  Children.forEach(children, (child) => {
    if (
      isValidElement<{ children?: ReactNode }>(child) &&
      child.type === Fragment
    )
      result.push(...flattened(child.props.children));
    else if (
      child !== null &&
      child !== undefined &&
      typeof child !== "boolean" &&
      !(typeof child === "string" && !child.trim())
    )
      result.push(child);
  });
  return result;
}
/** Integer contiguous placement, with explicit offset gaps/overlap and optional final Infinity. */
export const Series = Object.assign(
  function Series({ children, ...rest }: { readonly children?: ReactNode }) {
    const config = useVideoConfig();
    for (const key of Object.keys(rest))
      throw new Error(`VELOCAST_REMOTION_UNSUPPORTED: Series.${key}`);
    let cursor = 0;
    const childrenList = flattened(children);
    return (
      <>
        {childrenList.map((child, index) => {
          if (
            !isValidElement<SeriesSequenceProps>(child) ||
            child.type !== SeriesSequence
          )
            throw new Error(
              "VELOCAST_REMOTION_SERIES_CHILD: Series only accepts Series.Sequence children",
            );
          const {
            durationInFrames,
            offset = 0,
            children: content,
            name,
            ...layout
          } = child.props;
          void name;
          for (const key of Object.keys(layout))
            if (!["layout", "style", "className"].includes(key))
              throw new Error(
                `VELOCAST_REMOTION_UNSUPPORTED: Series.Sequence.${key}`,
              );
          if (content === undefined || content === null)
            throw new Error(
              "VELOCAST_REMOTION_SERIES_CHILD: Series.Sequence needs children",
            );
          integer(offset, "Series.Sequence.offset");
          const from = integer(cursor + offset, "Series.Sequence start");
          const duration =
            durationInFrames === Infinity && index === childrenList.length - 1
              ? Math.max(0, config.durationInFrames - from)
              : integer(
                  durationInFrames,
                  "Series.Sequence.durationInFrames",
                  true,
                );
          cursor = integer(from + duration, "Series end");
          return (
            <Sequence
              key={`${index}:${(child as ReactElement).key ?? ""}`}
              from={from}
              durationInFrames={duration}
              {...layout}
            >
              {content}
            </Sequence>
          );
        })}
      </>
    );
  },
  { Sequence: SeriesSequence },
);

export interface LoopProps extends LayoutProps {
  readonly durationInFrames: number;
  readonly times?: number;
  readonly children?: ReactNode;
}
interface LoopValue {
  readonly iteration: number;
  readonly durationInFrames: number;
}
const LoopContext = createContext<LoopValue | null>(null);
/** Only the active iteration mounts, so arbitrary seeks do not replay prior iterations. */
export const Loop = Object.assign(
  function Loop({
    durationInFrames,
    times = Infinity,
    children,
    name,
    ...layout
  }: LoopProps) {
    const frame = useCurrentFrame();
    const config = useVideoConfig();
    void name;
    integer(durationInFrames, "Loop.durationInFrames", true);
    if (times !== Infinity && (!Number.isSafeInteger(times) || times < 0))
      throw new RangeError(
        "VELOCAST_REMOTION_TIMING: Loop.times must be a nonnegative safe integer or Infinity",
      );
    for (const key of Object.keys(layout))
      if (!["layout", "style", "className"].includes(key))
        throw new Error(`VELOCAST_REMOTION_UNSUPPORTED: Loop.${key}`);
    const iteration = Math.floor(frame / durationInFrames);
    const actualTimes = Math.min(
      times,
      Math.ceil(config.durationInFrames / durationInFrames),
    );
    if (iteration < 0 || iteration >= actualTimes) return null;
    const from = integer(iteration * durationInFrames, "Loop iteration start");
    return (
      <LoopContext.Provider value={{ iteration, durationInFrames }}>
        <Sequence from={from} durationInFrames={durationInFrames} {...layout}>
          {children}
        </Sequence>
      </LoopContext.Provider>
    );
  },
  { useLoop: () => useContext(LoopContext) },
);

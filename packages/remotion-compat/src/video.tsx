import type { CSSProperties } from "react";
import { VideoClip } from "@velocast/react";
import { Audio, resolveTrims } from "./audio.js";
import { useCompatibilityContext } from "./context.js";

export interface RemotionVideoProps {
  readonly src: string;
  readonly startFrom?: number;
  readonly endAt?: number;
  readonly trimBefore?: number;
  readonly trimAfter?: number;
  readonly muted?: boolean;
  readonly volume?: number | ((frame: number) => number);
  readonly style?: CSSProperties;
  readonly className?: string;
}
/** Both entry points use the host's deterministic RGBA preparation and shared audio plan. */
export function Video(props: RemotionVideoProps) {
  useCompatibilityContext();
  const {
    src,
    startFrom,
    endAt,
    trimBefore,
    trimAfter,
    muted,
    volume,
    style,
    className,
    ...rest
  } = props;
  for (const [name, value] of Object.entries(rest))
    if (value !== undefined)
      throw new Error(
        `VELOCAST_REMOTION_UNSUPPORTED: Video.${name} is not supported; supported props are src, trims, muted, volume, style and className`,
      );
  const trims = resolveTrims({ startFrom, endAt, trimBefore, trimAfter });
  return (
    <>
      <VideoClip
        src={src}
        muted
        trimBeforeFrames={trims.startFrom}
        trimAfterFrames={trims.endAt}
        style={style}
        className={className}
      />
      {!muted && (
        <Audio
          src={src}
          startFrom={trims.startFrom}
          endAt={trims.endAt}
          volume={volume}
        />
      )}
    </>
  );
}
export const OffthreadVideo = Video;
export const Html5Video = Video;

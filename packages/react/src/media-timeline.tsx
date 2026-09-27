import { useContext, type CSSProperties } from "react";
import {
  framesToSamples,
  fadeAudioEnvelope,
  validateAudioPlan,
  type AudioEnvelopePoint,
} from "@velocast/core";
import { Sequence } from "./sequence.js";
import {
  VideoClip,
  VideoFrameProvider,
  type VideoFrameLoader,
} from "./video-clip.js";
import { requestSnapshotVideoFrame } from "./snapshot-video-frame.js";
import {
  SequenceContext,
  useVideoConfig,
  type VideoConfig,
} from "./frame-state.js";

export interface MediaClip {
  readonly id: string;
  readonly kind: "video" | "audio";
  readonly src: string;
  readonly from?: number;
  readonly durationFrames: number;
  readonly trimBeforeFrames?: number;
  readonly muted?: boolean;
  readonly gain?: number;
  readonly fadeInFrames?: number;
  readonly fadeOutFrames?: number;
  /** Clip-local sample points; use these for ducking and other automation. */
  readonly volumeEnvelope?: readonly AudioEnvelopePoint[];
  readonly style?: CSSProperties;
  readonly className?: string;
}

/** Declare source/timing once; the same immutable snapshot drives video and sound. */
export function createMediaTimeline(
  config: VideoConfig,
  clips: readonly MediaClip[],
  sampleRate = 48000,
) {
  config = Object.freeze({ ...config });
  const ids = new Set<string>();
  const snapshot = clips.map((clip) => {
    if (!clip.id || ids.has(clip.id))
      throw new Error(
        "VELOCAST_MEDIA_ID: clip ids must be nonempty and unique",
      );
    ids.add(clip.id);
    if (clip.kind !== "video" && clip.kind !== "audio")
      throw new Error("VELOCAST_MEDIA_KIND: expected video or audio");
    for (const [key, value] of Object.entries({
      from: clip.from ?? 0,
      durationFrames: clip.durationFrames,
      trimBeforeFrames: clip.trimBeforeFrames ?? 0,
      fadeInFrames: clip.fadeInFrames ?? 0,
      fadeOutFrames: clip.fadeOutFrames ?? 0,
    }))
      if (!Number.isSafeInteger(value) || (key !== "from" && value < 0))
        throw new RangeError(
          `VELOCAST_MEDIA_TIMING: ${key} must be a ${key === "from" ? "" : "nonnegative "}safe integer`,
        );
    if (clip.volumeEnvelope && (clip.fadeInFrames || clip.fadeOutFrames))
      throw new Error(
        "VELOCAST_MEDIA_VOLUME: use either an envelope or fade durations",
      );
    return Object.freeze({
      ...clip,
      style: clip.style ? Object.freeze({ ...clip.style }) : undefined,
    });
  });
  const audio = validateAudioPlan({
    sampleRate,
    durationSamples: framesToSamples(
      config.durationFrames,
      config.fps,
      sampleRate,
      "round",
    ),
    clips: snapshot.map((clip) => {
      const from = clip.from ?? 0;
      const startSample = framesToSamples(
        from,
        config.fps,
        sampleRate,
        "round",
      );
      const durationSamples =
        framesToSamples(
          from + clip.durationFrames,
          config.fps,
          sampleRate,
          "round",
        ) - startSample;
      return {
        source: clip.src,
        startSample,
        durationSamples,
        sourceStartSample: framesToSamples(
          clip.trimBeforeFrames ?? 0,
          config.fps,
          sampleRate,
          "round",
        ),
        gain: clip.muted ? 0 : (clip.gain ?? 1),
        volumeEnvelope:
          clip.volumeEnvelope ??
          fadeAudioEnvelope(
            durationSamples,
            framesToSamples(
              from + (clip.fadeInFrames ?? 0),
              config.fps,
              sampleRate,
              "round",
            ) - startSample,
            framesToSamples(
              from + clip.durationFrames,
              config.fps,
              sampleRate,
              "round",
            ) -
              framesToSamples(
                from + clip.durationFrames - (clip.fadeOutFrames ?? 0),
                config.fps,
                sampleRate,
                "round",
              ),
          ),
      };
    }),
  });
  function Timeline({
    getFrame = requestSnapshotVideoFrame,
  }: {
    readonly getFrame?: VideoFrameLoader;
  }) {
    const actual = useVideoConfig();
    const scope = useContext(SequenceContext);
    if (scope.length)
      throw new Error(
        "VELOCAST_MEDIA_SCOPE: render Timeline at composition scope; put clip offsets and durations in its media declarations",
      );
    if (
      actual.fps !== config.fps ||
      actual.durationFrames !== config.durationFrames ||
      actual.width !== config.width ||
      actual.height !== config.height
    )
      throw new Error(
        "VELOCAST_MEDIA_CONFIG: register Timeline with the same composition configuration used to create its audio plan",
      );
    return (
      <VideoFrameProvider getFrame={getFrame}>
        {snapshot
          .filter((clip) => clip.kind === "video")
          .map((clip) => (
            <Sequence
              key={clip.id}
              from={clip.from ?? 0}
              durationFrames={clip.durationFrames}
            >
              <VideoClip
                src={clip.src}
                muted
                trimBeforeFrames={clip.trimBeforeFrames}
                className={clip.className}
                style={clip.style}
              />
            </Sequence>
          ))}
      </VideoFrameProvider>
    );
  }
  return Object.freeze({ audio, Timeline });
}

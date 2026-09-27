import { useCallback, useLayoutEffect, useRef, type ReactNode } from "react";
import {
  framesToSamples,
  evaluateAudioEnvelope,
  validateAudioPlan,
  type AudioClip,
  type AudioPlan,
  type SequenceTiming,
} from "@velocast/core";
import {
  useFrameResource,
  type ReactAudioContext,
  type VideoConfig,
} from "@velocast/react";
import type { ComponentProps } from "react";
import type { Audio as PinnedAudio } from "remotion-pinned";
import { useCompatibilityContext, useRemotionSequences } from "./context.js";

export interface RemotionAudioTrack {
  /** Source string expected in the unchanged <Audio src> JSX. */
  readonly src: string;
  /** Native file/URL identity. Defaults to src. */
  readonly source?: string;
  readonly from?: number;
  readonly durationInFrames?: number;
  readonly startFrom?: number;
  readonly endAt?: number;
  readonly volume?: number | ((frame: number) => number);
  readonly trimBefore?: number;
  readonly trimAfter?: number;
}

export interface RemotionAudioDescriptor {
  readonly sampleRate: number;
  readonly tracks: readonly RemotionAudioTrack[];
}

export type RemotionAudioDeclaration = AudioPlan | RemotionAudioDescriptor;
export type RemotionAudioSource<Props extends object> =
  | RemotionAudioDeclaration
  | ((
      context: ReactAudioContext<Props>,
    ) =>
      | RemotionAudioDeclaration
      | null
      | Promise<RemotionAudioDeclaration | null>);

interface ResolvedTrack {
  readonly src: string;
  readonly clip: AudioClip;
}

export interface ResolvedAudioDeclaration {
  readonly plan: AudioPlan | null;
  readonly tracks: readonly ResolvedTrack[];
}

interface FrameValidation {
  readonly frame: number;
  readonly declaration: ResolvedAudioDeclaration;
  readonly mounted: Map<object, number>;
}

function integer(value: number, name: string, nonnegative = false): number {
  if (!Number.isSafeInteger(value) || (nonnegative && value < 0))
    throw new RangeError(
      `VELOCAST_REMOTION_AUDIO_INVALID: ${name} must be a ${nonnegative ? "nonnegative " : ""}safe integer`,
    );
  return value;
}

function finiteGain(value: number): number {
  if (!Number.isFinite(value) || value < 0)
    throw new RangeError(
      "VELOCAST_REMOTION_AUDIO_INVALID: volume must be finite and nonnegative",
    );
  return value === 0 ? 0 : value;
}

function sequenceWindow(
  sequences: readonly SequenceTiming[],
  durationFrames: number,
): { absoluteFrom: number; start: number; end: number } {
  let absoluteFrom = 0;
  let start = 0;
  let end = durationFrames;
  for (const sequence of sequences) {
    const from = integer(sequence.from, "sequence.from");
    const duration = integer(
      sequence.durationFrames,
      "sequence.durationFrames",
      true,
    );
    absoluteFrom = integer(absoluteFrom + from, "absolute sequence start");
    start = Math.max(start, absoluteFrom);
    end = Math.min(
      end,
      integer(absoluteFrom + duration, "absolute sequence end"),
    );
  }
  return { absoluteFrom, start, end: Math.max(start, end) };
}

function clipForTrack(
  track: RemotionAudioTrack,
  config: VideoConfig,
  sampleRate: number,
): AudioClip {
  if (typeof track.src !== "string" || !track.src)
    throw new TypeError(
      "VELOCAST_REMOTION_AUDIO_INVALID: track src must be a nonempty string",
    );
  const from = integer(track.from ?? 0, "track.from");
  const duration = integer(
    track.durationInFrames ?? Math.max(0, config.durationFrames - from),
    "track.durationInFrames",
    true,
  );
  const trims = resolveTrims(track);
  const startFrom = integer(trims.startFrom ?? 0, "track.startFrom", true);
  const endAt =
    trims.endAt === undefined
      ? undefined
      : integer(trims.endAt, "track.endAt", true);
  if (endAt !== undefined && endAt < startFrom)
    throw new RangeError(
      "VELOCAST_REMOTION_AUDIO_INVALID: endAt must be >= startFrom",
    );
  if (typeof track.volume === "function" && from < 0)
    throw new Error(
      "VELOCAST_REMOTION_AUDIO_NEGATIVE_VOLUME: callback tracks require nonnegative placement; use a sample envelope for preroll",
    );
  const window = sequenceWindow(
    [{ from, durationFrames: duration }],
    config.durationFrames,
  );
  const sourceStartFrame = startFrom + (window.start - window.absoluteFrom);
  let end = window.end;
  if (endAt !== undefined)
    end = Math.min(end, window.absoluteFrom + endAt - startFrom);
  end = Math.max(window.start, end);
  const startSample = framesToSamples(
    window.start,
    config.fps,
    sampleRate,
    "round",
  );
  const endSample = framesToSamples(end, config.fps, sampleRate, "round");
  return {
    source: track.source ?? track.src,
    startSample,
    sourceStartSample: framesToSamples(
      sourceStartFrame,
      config.fps,
      sampleRate,
      "round",
    ),
    durationSamples: endSample - startSample,
    gain:
      typeof track.volume === "function" ? 1 : finiteGain(track.volume ?? 1),
    ...(typeof track.volume === "function"
      ? {
          volumeEnvelope: volumeEnvelope(
            track.volume,
            window.start,
            end,
            window.absoluteFrom,
            config.fps,
            sampleRate,
          ),
        }
      : {}),
  };
}

function isAudioPlan(value: RemotionAudioDeclaration): value is AudioPlan {
  return "clips" in value;
}

export function resolveAudioDeclaration(
  declaration: RemotionAudioDeclaration | null,
  config: VideoConfig,
): ResolvedAudioDeclaration {
  if (declaration === null)
    return Object.freeze({ plan: null, tracks: Object.freeze([]) });
  if (isAudioPlan(declaration)) {
    const plan = validateAudioPlan(declaration);
    return Object.freeze({
      plan,
      tracks: Object.freeze(
        plan.clips.map((clip) => Object.freeze({ src: clip.source, clip })),
      ),
    });
  }
  integer(declaration.sampleRate, "sampleRate", true);
  if (declaration.sampleRate === 0)
    throw new RangeError(
      "VELOCAST_REMOTION_AUDIO_INVALID: sampleRate must be positive",
    );
  if (!Array.isArray(declaration.tracks))
    throw new TypeError(
      "VELOCAST_REMOTION_AUDIO_INVALID: tracks must be an array",
    );
  const tracks = declaration.tracks.map((track) =>
    Object.freeze({
      src: track.src,
      clip: Object.freeze(clipForTrack(track, config, declaration.sampleRate)),
    }),
  );
  const plan = validateAudioPlan({
    sampleRate: declaration.sampleRate,
    durationSamples: framesToSamples(
      config.durationFrames,
      config.fps,
      declaration.sampleRate,
      "round",
    ),
    clips: tracks.map((track) => track.clip),
  });
  return Object.freeze({ plan, tracks: Object.freeze(tracks) });
}

export class AudioDeclarationRuntime {
  private validation?: FrameValidation;

  prepare(frame: number, declaration: ResolvedAudioDeclaration): void {
    this.validation = { frame, declaration, mounted: new Map() };
  }

  current(): FrameValidation {
    if (!this.validation)
      throw new Error(
        "VELOCAST_REMOTION_AUDIO_NOT_PRELOADED: host declaration must resolve before JSX frame commit",
      );
    return this.validation;
  }

  mount(
    validation: FrameValidation,
    token: object,
    src: string,
    clip: Omit<AudioClip, "source">,
    frameGain?: number,
    fps = 60,
  ): void {
    if (validation !== this.current())
      throw new Error(
        "VELOCAST_REMOTION_AUDIO_STALE: mounted Audio belongs to a replaced frame declaration",
      );
    const previous = validation.mounted.get(token);
    if (previous !== undefined) return;
    const occupied = new Set(validation.mounted.values());
    const index = validation.declaration.tracks.findIndex(
      (track, candidate) =>
        !occupied.has(candidate) &&
        track.src === src &&
        track.clip.startSample === clip.startSample &&
        track.clip.sourceStartSample === clip.sourceStartSample &&
        track.clip.durationSamples === clip.durationSamples &&
        (frameGain === undefined
          ? track.clip.gain === clip.gain
          : !!track.clip.volumeEnvelope &&
            Math.abs(
              track.clip.gain *
                evaluateAudioEnvelope(
                  track.clip.volumeEnvelope,
                  framesToSamples(
                    validation.frame,
                    fps,
                    validation.declaration.plan!.sampleRate,
                    "round",
                  ) - track.clip.startSample,
                ) -
                frameGain,
            ) < 1e-9),
    );
    if (index < 0)
      throw new Error(
        `VELOCAST_REMOTION_AUDIO_UNPLANNED: mounted Audio ${JSON.stringify(src)} does not match the host declaration`,
      );
    validation.mounted.set(token, index);
  }

  unmount(validation: FrameValidation, token: object): void {
    validation.mounted.delete(token);
  }

  assertActiveTracksMounted(
    validation: FrameValidation,
    config: VideoConfig,
  ): void {
    if (validation !== this.current())
      throw new Error(
        "VELOCAST_REMOTION_AUDIO_STALE: validation belongs to a replaced frame declaration",
      );
    const occupied = new Set(validation.mounted.values());
    const frameSample = framesToSamples(
      validation.frame,
      config.fps,
      validation.declaration.plan?.sampleRate ?? 48_000,
      "round",
    );
    const missing = validation.declaration.tracks.findIndex(
      (track, index) =>
        !occupied.has(index) &&
        frameSample >= track.clip.startSample &&
        frameSample < track.clip.startSample + track.clip.durationSamples,
    );
    if (missing >= 0)
      throw new Error(
        `VELOCAST_REMOTION_AUDIO_MISSING: active declared track ${JSON.stringify(validation.declaration.tracks[missing]!.src)} did not mount`,
      );
  }
}

export type RemotionAudioProps = ComponentProps<typeof PinnedAudio> & {
  readonly trimBefore?: number;
  readonly trimAfter?: number;
};

export function Audio(props: RemotionAudioProps): null {
  const context = useCompatibilityContext();
  const sequences = useRemotionSequences();
  const config = context.config;
  const token = useRef<object>({});
  const validation = context.audio.current();
  const {
    src,
    startFrom: oldStart,
    endAt: oldEnd,
    trimBefore,
    trimAfter,
    volume = 1,
    playbackRate,
    loop,
    muted,
    acceptableTimeShiftInSeconds,
    allowAmplificationDuringRender,
    pauseWhenBuffering,
    delayRenderRetries,
    delayRenderTimeoutInMilliseconds,
    loopVolumeCurveBehavior,
    toneFrequency,
    ref: _ref,
    ...rest
  } = props;
  void _ref;
  if (typeof src !== "string" || !src)
    throw new Error(
      'VELOCAST_REMOTION_AUDIO_INVALID: no string "src" prop was passed to <Audio>.',
    );
  const { startFrom = 0, endAt } = resolveTrims({
    startFrom: oldStart,
    endAt: oldEnd,
    trimBefore,
    trimAfter,
  });
  const unsupported = {
    playbackRate,
    loop,
    muted,
    acceptableTimeShiftInSeconds,
    allowAmplificationDuringRender,
    pauseWhenBuffering,
    delayRenderRetries,
    delayRenderTimeoutInMilliseconds,
    loopVolumeCurveBehavior,
    toneFrequency,
    ...rest,
  };
  for (const [name, value] of Object.entries(unsupported))
    if (value !== undefined && value !== false)
      throw new Error(
        `VELOCAST_REMOTION_UNSUPPORTED: Audio.${name} is not supported by this Remotion 4.0.244 bridge slice`,
      );
  const plan = validation.declaration.plan;
  if (!plan)
    throw new Error(
      "VELOCAST_REMOTION_AUDIO_UNPLANNED: <Audio> requires an explicit host audio declaration",
    );
  if (
    typeof volume === "function" &&
    sequences.some((sequence) => sequence.from < 0)
  )
    throw new Error(
      "VELOCAST_REMOTION_AUDIO_NEGATIVE_VOLUME: callback tracks require nonnegative sequences; use a sample envelope for preroll",
    );
  const window = sequenceWindow(sequences, config.durationFrames);
  const trimStart = integer(startFrom, "Audio.startFrom", true);
  const trimEnd =
    endAt === undefined ? undefined : integer(endAt, "Audio.endAt", true);
  if (trimEnd !== undefined && trimEnd < trimStart)
    throw new RangeError(
      "VELOCAST_REMOTION_AUDIO_INVALID: Audio.endAt must be >= startFrom",
    );
  const sourceStartFrame = trimStart + (window.start - window.absoluteFrom);
  let end = window.end;
  if (trimEnd !== undefined)
    end = Math.min(end, window.absoluteFrom + trimEnd - trimStart);
  end = Math.max(window.start, end);
  const startSample = framesToSamples(
    window.start,
    config.fps,
    plan.sampleRate,
    "round",
  );
  const clip = {
    startSample,
    sourceStartSample: framesToSamples(
      sourceStartFrame,
      config.fps,
      plan.sampleRate,
      "round",
    ),
    durationSamples:
      framesToSamples(end, config.fps, plan.sampleRate, "round") - startSample,
    gain: typeof volume === "function" ? 1 : finiteGain(volume),
  };
  useLayoutEffect(() => {
    context.audio.mount(
      validation,
      token.current,
      src,
      clip,
      typeof volume === "function"
        ? finiteGain(volume(validation.frame - window.absoluteFrom))
        : undefined,
      config.fps,
    );
    return () => context.audio.unmount(validation, token.current);
  }, [
    context.audio,
    validation,
    src,
    clip.startSample,
    clip.sourceStartSample,
    clip.durationSamples,
    clip.gain,
    volume,
    window.absoluteFrom,
    config.fps,
  ]);
  return null;
}

export function AudioValidationBoundary({
  children,
}: {
  readonly children: ReactNode;
}) {
  const context = useCompatibilityContext();
  const validation = context.audio.current();
  const validate = useCallback(
    () => context.audio.assertActiveTracksMounted(validation, context.config),
    [context, validation],
  );
  useFrameResource(validate);
  return children;
}

export function resolveTrims(props: {
  startFrom?: number;
  endAt?: number;
  trimBefore?: number;
  trimAfter?: number;
}) {
  if (
    (props.startFrom !== undefined && props.trimBefore !== undefined) ||
    (props.endAt !== undefined && props.trimAfter !== undefined)
  )
    throw new Error(
      "VELOCAST_REMOTION_TRIM_CONFLICT: use either startFrom/endAt or trimBefore/trimAfter for each boundary",
    );
  return {
    startFrom: props.trimBefore ?? props.startFrom,
    endAt: props.trimAfter ?? props.endAt,
  };
}
function volumeEnvelope(
  volume: (frame: number) => number,
  start: number,
  end: number,
  from: number,
  fps: number,
  sampleRate: number,
) {
  if (end - start > 500_000)
    throw new RangeError(
      "VELOCAST_REMOTION_AUDIO_VOLUME_LIMIT: callback preparation is limited to 500000 frames; use a sparse AudioPlan envelope",
    );
  const origin = framesToSamples(start, fps, sampleRate, "round");
  const points: { sample: number; gain: number }[] = [];
  for (let frame = start; frame <= end; frame++) {
    const next = {
      sample: framesToSamples(frame, fps, sampleRate, "round") - origin,
      gain: finiteGain(volume(frame - from)),
    };
    if (points.at(-1)?.sample === next.sample) points.pop();
    while (points.length >= 2) {
      const previous = points.at(-2)!,
        last = points.at(-1)!;
      // Drop only an exactly collinear point; no curve approximation/tolerance.
      const interpolated =
        previous.gain +
        (next.gain - previous.gain) *
          ((last.sample - previous.sample) / (next.sample - previous.sample));
      if (interpolated !== last.gain) break;
      points.pop();
    }
    points.push(next);
    if (points.length > 9998)
      throw new RangeError(
        "VELOCAST_REMOTION_AUDIO_VOLUME_LIMIT: callback exceeds 9998 non-collinear points; split the clip or use a sparse AudioPlan envelope",
      );
  }
  return points;
}

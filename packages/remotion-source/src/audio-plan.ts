import type { AudioPlan } from "@velocast/core";
export interface RemotionMediaAsset {
  type: "audio" | "video";
  id: string;
  src: string;
  frame: number;
  mediaFrame: number;
  volume: number;
  playbackRate: number;
  toneFrequency: number | null;
}
/** Captured upstream assets retain Sequence/Loop trim and per-frame volume semantics. */
export async function remotionAudioPlan(
  frames: readonly (readonly RemotionMediaAsset[])[],
  fps: number,
  sampleRate: number,
  freeze: (source: string, type: "audio" | "video") => Promise<string | null>,
): Promise<AudioPlan> {
  const clips: AudioPlan["clips"][number][] = [];
  const preceding = new Map<string, number>();
  for (let frame = 0; frame < frames.length; frame++) {
    const seen = new Set<string>();
    for (const asset of frames[frame]!) {
      if (seen.has(asset.id) || asset.volume <= 0) continue;
      seen.add(asset.id);
      const source = await freeze(asset.src, asset.type);
      if (source === null) continue;
      if (
        asset.playbackRate !== 1 ||
        (asset.toneFrequency !== null && asset.toneFrequency !== undefined)
      )
        throw new Error(
          "remotion.audio_transform_unsupported: pitch-preserving playbackRate and toneFrequency require preprocessed audio; render an audio file with the desired tempo/pitch and use playbackRate=1 without toneFrequency",
        );
      if (
        !Number.isFinite(asset.volume) ||
        !Number.isFinite(asset.mediaFrame) ||
        asset.mediaFrame < 0
      )
        throw new Error("remotion.invalid_audio_asset");
      const startSample = Math.round((frame * sampleRate) / fps),
        end = Math.round(((frame + 1) * sampleRate) / fps);
      const sourceStartSample = Math.round(
        (asset.mediaFrame * sampleRate) / fps,
      );
      const previousIndex = preceding.get(asset.id),
        previous =
          previousIndex === undefined ? undefined : clips[previousIndex];
      if (
        previous &&
        previous.source === source &&
        previous.gain === asset.volume &&
        previous.startSample + previous.durationSamples === startSample &&
        previous.sourceStartSample + previous.durationSamples ===
          sourceStartSample
      ) {
        clips[previousIndex!] = {
          ...previous,
          durationSamples: previous.durationSamples + end - startSample,
        };
        continue;
      }
      preceding.set(asset.id, clips.length);
      clips.push({
        source,
        startSample,
        sourceStartSample,
        durationSamples: end - startSample,
        gain: asset.volume,
      });
    }
  }
  return {
    sampleRate,
    durationSamples: Math.round((frames.length * sampleRate) / fps),
    clips,
  };
}

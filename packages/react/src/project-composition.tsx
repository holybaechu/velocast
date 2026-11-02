import {
  defineFrameComposition,
  getProjectLayerRange,
  parseVideoProject,
  type FrameComposition,
  type ProjectComposition,
  type ProjectLayer,
  type VideoProject,
} from "@velocast/core";
import type { CSSProperties } from "react";
import { defineReactComposition } from "./composition.js";
import { useCurrentFrame } from "./frame-state.js";
import { createMediaTimeline, type MediaClip } from "./media-timeline.js";
import { Sequence } from "./sequence.js";
import { VideoClip, VideoFrameProvider } from "./video-clip.js";
import { requestSnapshotVideoFrame } from "./snapshot-video-frame.js";
import { StillImage } from "./still-image.js";

function composition(project: VideoProject, id: string): ProjectComposition {
  const value = project.compositions.find((item) => item.id === id);
  if (!value)
    throw new Error(
      `project.invalid: composition ${id} is missing from current input props`,
    );
  return value;
}

function video(value: ProjectComposition) {
  return {
    width: value.width,
    height: value.height,
    fps: value.fps,
    durationFrames: value.durationFrames,
  };
}

/** Register the editable document; current input props own content and metadata. */
export function defineProjectCompositions(
  input: VideoProject,
): FrameComposition[] {
  const initial = parseVideoProject(input);
  return initial.compositions.map(({ id }) => {
    const makeDefinition = (project: VideoProject) =>
      defineReactComposition<VideoProject>({
        id,
        video: video(composition(project, id)),
        defaultProps: project,
        parseProps: parseVideoProject,
        component: (props) => <ProjectFrame project={props} id={id} />,
        audio: ({ inputProps }) => {
          const current = composition(inputProps, id);
          const clips = current.layers.flatMap((layer): MediaClip[] => {
            if (layer.kind !== "video" && layer.kind !== "audio") return [];
            const asset = inputProps.assets.find(
              (asset) => asset.id === layer.assetId,
            )!;
            if (layer.kind === "video" && !asset.hasAudio) return [];
            return [
              {
                id: layer.id,
                kind: layer.kind,
                src: asset.src,
                from: getProjectLayerRange(current, layer).start,
                durationFrames: layer.durationFrames,
                trimBeforeFrames: layer.trimBeforeFrames,
                gain: layer.gain,
                fadeInFrames: layer.fadeInFrames,
                fadeOutFrames: layer.fadeOutFrames,
              },
            ];
          });
          return clips.length
            ? createMediaTimeline(video(current), clips).audio
            : null;
        },
      });
    const definition = makeDefinition(initial);
    return defineFrameComposition<VideoProject>({
      id,
      video: definition.video!,
      rootElement: definition.rootElement,
      defaultProps: initial,
      parseProps: parseVideoProject,
      resolveVideo: (project) => ({
        ...video(composition(project, id)),
        target: definition.video!.target,
      }),
      source: {
        open: (context) =>
          makeDefinition(context.inputProps).source.open(context),
      },
    });
  });
}

function layerStyle(layer: ProjectLayer, frame: number): CSSProperties {
  const fadeIn = layer.fadeInFrames
    ? Math.min(1, frame / layer.fadeInFrames)
    : 1;
  const fadeOut = layer.fadeOutFrames
    ? Math.min(1, (layer.durationFrames - frame) / layer.fadeOutFrames)
    : 1;
  return {
    position: "absolute",
    left: layer.x,
    top: layer.y,
    width: layer.width,
    height: layer.height,
    transform: `rotate(${layer.rotation}deg)`,
    opacity: layer.opacity * Math.min(fadeIn, fadeOut),
    overflow: "hidden",
    boxSizing: "border-box",
    color: layer.color ?? "#ffffff",
    fontFamily: layer.fontFamily ?? "Arial, sans-serif",
    fontSize: layer.fontSize ?? 48,
    lineHeight: 1.15,
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
    backgroundColor:
      layer.kind === "shape" ? (layer.color ?? "#ffffff") : undefined,
  };
}

function ProjectFrame({ project, id }: { project: VideoProject; id: string }) {
  const current = composition(project, id);
  const frame = useCurrentFrame();
  const scene = current.scenes.find(
    (item) => frame >= item.from && frame < item.from + item.durationFrames,
  );
  return (
    <VideoFrameProvider getFrame={requestSnapshotVideoFrame}>
      <div
        style={{
          position: "relative",
          width: current.width,
          height: current.height,
          overflow: "hidden",
          backgroundColor: scene?.background ?? current.background,
        }}
      >
        {current.layers.map((layer) => {
          const { start, end } = getProjectLayerRange(current, layer);
          if (layer.kind === "audio" || frame < start || frame >= end)
            return null;
          const asset = project.assets.find(
            (item) => item.id === layer.assetId,
          );
          return (
            <div
              key={layer.id}
              data-velocast-layer={layer.id}
              style={layerStyle(layer, frame - start)}
            >
              {layer.kind === "text" ? (
                layer.text
              ) : layer.kind === "image" ? (
                <StillImage
                  src={asset!.src}
                  style={{ objectFit: layer.fit ?? "contain" }}
                  width={layer.width}
                  height={layer.height}
                />
              ) : layer.kind === "video" ? (
                <Sequence from={start} durationFrames={layer.durationFrames}>
                  <VideoClip
                    src={asset!.src}
                    muted
                    trimBeforeFrames={layer.trimBeforeFrames}
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: layer.fit ?? "contain",
                    }}
                  />
                </Sequence>
              ) : null}
            </div>
          );
        })}
      </div>
    </VideoFrameProvider>
  );
}

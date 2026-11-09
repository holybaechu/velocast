import React from "react";
import {
  createMediaTimeline,
  defineReactComposition,
  Layer,
  useCurrentFrame,
} from "@velocast/react";
import { BrandMark, ProgressRing } from "./graphics.jsx";
import cues from "./captions.json";

const video = { width: 540, height: 960, fps: 30, durationFrames: 300 };
const media = createMediaTimeline(video, [
  {
    id: "narration",
    kind: "audio",
    src: "assets/narration.wav",
    from: 0,
    durationFrames: 300,
  },
  {
    id: "music",
    kind: "audio",
    src: "assets/music.wav",
    from: 0,
    durationFrames: 300,
    gain: 0.12,
    fadeInFrames: 15,
    fadeOutFrames: 30,
  },
]);

function PortraitExplainer() {
  const frame = useCurrentFrame();
  const cue = cues.find(({ start, end }) => start <= frame && frame < end);
  return (
    <main
      style={{
        position: "relative",
        width: 540,
        height: 960,
        overflow: "hidden",
        background: "linear-gradient(155deg,#234d42,#102c2a)",
        color: "#f4f5e8",
        fontFamily: "Arial, sans-serif",
      }}
    >
      <Layer id="portrait-brand" x={48} y={60} width={444} height={48}>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <BrandMark />
          <span style={{ fontSize: 22 }}>FIELDNOTE</span>
        </div>
      </Layer>
      <Layer
        id="portrait-title"
        x={48}
        y={170}
        width={444}
        height={150}
        style={{ fontSize: 54, lineHeight: 1.06, letterSpacing: -1 }}
      >
        Make space for focus.
      </Layer>
      <Layer id="portrait-graphic" x={130} y={370} width={280} height={280}>
        <ProgressRing progress={frame / 299} size={280} />
      </Layer>
      <Layer id="captions" x={40} y={724} width={460} height={140}>
        {cue && (
          <div
            style={{
              boxSizing: "border-box",
              width: "100%",
              padding: "20px 24px",
              borderRadius: 18,
              background: "#081e1dec",
              color: "#f4f5e8",
              fontSize: 32,
              lineHeight: 1.2,
              textAlign: "center",
            }}
          >
            {cue.text}
          </div>
        )}
      </Layer>
      <media.Timeline />
    </main>
  );
}

export const portraitExplainer = defineReactComposition({
  id: "portrait-explainer",
  video,
  component: PortraitExplainer,
  audio: media.audio,
});

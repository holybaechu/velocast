import React from "react";
import {
  createMediaTimeline,
  defineReactComposition,
  Layer,
  useCurrentFrame,
} from "@velocast/react";
import { BrandMark, ProgressRing, Scene } from "./graphics.jsx";

const video = { width: 960, height: 540, fps: 30, durationFrames: 300 };
const media = createMediaTimeline(video, [
  {
    id: "footage",
    kind: "video",
    src: "assets/background.mp4",
    from: 0,
    durationFrames: 300,
    muted: true,
    style: {
      position: "absolute",
      inset: 0,
      width: "100%",
      height: "100%",
      objectFit: "cover",
    },
  },
  {
    id: "music",
    kind: "audio",
    src: "assets/music.wav",
    from: 0,
    durationFrames: 300,
    gain: 0.45,
    fadeInFrames: 15,
    fadeOutFrames: 30,
  },
]);

function ProductIntro() {
  const frame = useCurrentFrame();
  return (
    <main
      style={{
        position: "relative",
        width: 960,
        height: 540,
        overflow: "hidden",
        background: "#102c2a",
        color: "#f4f5e8",
        fontFamily: "Arial, sans-serif",
      }}
    >
      <media.Timeline />
      <div
        style={{ position: "absolute", inset: 0, background: "#081e1d45" }}
      />
      <Layer id="brand" x={64} y={38} width={400} height={44}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <BrandMark />
          <span style={{ fontSize: 22, letterSpacing: 1 }}>FIELDNOTE</span>
        </div>
      </Layer>
      <Scene from={0} durationFrames={105}>
        <Layer
          id="intro-title"
          x={64}
          y={170}
          width={832}
          height={160}
          style={{ fontSize: 64, lineHeight: 1.08, letterSpacing: -2 }}
        >
          A calmer place to work.
        </Layer>
        <Layer
          id="intro-subtitle"
          x={68}
          y={380}
          width={780}
          height={50}
          style={{ fontSize: 24, color: "#d6e8b7" }}
        >
          Your ideas, with room to grow.
        </Layer>
      </Scene>
      <Scene from={90} durationFrames={135}>
        <Layer
          id="workflow-title"
          x={64}
          y={170}
          width={560}
          height={170}
          style={{ fontSize: 50, lineHeight: 1.12, letterSpacing: -1 }}
        >
          From scattered notes to a clear next step.
        </Layer>
        <Layer id="workflow-graphic" x={650} y={165} width={240} height={240}>
          <ProgressRing
            progress={Math.max(0, Math.min(1, (frame - 90) / 100))}
            size={240}
          />
        </Layer>
      </Scene>
      <Scene from={210} durationFrames={90} exit={false}>
        <Layer
          id="closing-title"
          x={64}
          y={170}
          width={832}
          height={160}
          style={{ fontSize: 56, lineHeight: 1.1, letterSpacing: -1 }}
        >
          Make room for your best work.
        </Layer>
        <Layer
          id="closing-cta"
          x={68}
          y={390}
          width={780}
          height={50}
          style={{ fontSize: 26, color: "#d6e8b7" }}
        >
          fieldnote.example
        </Layer>
      </Scene>
    </main>
  );
}

export const productIntro = defineReactComposition({
  id: "product-intro",
  video,
  component: ProductIntro,
  audio: media.audio,
});

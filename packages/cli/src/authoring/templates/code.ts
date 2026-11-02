const productDemo = `import React from "react";
import {
  createMediaTimeline, defineReactComposition, Layer, StillImage, useCurrentFrame,
} from "@velocast/react";

const video = { width: 960, height: 540, fps: 30, durationFrames: 900 };
const media = createMediaTimeline(video, [
  { id: "music", kind: "audio", src: "assets/music.wav", from: 0,
    durationFrames: 900, gain: 0.6, fadeInFrames: 15, fadeOutFrames: 45 },
]);

function ProductDemo() {
  const frame = useCurrentFrame();
  return (
    <main style={{ position: "relative", width: 960, height: 540, overflow: "hidden",
      background: frame < 300 ? "#f5f3ee" : frame < 600 ? "#edf2f0" : "#182d28",
      fontFamily: "Arial, sans-serif" }}>
      <Layer id="intro-title" name="Headline" from={0} durationFrames={300}
        x={72} y={42} width={816} height={64}
        opacity={Math.min(1, frame / 18)} style={{ fontSize: 48, color: "#183a30" }}>
        A calmer place to work.
      </Layer>
      <Layer id="intro-body" name="Supporting text" from={18} durationFrames={282}
        x={72} y={118} width={816} height={42} style={{ fontSize: 23, color: "#50615b" }}>
        Keep your projects, notes, and next steps together.
      </Layer>
      <Layer id="intro-image" name="Workspace" from={36} durationFrames={264}
        x={195} y={194} width={570} height={316}>
        <StillImage src="assets/overview.svg" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
      </Layer>
      <Layer id="workflow-title" name="Workflow title" from={300} durationFrames={300}
        x={72} y={42} width={816} height={90} style={{ fontSize: 34, color: "#183a30" }}>
        From scattered notes to a clear next step.
      </Layer>
      <Layer id="workflow-image" name="Project board" from={315} durationFrames={285}
        x={195} y={160} width={570} height={316}>
        <StillImage src="assets/detail.svg" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
      </Layer>
      <Layer id="close-title" name="Closing headline" from={600} durationFrames={300}
        x={72} y={130} width={816} height={150} style={{ fontSize: 48, color: "#f5f3ee" }}>
        Make room for your best work.
      </Layer>
      <Layer id="close-body" name="Website" from={630} durationFrames={270}
        x={72} y={320} width={816} height={60} style={{ fontSize: 30, color: "#b7d3c6" }}>
        fieldnote.example
      </Layer>
      <media.Timeline />
    </main>
  );
}

export const productDemo = defineReactComposition({
  id: "product-demo", video, component: ProductDemo, audio: media.audio,
});
`;

const socialCard = `import React from "react";
import { defineReactComposition, Layer, useCurrentFrame } from "@velocast/react";

function SocialCard() {
  const frame = useCurrentFrame();
  const progress = Math.min(1, frame / 60);
  return (
    <main style={{ position: "relative", width: 540, height: 960, overflow: "hidden",
      background: "#182d28", color: "#f5f3ee", fontFamily: "Arial, sans-serif" }}>
      <Layer id="social-heading" name="Heading" from={0} durationFrames={150}
        x={48} y={80} width={444} height={150} style={{ fontSize: 52 }}>
        Make space for focus.
      </Layer>
      <Layer id="social-graphic" name="Animated graphic" from={0} durationFrames={150}
        x={70} y={310} width={400} height={400}>
        <svg viewBox="0 0 400 400" width="400" height="400" aria-label="Progress circle">
          <circle cx="200" cy="200" r="160" fill="none" stroke="#344b43" strokeWidth="24" />
          <circle cx="200" cy="200" r="160" fill="none" stroke="#b7d3c6" strokeWidth="24"
            strokeDasharray={2 * Math.PI * 160} strokeDashoffset={2 * Math.PI * 160 * (1 - progress)}
            transform="rotate(-90 200 200)" />
          <text x="200" y="220" textAnchor="middle" fill="#f5f3ee" fontSize="64">{Math.round(progress * 100)}%</text>
        </svg>
      </Layer>
      <Layer id="social-footer" name="Footer" from={30} durationFrames={120}
        x={48} y={800} width={444} height={60} style={{ fontSize: 26, color: "#b7d3c6" }}>
        Your next idea starts here.
      </Layer>
    </main>
  );
}

export const socialCard = defineReactComposition({
  id: "social-card", video: { width: 540, height: 960, fps: 30, durationFrames: 150 },
  component: SocialCard,
});
`;

const blankVideo = `import React from "react";
import { defineReactComposition, Layer } from "@velocast/react";

function Video() {
  return (
    <main style={{ position: "relative", width: 960, height: 540, background: "#f5f3ee", fontFamily: "Arial, sans-serif" }}>
      <Layer id="title" name="Title" from={0} durationFrames={300}
        x={72} y={200} width={816} height={100} style={{ fontSize: 56, color: "#183a30" }}>
        Your story starts here.
      </Layer>
    </main>
  );
}

export const video = defineReactComposition({
  id: "video", video: { width: 960, height: 540, fps: 30, durationFrames: 300 }, component: Video,
});
`;

export function codeStarterFiles(blank: boolean): Record<string, string> {
  const sources = blank
    ? { video: "src/video.jsx" }
    : {
        "product-demo": "src/product-demo.jsx",
        "social-card": "src/social-card.jsx",
      };
  return {
    "vite.config.mjs": `import {studioSourcePlugin} from "velocast/vite";
import config from "./velocast.config.ts";
export default {base: "./", plugins: [studioSourcePlugin(config.studio.sources)]};
`,
    "velocast.config.ts": `import {defineConfig} from "velocast";
export default defineConfig({
  entry: "dist/index.html",
  studio: { sources: ${JSON.stringify(sources, null, 2)} },
  renderer: { snapshotRoot: "dist" },
});
`,
    "src/main.jsx": blank
      ? 'import {startVelocast} from "@velocast/react";\nimport {video} from "./video.jsx";\nstartVelocast([video]);\n'
      : 'import {startVelocast} from "@velocast/react";\nimport {productDemo} from "./product-demo.jsx";\nimport {socialCard} from "./social-card.jsx";\nstartVelocast([productDemo, socialCard]);\n',
    ...(blank
      ? { "src/video.jsx": blankVideo }
      : {
          "src/product-demo.jsx": productDemo,
          "src/social-card.jsx": socialCard,
        }),
    "README.md": `# ${blank ? "Your video" : "Fieldnote video project"}

Run \`npm install\`, then \`npm run studio\`. Open the printed URL. Ctrl+C stops Studio and its build watcher. Export requires a working native renderer and Electron runtime; \`npx velocast doctor --json\` reports missing requirements.

Author in \`src/${blank ? "video" : "product-demo"}.jsx\`${blank ? "" : " or `src/social-card.jsx`"}. Each file defines a normal React composition. Use \`useCurrentFrame\` for deterministic animation and \`Layer\` for source-editable boundaries. Register new compositions in \`src/main.jsx\` and map their source files in \`velocast.config.ts\`.

In Studio, select a layer in the canvas or timeline, change text, layout or timing, then save. Supported literal changes write to that JSX file. Computed expressions stay controlled by code and show why they cannot be edited. The source location identifies where to change them in your editor. Undo/redo belongs to the running server; external edits reset its history. Playback, selection and ranges are session settings. Keep the source plugin in \`vite.config.mjs\`: it records which source revisions produced each successful build so Studio can distinguish saved edits from displayed frames.

Keep assets in \`public/assets\` and refer to them with paths such as \`assets/image.png\`. \`StillImage\` waits for decoding and fixes animated images to their first frame. Use \`createMediaTimeline\` for audio/video: declare source, timing, trim, gain and fades once, render its \`Timeline\`, and pass its \`audio\` to the composition. For silent video, set \`muted: true\`. The sample artwork and locally generated instrumental music may be replaced or reused freely.

Frames start at zero; ranges end exclusively. A Layer's timing is relative to its parent. Its children receive a local frame. Use absolute composition frames in the media timeline. Save code and wait for the completed build to appear before exporting.

Use Export in Studio or \`npm run render\`, then \`npm run verify\`. \`npm run frame\` captures frame 60. For a short test: \`npx velocast render ${blank ? "video" : "product-demo"} --start-frame 30 --end-frame 60 --output renders/test.mp4 --json\`. Inspect the image and play output with sound; metadata checks cannot judge appearance.

For scripts and agents, start with \`npx velocast capabilities --json\` and the running Studio's \`GET /api/capabilities\`. \`GET /api/code?compositionId=${blank ? "video" : "product-demo"}\` returns source locations, revisions and supported fields. Direct source editing, \`npm run build\`, and CLI \`compositions\`, \`frame\`, \`render\`, and \`verify\` also work without Studio.
`,
  };
}

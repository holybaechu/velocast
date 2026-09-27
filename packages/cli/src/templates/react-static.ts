/** Compiled into dist: starter assets require no package-copy hook or network. */
export const REACT_STARTER_TEMPLATE_VERSION = 3;
export const REACT_STARTER_COMPOSITION_ID = "hello-react";

export const reactStaticFiles: Readonly<Record<string, string>> = Object.freeze(
  {
    "package.json":
      JSON.stringify(
        {
          name: "velocast-react-video",
          version: "0.1.0",
          private: true,
          type: "module",
          scripts: {
            build: "vite build",
            preview:
              'npm run build && velocast preview --watch-command "vite build --watch"',
            render:
              "velocast render hello-react --output renders/hello-react.mp4",
          },
          dependencies: {
            "@velocast/react": "0.1.0",
            react: "18.3.1",
            "react-dom": "18.3.1",
          },
          devDependencies: { velocast: "0.1.0", vite: "8.3.0" },
          engines: { node: "^22.22.2 || ^24.15.0 || >=26.0.0" },
        },
        null,
        2,
      ) + "\n",
    "velocast-template.json":
      JSON.stringify(
        {
          template: "react-static",
          templateVersion: REACT_STARTER_TEMPLATE_VERSION,
          compositionId: REACT_STARTER_COMPOSITION_ID,
          width: 640,
          height: 360,
          fps: 30,
          durationFrames: 90,
        },
        null,
        2,
      ) + "\n",
    ".gitignore": "node_modules/\ndist/\nrenders/\n.velocast/\n",
    "velocast.config.ts": `export default {
  entry: "dist/index.html",
  renderer: {
    snapshotRoot: "dist",
    acceleration: "auto",
  },
};
`,
    "vite.config.js": `export default {
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
};
`,
    "index.html": `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>My first Velocast video</title>
  </head>
  <body>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`,
    "src/main.jsx": `import React from "react";
import {
  defineReactComposition,
  startVelocast,
  useCurrentFrame,
  useInputProps,
  useVideoConfig,
} from "@velocast/react";
import "./style.css";

function HelloReact() {
  const frame = useCurrentFrame();
  const { width, height, fps, durationFrames } = useVideoConfig();
  const { title, subtitle } = useInputProps();
  const progress = (frame + 1) / durationFrames;

  return (
    <main className="composition" style={{ width, height }}>
      <img className="cover" src="./cover.svg" width="224" height="224" alt="주황빛 레코드 일러스트" />
      <section className="copy">
        <p className="eyebrow">MY FIRST VIDEO</p>
        <h1>{title}</h1>
        <p className="subtitle">{subtitle}</p>
        <div className="progress" aria-hidden="true">
          <span style={{ transform: "scaleX(" + progress + ")" }} />
        </div>
        <p className="frame">{String(frame).padStart(3, "0")} / {durationFrames} · {(frame / fps).toFixed(2)}s</p>
      </section>
    </main>
  );
}

const composition = defineReactComposition({
  id: "hello-react",
  component: HelloReact,
  video: { width: 640, height: 360, fps: 30, durationFrames: 90 },
  defaultProps: {
    title: "안녕하세요, Velocast",
    subtitle: "코드를 바꾸고, 다시 렌더하세요.",
  },
});

startVelocast([composition]);
`,
    "src/style.css": `* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #c9e4f2; }
.composition {
  display: grid;
  grid-template-columns: 224px 1fr;
  align-items: center;
  gap: 32px;
  padding: 32px;
  color: #243746;
  background: #c9e4f2;
  font-family: "Malgun Gothic", "Apple SD Gothic Neo", sans-serif;
}
.cover { display: block; border-radius: 20px; }
.eyebrow { margin: 0 0 14px; color: #387782; font: 600 11px/1.2 monospace; letter-spacing: 2px; }
h1 { margin: 0; font-size: 34px; line-height: 1.25; letter-spacing: -1.4px; word-break: keep-all; }
.subtitle { margin: 18px 0 24px; font-size: 15px; line-height: 1.65; word-break: keep-all; }
.progress { height: 4px; overflow: hidden; background: #a5cad9; }
.progress span { display: block; width: 100%; height: 100%; background: #387782; transform-origin: left; }
.frame { margin: 10px 0 0; color: #44737d; font: 11px/1.2 monospace; }
`,
    "public/cover.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="224" height="224" viewBox="0 0 224 224">
  <rect width="224" height="224" fill="#f7fafc" />
  <path d="M0 150C43 113 64 185 110 144S179 107 224 128V224H0Z" fill="#387782" />
  <circle cx="113" cy="91" r="63" fill="#f5b88e" />
  <g fill="none" stroke="#cb875f" stroke-width="1.5">
    <circle cx="113" cy="91" r="50" /><circle cx="113" cy="91" r="39" /><circle cx="113" cy="91" r="28" />
  </g>
  <circle cx="113" cy="91" r="15" fill="#243746" />
  <circle cx="113" cy="91" r="4" fill="#f7fafc" />
  <path d="M28 187H63M74 187H137M148 187H197" stroke="#c9e4f2" stroke-width="3" stroke-linecap="round" />
</svg>
`,
    "input-props.json":
      JSON.stringify(
        {
          title: "내 첫 번째 영상",
          subtitle: "이 파일을 바꿔 입력을 전달해 보세요.",
        },
        null,
        2,
      ) + "\n",
    "README.md": `# My first Velocast video

This starter defines **hello-react**: 640×360, 30fps, 90 frames (3 seconds).
It uses the official React helper, Korean text and a local SVG. It contains no remote images, fonts or scripts.

## First render

No dependencies were installed by init. From this directory, run these steps when ready:

\`\`\`sh
npm install
npm run build
npm run render
\`\`\`

The build creates \`dist\`. Velocast freezes that explicit directory for the render and writes \`renders/hello-react.mp4\` only through the native renderer's output lifecycle.
The matching Velocast CLI/React packages must be available from your package source. For a prerelease checkout, install the matching packed packages supplied by the project instead of unrelated registry packages.
Native rendering also needs a working Velocast runtime. Check \`npx velocast doctor\`; use \`npx velocast setup\` only when a verified runtime artifact is available for your host.

## Edit the video

Run \`npm run preview\` to open the local player URL printed by the CLI. It builds once and owns a Vite build watcher. Edit source, wait for a successful build, then use **Refresh source**; the player keeps the selected frame but pauses playback. Inspect one frame or a half-open range from the player. Ctrl+C stops its servers, render jobs and watcher; completed outputs remain under \`.velocast/preview-output\`.

Edit \`src/main.jsx\` or \`src/style.css\`, then rebuild before rendering again. Frame-derived styles use \`useCurrentFrame\` rather than wall-clock animations, so direct seeking stays deterministic.
To change input props without editing the component:

\`\`\`sh
npm run render -- --input-props-file input-props.json
\`\`\`

Keep assets local under \`public\`; the snapshot policy blocks external resource/fetch imports. The default system Korean font can vary by machine; use a licensed local font if cross-machine typography must be fixed.
The preview confirms code-authored frames and ranges; it is not a drag-and-drop visual timeline editor.
`,
  },
);

import type { ProjectLayer, VideoProject } from "@velocast/core";
import { codeStarterFiles } from "./code.js";

export type ProjectTemplate = "product-demo" | "blank" | "editable-project";

function layer(
  id: string,
  name: string,
  kind: ProjectLayer["kind"],
  overrides: Partial<ProjectLayer> = {},
): ProjectLayer {
  return {
    id,
    name,
    kind,
    from: 0,
    durationFrames: 300,
    x: 72,
    y: 70,
    width: 816,
    height: 100,
    rotation: 0,
    opacity: 1,
    ...overrides,
  };
}

export function starterProject(template: ProjectTemplate): VideoProject {
  const blank = template === "blank";
  return {
    format: "velocast-project",
    version: 1,
    name: blank ? "Untitled video" : "Fieldnote product demo",
    assets: blank
      ? []
      : [
          {
            id: "overview",
            name: "Workspace screenshot",
            kind: "image",
            src: "assets/overview.svg",
            width: 900,
            height: 500,
          },
          {
            id: "detail",
            name: "Project screenshot",
            kind: "image",
            src: "assets/detail.svg",
            width: 900,
            height: 500,
          },
          {
            id: "music",
            name: "Background music",
            kind: "audio",
            src: "assets/music.wav",
            durationSeconds: 30,
          },
        ],
    compositions: [
      {
        id: blank ? "video" : "product-demo",
        name: blank ? "Untitled video" : "Product demo",
        width: 960,
        height: 540,
        fps: 30,
        durationFrames: blank ? 300 : 900,
        background: "#f5f3ee",
        scenes: blank
          ? [
              {
                id: "scene-1",
                name: "Scene 1",
                from: 0,
                durationFrames: 300,
                background: "#f5f3ee",
              },
            ]
          : [
              {
                id: "intro",
                name: "Introduce the product",
                from: 0,
                durationFrames: 300,
                background: "#f5f3ee",
              },
              {
                id: "workflow",
                name: "Show the workflow",
                from: 300,
                durationFrames: 300,
                background: "#edf2f0",
              },
              {
                id: "close",
                name: "Call to action",
                from: 600,
                durationFrames: 300,
                background: "#182d28",
              },
            ],
        layers: blank
          ? []
          : [
              layer("intro-title", "Headline", "text", {
                sceneId: "intro",
                from: 0,
                durationFrames: 300,
                text: "A calmer place to work.",
                fontSize: 48,
                fontFamily: "Arial",
                color: "#183a30",
                fadeInFrames: 18,
                y: 42,
                height: 64,
              }),
              layer("intro-body", "Supporting text", "text", {
                sceneId: "intro",
                from: 18,
                durationFrames: 282,
                text: "Keep your projects, notes, and next steps together.",
                fontSize: 23,
                color: "#50615b",
                y: 118,
                height: 42,
                fadeInFrames: 12,
              }),
              layer("intro-image", "Workspace", "image", {
                sceneId: "intro",
                from: 36,
                durationFrames: 264,
                assetId: "overview",
                x: 195,
                y: 194,
                width: 570,
                height: 316,
                fit: "contain",
                fadeInFrames: 18,
              }),
              layer("workflow-title", "Workflow title", "text", {
                sceneId: "workflow",
                text: "From scattered notes to a clear next step.",
                fontSize: 34,
                color: "#183a30",
                y: 42,
                height: 90,
                fadeInFrames: 15,
              }),
              layer("workflow-image", "Project board", "image", {
                sceneId: "workflow",
                from: 15,
                durationFrames: 285,
                assetId: "detail",
                x: 195,
                y: 160,
                width: 570,
                height: 316,
                fit: "contain",
                fadeInFrames: 15,
              }),
              layer("close-title", "Closing headline", "text", {
                sceneId: "close",
                text: "Make room for your best work.",
                fontSize: 48,
                color: "#f5f3ee",
                y: 130,
                height: 150,
                fadeInFrames: 20,
              }),
              layer("close-body", "Website", "text", {
                sceneId: "close",
                from: 30,
                durationFrames: 270,
                text: "fieldnote.example",
                fontSize: 30,
                color: "#b7d3c6",
                y: 320,
                height: 60,
                fadeInFrames: 15,
              }),
              layer("soundtrack", "Music", "audio", {
                durationFrames: 900,
                assetId: "music",
                gain: 0.3,
                fadeInFrames: 30,
                fadeOutFrames: 60,
              }),
            ],
      },
    ],
  };
}

const musicScript = `import {mkdir,writeFile,access} from 'node:fs/promises';
await mkdir('public/assets',{recursive:true});
try {await access('public/assets/music.wav');} catch {
  const rate=48000, count=rate*30, wav=Buffer.alloc(44+count*2);
  wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(rate,24);wav.writeUInt32LE(rate*2,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(count*2,40);
  const chords=[[130.81,164.81,196],[110,130.81,164.81],[87.31,110,130.81],[98,123.47,146.83]];
  for(let i=0;i<count;i++){const t=i/rate, beat=t%0.5, chord=chords[Math.floor(t/4)%4];const fade=Math.min(1,t/0.5,(30-t)/1.5);const pad=chord.reduce((sum,f)=>sum+Math.sin(2*Math.PI*f*t),0)/3;const pulse=Math.sin(2*Math.PI*chord[Math.floor(t*2)%3]*2*t)*Math.exp(-beat*9);wav.writeInt16LE(Math.round((pad*0.12+pulse*0.16)*fade*32767),44+i*2);}
  await writeFile('public/assets/music.wav',wav,{flag:'wx'});
}
`;

function screenshot(detail: boolean): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="500" viewBox="0 0 900 500"><rect width="900" height="500" rx="18" fill="#fff"/><rect width="190" height="500" rx="18" fill="#e3e9e5"/><g font-family="Arial" fill="#24483b"><text x="28" y="50" font-size="22" font-weight="700">Fieldnote</text><text x="28" y="118" font-size="17">My workspace</text><text x="28" y="165" font-size="17">Projects</text><text x="28" y="212" font-size="17">Notes</text><text x="228" y="62" font-size="28" font-weight="700">${detail ? "Product launch" : "Good morning, Alex"}</text><text x="228" y="104" font-size="17" fill="#6b7c73">${detail ? "One place for the whole team." : "Your work, with room to think."}</text></g><rect x="228" y="150" width="300" height="295" rx="10" fill="#f0f3f0"/><rect x="552" y="150" width="310" height="135" rx="10" fill="#eef2e4"/><rect x="552" y="310" width="310" height="135" rx="10" fill="#f4f0e8"/><g font-family="Arial" font-size="20" fill="#24483b"><text x="250" y="190">${detail ? "Ready to share" : "This week"}</text><text x="575" y="190">Design review</text><text x="575" y="350">Team notes</text></g><g stroke="#c3cec7" stroke-width="8" stroke-linecap="round"><path d="M250 230h240m-240 40h190m-190 40h220m-220 40h170"/><path d="M575 230h240M575 390h205"/></g></svg>`;
}

export function projectStarterFiles(
  template: ProjectTemplate,
): Readonly<Record<string, string>> {
  const project = starterProject(template),
    composition = project.compositions[0]!;
  const blank = template === "blank";
  const files: Record<string, string> = {
    "package.json":
      JSON.stringify(
        {
          name: "my-velocast-video",
          version: "0.1.0",
          private: true,
          type: "module",
          scripts: {
            build: blank
              ? "vite build"
              : "node scripts/prepare-media.mjs && vite build",
            studio:
              'npm run build && velocast studio --watch-command "vite build --watch"',
            render: `npm run build && velocast render ${composition.id} --output renders/${composition.id}.mp4`,
            frame: `npm run build && velocast frame ${composition.id} --frame 60 --output renders/frame.png`,
            verify: `velocast verify renders/${composition.id}.mp4 --expect-frames ${composition.durationFrames} --expect-fps 30${blank ? "" : " --expect-audio"}`,
          },
          dependencies: {
            "@velocast/core": "0.1.0",
            "@velocast/react": "0.1.0",
            react: "18.3.1",
            "react-dom": "18.3.1",
          },
          devDependencies: { velocast: "0.1.0", vite: "8.3.5" },
        },
        null,
        2,
      ) + "\n",
    "project.json": JSON.stringify(project, null, 2) + "\n",
    "velocast.config.ts":
      'import {defineConfig} from "velocast";\nexport default defineConfig({entry:"dist/index.html", inputPropsFile: "project.json", renderer:{snapshotRoot:"dist"}});\n',
    "vite.config.mjs": 'export default {base:"./"};\n',
    "index.html":
      '<!doctype html><html><head><meta charset="UTF-8"><title>Video project</title><style>html,body{margin:0;background:#111}</style></head><body><script type="module" src="/src/main.jsx"></script></body></html>\n',
    "src/main.jsx":
      'import {startVelocast,defineProjectCompositions} from "@velocast/react";\nimport project from "../project.json";\nstartVelocast(defineProjectCompositions(project));\n',
    ".gitignore": "node_modules/\ndist/\nrenders/\n.velocast/\n",
    ...(blank
      ? {}
      : {
          "scripts/prepare-media.mjs": musicScript,
          "public/assets/overview.svg": screenshot(false),
          "public/assets/detail.svg": screenshot(true),
        }),
    "README.md": `# ${project.name}

Run \`npm install\`, then \`npm run studio\`. Open the printed URL. Studio builds the project and follows completed changes; Ctrl+C stops its watcher and server.

Select scenes or layers in the timeline or on the canvas. Edit their text, placement, timing, or media in the inspector. Add images, video, narration, and music with Import media. Undo and redo use the running Studio's shared history. External file edits invalidate that history; reload after a conflict.

\`project.json\` is the saved source for Studio, scripts, and agents. Scene timing uses composition frames; layer timing is relative to its scene, or the composition when no scene is assigned. Ends are exclusive. Array order determines visual stacking. Audio gain, source trim, and fades use the same timing in playback and export.

Assets live in \`public/assets\`. Import copies media there. Replacing an asset changes the selected layer; copied files remain available for undo. The sample artwork and generated instrumental music may be replaced or reused freely.

Use Export in Studio or \`npm run render\`, then \`npm run verify\`. \`npm run frame\` exports frame 60. The config selects the same project file for every command. A working native renderer and Electron runtime are required for export; \`npx velocast doctor --json\` reports missing requirements.

For scripted access, read \`GET /api/capabilities\` at the running Studio URL. Independent clients can edit the JSON file, run \`npm run build\`, and use \`npx velocast compositions --json\`, \`frame\`, \`render\`, and \`verify\`. Use \`npx velocast capabilities --json\` for supported commands and constraints.

Custom React compositions can be registered alongside the project in \`src/main.jsx\`. Their code owns their visuals; the project editor edits the structured project layers.
`,
  };
  if (template === "editable-project") return files;
  delete files["project.json"];
  return { ...files, ...codeStarterFiles(blank) };
}

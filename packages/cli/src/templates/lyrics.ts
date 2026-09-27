export const LYRICS_STARTER_TEMPLATE_VERSION = 1;
export const LYRICS_STARTER_COMPOSITION_ID = "lyrics-starter";

const baseLyricsStarterFiles: Readonly<Record<string, string>> = Object.freeze({
  "package.json": `${JSON.stringify(
    {
      name: "velocast-lyrics-video",
      version: "0.1.0",
      private: true,
      type: "module",
      scripts: {
        build: "vite build",
        preview:
          'npm run build && velocast preview --watch-command "vite build --watch"',
        check:
          "velocast check lyrics-starter --assertions audit.assertions.json --snapshots audit-snapshots",
        render:
          "velocast render lyrics-starter --output renders/lyrics-starter.mp4",
        "import:lyrics": "velocast transcript import",
        "analyze:audio": "velocast analyze-audio",
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
  )}\n`,
  "velocast-template.json": `${JSON.stringify(
    {
      template: "lyrics",
      templateVersion: LYRICS_STARTER_TEMPLATE_VERSION,
      compositionId: LYRICS_STARTER_COMPOSITION_ID,
      width: 1920,
      height: 1080,
      fps: 60,
      durationFrames: 600,
    },
    null,
    2,
  )}\n`,
  ".gitignore":
    "node_modules/\ndist/\nrenders/\naudit-snapshots/\n.velocast/\n",
  "velocast.config.ts": `export default {
  entry: "dist/index.html",
  renderer: { snapshotRoot: "dist", acceleration: "auto" },
};
`,
  "vite.config.js": `export default { base: "./", build: { outDir: "dist", emptyOutDir: true } };\n`,
  "index.html": `<!doctype html>
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Lyrics starter</title></head>
<body><div id="composition"></div><script type="module" src="/src/main.jsx"></script></body></html>
`,
  "src/lyrics.json": `${JSON.stringify({ schemaVersion: 1, sourceFormat: "json", cues: [] }, null, 2)}\n`,
  "src/music-analysis.json": `${JSON.stringify({ schemaVersion: 1, energy: [], beatCandidates: [] }, null, 2)}\n`,
  "src/main.jsx": `import React from "react";
import { createMediaTimeline, registerReactComposition, useCurrentFrame, useInputProps, useVideoConfig } from "@velocast/react";
import timedText from "./lyrics.json";
import musicAnalysis from "./music-analysis.json";
import "./style.css";

const videoConfig = { width: 1920, height: 1080, fps: 60, durationFrames: __DURATION_FRAMES__ };
const audioSource = __AUDIO_SOURCE__;
const fadeInFrames = Math.min(30, Math.floor(videoConfig.durationFrames / 2));
const fadeOutFrames = Math.min(60, videoConfig.durationFrames - fadeInFrames);
const audio = audioSource
  ? createMediaTimeline(videoConfig, [{
      id: "music",
      kind: "audio",
      src: audioSource,
      durationFrames: videoConfig.durationFrames,
      fadeInFrames,
      fadeOutFrames,
    }]).audio
  : undefined;

function LyricsStarter() {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const { title, artist } = useInputProps();
  const seconds = frame / fps;
  const active = timedText.cues.find(cue => seconds >= cue.startSeconds && seconds < cue.endSeconds);
  const upcoming = timedText.cues.find(cue => cue.startSeconds > seconds);
  const nearbyOnset = musicAnalysis.beatCandidates
    .map(marker => ({ ...marker, distance: Math.abs(marker.timeSeconds - seconds) }))
    .filter(marker => marker.distance < 0.14)
    .sort((left, right) => left.distance - right.distance)[0];
  const onsetPulse = nearbyOnset ? nearbyOnset.strength * (1 - nearbyOnset.distance / 0.14) : 0;
  return (
    <main className="composition" style={{ width, height }}>
      <div className="onset-pulse" style={{ transform: "scale(" + (1 + onsetPulse * 0.35) + ")", opacity: 0.15 + onsetPulse * 0.45 }} aria-hidden="true" />
      <header><p className="artist">{artist}</p><h1>{title}</h1></header>
      <section className="lyrics" data-lyric-state={active ? "active" : "empty"}>
        <p className="active-line">{active?.text ?? ""}</p>
        <p className="upcoming-line">{upcoming?.text ?? ""}</p>
      </section>
      <footer>{frame} · {seconds.toFixed(2)}s</footer>
    </main>
  );
}

registerReactComposition("lyrics-starter", {
  component: LyricsStarter, target: "#composition", ...videoConfig, ...(audio ? { audio } : {}),
  defaultProps: { title: "Untitled track", artist: "" },
});
`,
  "src/style.css": `* { box-sizing: border-box; }
html, body { margin: 0; background: #0d1117; }
.composition { position: relative; overflow: hidden; padding: 96px 112px; color: #f6f7fb; background: radial-gradient(circle at 75% 20%, #25324a 0, #111827 40%, #090d14 100%); font-family: Inter, "Segoe UI", sans-serif; }
.onset-pulse { position: absolute; right: 120px; top: 110px; width: 260px; height: 260px; border-radius: 50%; background: #83a9ef; transform-origin: center; }
header { max-width: 920px; }
.artist { min-height: 1em; margin: 0 0 12px; color: #8da2c8; font-size: 28px; letter-spacing: .12em; text-transform: uppercase; }
h1 { margin: 0; font-size: 72px; line-height: 1.05; }
.lyrics { position: absolute; left: 112px; right: 112px; top: 430px; min-height: 360px; }
.active-line { margin: 0; max-width: 1500px; font-size: 88px; font-weight: 750; line-height: 1.15; letter-spacing: -.035em; }
.upcoming-line { margin: 38px 0 0; max-width: 1350px; color: #93a4bf; font-size: 46px; line-height: 1.25; }
footer { position: absolute; right: 112px; bottom: 72px; color: #6f809c; font: 24px/1 monospace; }
`,
  "audit.assertions.json": `${JSON.stringify(
    {
      selectors: [
        {
          selector: ".composition",
          visible: true,
          insideComposition: true,
          noClipping: true,
        },
        { selector: "h1", visible: true, insideComposition: true },
        { selector: ".lyrics", visible: true, insideComposition: true },
      ],
    },
    null,
    2,
  )}\n`,
  "input-props.json": `${JSON.stringify({ title: "Untitled track", artist: "" }, null, 2)}\n`,
  "README.md": `# Velocast lyrics starter

This starter contains no generated lyrics, transcription, beat claims, or remote assets. Replace \`src/lyrics.json\` only with supplied or verified timed text.

Run \`velocast skill install .\` to add the packaged external-agent workflow under this project's \`.agents/skills\` directory.

\`\`\`sh
npm install
npm run import:lyrics -- captions.srt --output src/lyrics.json --overwrite
npm run build
npm run check
npm run preview
npm run render
\`\`\`

Import accepts SRT, WebVTT, or the documented JSON cue shape. Its intervals use seconds and require \`0 <= startSeconds < endSeconds\`. The component selects cues from \`useCurrentFrame() / fps\`, so exact seeks and renders agree.

For real local audio, run \`npm run analyze:audio -- path/to/song.wav --output src/music-analysis.json --overwrite\`. Energy and onset candidates are measured from bounded FFmpeg-decoded PCM and drive the subtle onset pulse. They are aids for review, not verified beats, downbeats, meter, lyrics, or transcription. The explicit overwrite publishes complete JSON atomically so a build watcher never reads a partial file.

For a ready audio-backed project with verified duration and supplied cues, initialize again with \`velocast init <directory> --template lyrics --audio <local-audio> --lyrics <srt-vtt-or-json>\`. The starter deliberately does not point at an asset that was not supplied.
`,
});

export interface LyricsStarterTemplateOptions {
  durationFrames?: number;
  audioFileName?: string;
  musicAnalysis?: unknown;
  importedCueCount?: number;
}

export function createLyricsStarterFiles(
  options: LyricsStarterTemplateOptions = {},
): Readonly<Record<string, string>> {
  const durationFrames = options.durationFrames ?? 600;
  const audioSource = options.audioFileName
    ? `./${options.audioFileName}`
    : null;
  const files = {
    ...baseLyricsStarterFiles,
    "velocast-template.json": `${JSON.stringify(
      {
        template: "lyrics",
        templateVersion: LYRICS_STARTER_TEMPLATE_VERSION,
        compositionId: LYRICS_STARTER_COMPOSITION_ID,
        width: 1920,
        height: 1080,
        fps: 60,
        durationFrames,
        audio: options.audioFileName ?? null,
        importedCueCount: options.importedCueCount ?? 0,
      },
      null,
      2,
    )}\n`,
    "src/main.jsx": baseLyricsStarterFiles["src/main.jsx"]!.replace(
      "__DURATION_FRAMES__",
      String(durationFrames),
    ).replace("__AUDIO_SOURCE__", JSON.stringify(audioSource)),
    "src/music-analysis.json": `${JSON.stringify(
      options.musicAnalysis ?? {
        schemaVersion: 1,
        energy: [],
        beatCandidates: [],
      },
      null,
      2,
    )}\n`,
    "README.md": `${baseLyricsStarterFiles["README.md"]!}${
      options.audioFileName
        ? `\nThis project was initialized from supplied audio copied to \`public/${options.audioFileName}\`. Its ${durationFrames} frames and onset visualization were derived from that local source; review heuristic markers while listening.\n`
        : ""
    }`,
  };
  return Object.freeze(files);
}

export const lyricsStarterFiles = createLyricsStarterFiles();

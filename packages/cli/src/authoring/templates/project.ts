import { codeStarterFiles } from "./code.js";

export type ProjectTemplate = "product-demo" | "blank";

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
  const composition = {
    id: template === "blank" ? "video" : "product-demo",
    durationFrames: template === "blank" ? 300 : 900,
  };
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
    "index.html":
      '<!doctype html><html><head><meta charset="UTF-8"><title>Video project</title><style>html,body{margin:0;background:#111}</style></head><body><script type="module" src="/src/main.jsx"></script></body></html>\n',
    ".gitignore": "node_modules/\ndist/\nrenders/\n.velocast/\n",
    ...(blank
      ? {}
      : {
          "scripts/prepare-media.mjs": musicScript,
          "public/assets/overview.svg": screenshot(false),
          "public/assets/detail.svg": screenshot(true),
        }),
  };
  return { ...files, ...codeStarterFiles(blank) };
}

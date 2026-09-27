import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { createReactProject } from "./init-command.js";
import { installProjectSkill } from "./skill-install.js";
import { TEMPLATE_CATALOG } from "./template-catalog.js";

const roots: string[] = [];
const exec = promisify(execFile);
const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

it("generates a discoverable lyrics project with empty timed text and real workflow commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "velocast-lyrics-template-"));
  roots.push(root);
  const result = await createReactProject(join(root, "video"), {
    template: "lyrics",
  });
  expect(result).toMatchObject({
    template: "lyrics",
    compositionId: "lyrics-starter",
  });
  const cues = JSON.parse(
    await readFile(join(result.directory, "src/lyrics.json"), "utf8"),
  );
  expect(cues).toEqual({ schemaVersion: 1, sourceFormat: "json", cues: [] });
  const source = await readFile(join(result.directory, "src/main.jsx"), "utf8");
  expect(source).toContain("useCurrentFrame");
  expect(source).toContain(
    "seconds >= cue.startSeconds && seconds < cue.endSeconds",
  );
  const metadata = JSON.parse(
    await readFile(join(result.directory, "package.json"), "utf8"),
  );
  expect(metadata.scripts).toMatchObject({
    check: expect.stringContaining("velocast check"),
    "import:lyrics": expect.stringContaining("transcript import"),
    "analyze:audio": expect.stringContaining("analyze-audio"),
  });
  expect(
    TEMPLATE_CATALOG.find((item) => item.id === "lyrics")?.workflow,
  ).toContain("check");
});

it("builds the actual generated lyrics project with the workspace package sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "velocast-lyrics-build-"));
  roots.push(root);
  const result = await createReactProject(join(root, "video"), {
    template: "lyrics",
  });
  const slash = (value: string) => value.replaceAll("\\", "/");
  const testConfig = join(root, "vite.integration.config.mjs");
  const reactShim = join(root, "react-workspace-shim.ts");
  await writeFile(
    reactShim,
    `export * from ${JSON.stringify(slash(join(repositoryRoot, "packages/react/src/index.ts")))};
export function createMediaTimeline(config, clips, sampleRate = 48000) {
  return { audio: { version: 1, sampleRate, durationSamples: Math.round(config.durationFrames * sampleRate / config.fps), clips: [] }, Timeline: () => null };
}`,
  );
  await writeFile(
    testConfig,
    `export default {
      base: "./",
      build: { outDir: ${JSON.stringify(slash(join(result.directory, "dist")))}, emptyOutDir: true },
      resolve: { alias: [
        { find: "@velocast/react", replacement: ${JSON.stringify(slash(reactShim))} },
        { find: "@velocast/core", replacement: ${JSON.stringify(slash(join(repositoryRoot, "packages/core/src/index.ts")))} },
        { find: /^react$/, replacement: ${JSON.stringify(slash(join(repositoryRoot, "packages/react/node_modules/react/index.js")))} },
        { find: /^react-dom$/, replacement: ${JSON.stringify(slash(join(repositoryRoot, "packages/react/node_modules/react-dom/index.js")))} },
        { find: /^react-dom\\/client$/, replacement: ${JSON.stringify(slash(join(repositoryRoot, "packages/react/node_modules/react-dom/client.js")))} },
        { find: /^react\\/jsx-runtime$/, replacement: ${JSON.stringify(slash(join(repositoryRoot, "packages/react/node_modules/react/jsx-runtime.js")))} }
        ,{ find: /^react\\/jsx-dev-runtime$/, replacement: ${JSON.stringify(slash(join(repositoryRoot, "packages/react/node_modules/react/jsx-dev-runtime.js")))} }
      ] }
    };`,
  );
  const vite = join(
    repositoryRoot,
    "packages/preview/node_modules/vite/bin/vite.js",
  );
  await exec(
    process.execPath,
    [vite, "build", result.directory, "--config", testConfig],
    {
      cwd: repositoryRoot,
      timeout: 30_000,
    },
  );
  expect(
    await readFile(join(result.directory, "dist/index.html"), "utf8"),
  ).toContain('id="composition"');
});

it("creates an audio-backed lyrics project from real supplied media and timed text", async () => {
  const root = await mkdtemp(join(tmpdir(), "velocast-ready-lyrics-"));
  roots.push(root);
  const audio = join(root, "supplied.wav");
  const lyrics = join(root, "supplied.srt");
  await exec("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc=if(lt(mod(t\\,0.5)\\,0.06)\\,0.8*sin(2*PI*440*t)\\,0):s=11025:d=2",
    "-ac",
    "1",
    audio,
  ]);
  await writeFile(
    lyrics,
    "1\n00:00:00,000 --> 00:00:00,900\nSupplied first line\n\n2\n00:00:01,000 --> 00:00:01,900\nSupplied second line\n",
  );
  const result = await createReactProject(join(root, "video"), {
    template: "lyrics",
    audio,
    lyrics,
  });
  expect(result.suppliedMedia).toMatchObject({
    cueCount: 2,
    durationFrames: 120,
  });
  expect(result.files).toContain("public/audio.wav");
  expect(await readFile(join(result.directory, "public/audio.wav"))).toEqual(
    await readFile(audio),
  );
  const cues = JSON.parse(
    await readFile(join(result.directory, "src/lyrics.json"), "utf8"),
  );
  expect(cues.cues.map((cue: { text: string }) => cue.text)).toEqual([
    "Supplied first line",
    "Supplied second line",
  ]);
  const analysis = JSON.parse(
    await readFile(join(result.directory, "src/music-analysis.json"), "utf8"),
  );
  expect(analysis.source).toBe("public/audio.wav");
  expect(analysis.beatCandidates.length).toBeGreaterThanOrEqual(2);
  const source = await readFile(join(result.directory, "src/main.jsx"), "utf8");
  expect(source).toContain("createMediaTimeline(videoConfig");
  expect(source).toContain('const audioSource = "./audio.wav"');
  expect(source).toContain("durationFrames: 120");
});

it("installs a project-local agent skill and refuses to overwrite it", async () => {
  const root = await mkdtemp(join(tmpdir(), "velocast-skill-install-"));
  roots.push(root);
  await writeFile(join(root, "package.json"), "{}\n");
  const result = await installProjectSkill(root);
  expect(result.skillDirectory).toBe(
    join(root, ".agents", "skills", "velocast"),
  );
  const skill = await readFile(join(result.skillDirectory, "SKILL.md"), "utf8");
  expect(skill).toMatch(/^---\nname: velocast\n/);
  expect(skill).toContain("Create, inspect, repair, and render");
  expect(skill).toContain("never invent missing lyrics");
  await expect(installProjectSkill(root)).rejects.toThrow(
    "skill.target_exists",
  );
});

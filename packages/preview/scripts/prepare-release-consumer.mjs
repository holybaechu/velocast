import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const workspace = resolve(import.meta.dirname, "../../..");
const { browserProtocolVersion } = JSON.parse(
  await readFile(join(workspace, "contracts/renderer-protocol.json"), "utf8"),
);
const requested = process.env.VELOCAST_RELEASE_CONSUMER_ROOT;
const root = requested
  ? resolve(requested)
  : await mkdtemp(join(tmpdir(), "velocast-release-consumer-"));
if (requested) await mkdir(root);
const packages = join(root, "packages");
const project = join(root, "project");
const psLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;
await mkdir(packages);
await mkdir(project);
await mkdir(join(project, "dist"));

const pnpmExec = process.env.npm_execpath;
const pnpm = pnpmExec
  ? pnpmExec.endsWith(".exe")
    ? { command: pnpmExec, prefix: [] }
    : { command: process.execPath, prefix: [pnpmExec] }
  : { command: "pnpm", prefix: [] };
const run = (command, args, cwd = workspace) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status})\n${result.stdout}\n${result.stderr}`,
    );
  return result.stdout.trim();
};
const callPnpm = (args, cwd) =>
  run(pnpm.command, [...pnpm.prefix, ...args], cwd);

for (const name of ["@velocast/core", "@velocast/preview", "velocast"])
  callPnpm(["--filter", name, "build"]);
for (const name of ["@velocast/core", "@velocast/preview", "velocast"])
  callPnpm(["--filter", name, "pack", "--pack-destination", packages]);

const tarballs = (await readdir(packages))
  .filter((name) => name.endsWith(".tgz"))
  .sort();
if (tarballs.length !== 3)
  throw new Error(
    `expected three release tarballs, received ${tarballs.length}`,
  );
const audit = [];
for (const name of tarballs) {
  const path = join(packages, name);
  const bytes = await readFile(path);
  const entries = run("tar", ["-tf", path]).split(/\r?\n/).filter(Boolean);
  if (entries.some((entry) => /(^|\/)src\//.test(entry)))
    throw new Error(`${name} contains source-only paths`);
  audit.push({
    name,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    entries: entries.length,
  });
}
const preview = tarballs.find((name) => name.startsWith("velocast-preview-"));
if (!preview) throw new Error("preview tarball is missing");
const previewEntries = run("tar", ["-tf", join(packages, preview)]).split(
  /\r?\n/,
);
for (const required of [
  "package/dist/ui/index.html",
  "package/dist/ui/assets/app.js",
  "package/dist/ui/assets/app.css",
  "package/dist/platform/manifest.json",
  "package/dist/platform/bridge.js",
  "package/dist/platform/browser-runtime.js",
])
  if (!previewEntries.includes(required))
    throw new Error(`preview tarball is missing ${required}`);

await writeFile(
  join(project, "package.json"),
  JSON.stringify(
    { name: "velocast-release-consumer", private: true, type: "module" },
    null,
    2,
  ),
);
const npmCli = join(
  dirname(process.execPath),
  "node_modules/npm/bin/npm-cli.js",
);
run(process.execPath, [
  npmCli,
  "install",
  "--offline",
  "--ignore-scripts",
  "--prefix",
  project,
  ...tarballs.map((name) => join(packages, name)),
]);
await writeFile(
  join(project, "dist/index.html"),
  `<!doctype html><html><head><style>html,body,#root{margin:0;width:100%;height:100%}#root{display:grid;place-items:center;background:#11243a;color:white;font:700 28px sans-serif}</style></head><body><div id="root">boot</div><script>
(()=>{let session,props={};const root=document.querySelector('#root');window.__velocast={protocolVersion:${browserProtocolVersion},async beginSession(value){session={...value}},getSession(){return session},cancelPending(){},async getCompositions(){return [{id:'scene',width:320,height:180,fps:30,durationFrames:60,target:'#root'}]},async getDurationFrames(){return 60},async setInputProps(value){props=value||{}},async seekFrame(_id,frame){root.dataset.frame=String(frame);root.textContent=(props.label||'release')+' / '+frame;root.style.background=\`rgb(\${20+frame*2},\${40+frame},\${70+frame})\`},async getAudioPlan(){return null},async waitForReady(){},async destroy(){}}})();
</script></body></html>`,
);
await writeFile(
  join(project, "velocast.config.mjs"),
  `const binary=process.env.VELOCAST_RENDERER_BINARY;if(!binary)throw new Error("Set VELOCAST_RENDERER_BINARY");export default {entry:"dist/index.html",renderer:{snapshotRoot:"dist",binary,pixelFormat:"yuv420p"}};`,
);
await writeFile(join(project, "props.json"), '{"label":"release-consumer"}');
await copyFile(
  resolve(import.meta.dirname, "verify-official-preview.mjs"),
  join(root, "verify-official-preview.mjs"),
);
await writeFile(
  join(root, "run-gate.ps1"),
  `param([Parameter(Mandatory=$true)][string]$Renderer)\n$env:VELOCAST_RENDERER_BINARY=$Renderer\n$env:VELOCAST_PREVIEW_GATE_PROJECT=${psLiteral(project)}\n$env:VELOCAST_PREVIEW_GATE_CLI=${psLiteral(join(project, "node_modules/velocast/dist/bin.js"))}\nnode ${psLiteral(join(root, "verify-official-preview.mjs"))}\nexit $LASTEXITCODE\n`,
);
const installedPreview = resolve(
  project,
  "node_modules/@velocast/preview/dist/platform/manifest.json",
);
JSON.parse(await readFile(installedPreview, "utf8"));
const publicServer = await import(
  new URL(
    "./node_modules/velocast/dist/preview-server.js",
    `file:///${project.replaceAll("\\", "/")}/`,
  ).href
);
if (typeof publicServer.createPreviewServer !== "function")
  throw new Error("installed velocast/preview server export is missing");
const manifest = {
  schemaVersion: 1,
  status: "prepared-not-executed",
  purpose:
    "External release consumer harness; no public release or support manifest mutation",
  root,
  project,
  tarballs: audit,
  installedChecks: {
    previewPlatformManifest: installedPreview,
    publicPreviewServerExport: true,
    authoredFixture: "scene / 320x180 / 30fps / 60 frames",
  },
  run: `powershell -NoProfile -File ${psLiteral(join(root, "run-gate.ps1"))} -Renderer <prepared-runtime/velocast-renderer.exe>`,
};
await writeFile(
  join(root, "consumer-manifest.json"),
  JSON.stringify(manifest, null, 2),
);
console.log(JSON.stringify(manifest, null, 2));

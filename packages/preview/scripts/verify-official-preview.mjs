import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, appendFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

const projectPath = process.env.VELOCAST_PREVIEW_GATE_PROJECT;
const cliPath = process.env.VELOCAST_PREVIEW_GATE_CLI;
if (!projectPath || !cliPath)
  throw new Error(
    "Set VELOCAST_PREVIEW_GATE_PROJECT and VELOCAST_PREVIEW_GATE_CLI to an installed external consumer",
  );
const project = new URL(`file:///${resolve(projectPath).replaceAll("\\", "/")}/`);
const authoredPath = join(projectPath, "dist/index.html");
const authoredBefore = await readFile(authoredPath);
const cli = resolve(cliPath);
const config = process.env.VELOCAST_PREVIEW_GATE_CONFIG ??
  (existsSync(join(projectPath, "velocast.config.mjs"))
    ? "velocast.config.mjs"
    : "velocast.config.ts");
const server = spawn(process.execPath, [cli, "preview", "--config", config, "--port", "0", "--json", "--input-props-file", "props.json", "--output-directory", "../output"], {
  cwd: projectPath,
  env: { ...process.env, INIT_CWD: projectPath },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stderr.on("data", (chunk) => (serverLog += chunk));
const ready = await new Promise((resolve, reject) => {
  let text = "";
  const timer = setTimeout(() => reject(new Error(`CLI startup timeout\n${serverLog}`)), 15000);
  server.stdout.on("data", (chunk) => {
    text += chunk;
    const line = text.split(/\r?\n/).find((item) => item.trim().startsWith("{"));
    if (line) {
      clearTimeout(timer);
      resolve(JSON.parse(line));
    }
  });
  server.once("exit", (code) => reject(new Error(`CLI exited ${code}\n${serverLog}`)));
});

const profile = await mkdtemp(join(tmpdir(), "velocast-official-preview-"));
const chrome = spawn(process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", [
  "--headless=new", "--disable-gpu", "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
  "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${profile}`, ready.url,
], { stdio: "ignore" });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let socket;
try {
  let endpoint;
  for (let index = 0; index < 120; index += 1) {
    try {
      const [port] = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/);
      endpoint = `http://127.0.0.1:${port}`;
      break;
    } catch { await wait(50); }
  }
  if (!endpoint) throw new Error("Chrome did not start");
  const target = (await (await fetch(`${endpoint}/json/list`)).json()).find((item) => item.type === "page");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    pending.set(requestId, { resolve, reject });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const until = async (expression, label, attempts = 600) => {
    for (let index = 0; index < attempts; index += 1) {
      if (await evaluate(expression)) return;
      await wait(100);
    }
    const diagnostic = await evaluate(`({status:document.querySelector('[data-status]')?.textContent,error:document.querySelector('[data-error]')?.textContent,output:document.querySelector('[data-output]')?.textContent})`);
    throw new Error(`${label}: ${JSON.stringify(diagnostic)}\n${serverLog}`);
  };
  await call("Runtime.enable");
  await until(`document.querySelector('[data-status]')?.textContent==='Frame ready'`, "initial preview");
  await evaluate(`document.querySelector('[data-seek]').value='12';document.querySelector('[data-seek]').dispatchEvent(new Event('change',{bubbles:true}))`);
  await wait(100);
  await until(`document.querySelector('[data-status]').textContent==='Frame ready'&&document.querySelector('[data-frame]').textContent.includes('0012')`, "seek frame 12");
  await evaluate(`document.querySelector('[data-range-start]').value='10';document.querySelector('[data-range-end]').value='15';document.querySelector('[data-apply-range]').click()`);
  await wait(100);
  await until(`document.querySelector('[data-status]').textContent==='Frame ready'`, "range selection");
  await evaluate(`document.querySelector('[data-output-frame]').click()`);
  await until(`document.querySelector('[data-output] a')?.href.includes('/artifacts/')`, "native frame output");
  const frameUrl = await evaluate(`document.querySelector('[data-output] a').href`);
  const frame = new Uint8Array(await (await fetch(frameUrl)).arrayBuffer());
  if (frame.length < 100 || frame[0] !== 0x89 || frame[1] !== 0x50) throw new Error("frame artifact is not PNG");
  await evaluate(`document.querySelector('[data-output-range]').click()`);
  await until(`document.querySelector('[data-output] a')?.href.endsWith('.mp4')`, "native range output", 1200);
  const rangeUrl = await evaluate(`document.querySelector('[data-output] a').href`);
  const range = new Uint8Array(await (await fetch(rangeUrl)).arrayBuffer());
  if (range.length < 1000 || new TextDecoder().decode(range.slice(4, 12)).includes("ftyp") === false) throw new Error("range artifact is not MP4");
  const oldVersion = ready.session.sourceVersion;
  await appendFile(new URL("dist/index.html", project), "\n<!-- refreshed -->\n");
  await evaluate(`document.querySelector('[data-refresh]').click()`);
  await until(`document.querySelector('[data-source-version]').textContent!==${JSON.stringify(oldVersion.slice(0,16))}&&document.querySelector('[data-frame]').textContent.includes('0012')`, "source refresh");
  const next = await (await fetch(`${ready.url}/api/session`)).json();
  console.log(JSON.stringify({ officialCli: ready.url, installedPackages: true, initialSourceVersion: oldVersion, refreshedSourceVersion: next.session.sourceVersion, selectedFrame: 12, outputRange: [10,15], frameArtifact: { url: frameUrl, bytes: frame.length }, rangeArtifact: { url: rangeUrl, bytes: range.length }, browser: "Chrome headless" }, null, 2));
} finally {
  socket?.close();
  chrome.kill();
  server.kill();
  await wait(1000);
  await writeFile(authoredPath, authoredBefore);
  const ownedProfile = resolve(profile);
  if (ownedProfile.startsWith(resolve(tmpdir()) + sep) &&
      basename(ownedProfile).startsWith("velocast-official-preview-"))
    await rm(ownedProfile, { recursive: true, force: true }).catch(() => {});
}

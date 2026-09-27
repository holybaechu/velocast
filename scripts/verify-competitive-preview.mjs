import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createPreviewServer } from "../packages/cli/dist/preview-server.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const project = await mkdtemp(join(tmpdir(), "velocast-competitive-preview-"));
const dist = join(project, "dist");
await mkdir(dist);
await cp(join(root, "packages/core/dist"), join(dist, "core"), {
  recursive: true,
});
function html(label, broken = false, audio = false) {
  return `<!doctype html><style>body{margin:0;background:#fff}h1{color:#123;font:24px sans-serif;margin:20px}</style>
<h1 id="outside">Not part of the composition</h1>
<main id="composition"><h1 id="headline" data-velocast-source="src/scene.tsx:12"></h1></main>
<script type="module">
import { registerFrameAdapter } from './core/index.js';
registerFrameAdapter('demo', {id:'test',getDurationFrames:()=>60,
${audio ? "getAudioPlan:()=>({sampleRate:48000,durationSamples:96000,clips:[{source:'tone.wav',startSample:0,sourceStartSample:0,durationSamples:96000,gain:0.1}]})," : ""}
seekFrame(frame){
${broken ? "throw new Error('deliberate broken build');" : `document.querySelector('#headline').textContent = ${JSON.stringify(label)} + ' ' + frame;`}
}}, {width:320,height:180,fps:30,target:'#composition'});
</script>`;
}
const entry = join(dist, "index.html");
await writeFile(entry, html("original"));
const server = await createPreviewServer(
  { entry: "dist/index.html", renderer: { snapshotRoot: "dist" } },
  { pathOptions: { cwd: project, env: {} } },
);
const profile = join(project, "chrome-profile");
await mkdir(profile);
const chrome = spawn(
  process.env.CHROME_PATH ??
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  [
    "--headless=new",
    "--mute-audio",
    "--disable-gpu",
    "--no-first-run",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    server.url,
  ],
  { windowsHide: true, stdio: "ignore" },
);
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
let socket;
let chromeError;
chrome.once("error", (error) => {
  chromeError = error;
});
try {
  let endpoint;
  for (let i = 0; i < 150; i++) {
    if (chromeError) throw chromeError;
    try {
      const [port] = (
        await readFile(join(profile, "DevToolsActivePort"), "utf8")
      ).split(/\r?\n/);
      endpoint = `http://127.0.0.1:${port}`;
      break;
    } catch {
      await delay(100);
    }
  }
  assert.ok(endpoint, "Chrome must start");
  const target = (await (await fetch(endpoint + "/json/list")).json()).find(
    (item) => item.type === "page",
  );
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((yes, no) => {
    socket.addEventListener("open", yes, { once: true });
    socket.addEventListener("error", no, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    message.error
      ? waiter.no(new Error(message.error.message))
      : waiter.yes(message.result);
  });
  const call = (method, params = {}) =>
    new Promise((yes, no) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        no(new Error(`${method} timed out`));
      }, 15000);
      pending.set(id, { yes, no, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const value = await call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (value.exceptionDetails)
      throw new Error(
        value.exceptionDetails.exception?.description ??
          value.exceptionDetails.text,
      );
    return value.result.value;
  };
  const until = async (expression, message) => {
    for (let i = 0; i < 150; i++) {
      if (await evaluate(expression)) return;
      await delay(100);
    }
    throw new Error(
      `${message}: ${await evaluate("document.querySelector('[data-error]').textContent")}`,
    );
  };
  await until(
    "document.querySelector('[data-play]')?.disabled === false",
    "initial source loads",
  );
  assert.equal(
    await evaluate(
      "getComputedStyle(document.querySelector('iframe')).visibility",
    ),
    "visible",
  );
  assert.equal(
    await evaluate("document.querySelector('.empty-state').hidden"),
    true,
  );
  const initial = await evaluate(
    "document.querySelector('[data-source-version]').textContent",
  );
  await evaluate(
    "(()=>{document.querySelector('[data-range-start]').value='10';document.querySelector('[data-range-end]').value='40';document.querySelector('[data-apply-range]').click();})()",
  );
  await evaluate(
    "(()=>{const s=document.querySelector('[data-seek]');s.value='12';s.dispatchEvent(new Event('change',{bubbles:true}));})()",
  );
  await until(
    "document.querySelector('[data-frame]').textContent.includes('0012')",
    "seek presents frame 12",
  );
  await evaluate("document.querySelector('[data-inspect]').click()");
  await until(
    "document.querySelector('[data-inspection]').textContent.includes('original 12')",
    "inspection reads actual DOM",
  );
  const inspection = JSON.parse(
    await evaluate("document.querySelector('[data-inspection]').textContent"),
  );
  assert.equal(inspection.source, "src/scene.tsx:12");
  assert.equal(inspection.styles.color, "rgb(17, 34, 51)");
  assert.ok(inspection.bounds.width > 0);
  await writeFile(entry, html("updated"));
  await until(
    `document.querySelector('[data-source-version]').textContent !== ${JSON.stringify(initial)}`,
    "automatic source refresh",
  );
  await until(
    "document.querySelector('[data-frame]').textContent.includes('0012') && !document.querySelector('[data-play]').disabled",
    "refresh preserves selected frame",
  );
  await evaluate("document.querySelector('[data-inspect]').click()");
  await until(
    "document.querySelector('[data-inspection]').textContent.includes('updated 12')",
    "new source renders",
  );
  assert.deepEqual(
    await evaluate(
      "[document.querySelector('[data-range-start]').value,document.querySelector('[data-range-end]').value]",
    ),
    ["10", "40"],
  );
  const valid = await evaluate(
    "document.querySelector('[data-source-version]').textContent",
  );
  await writeFile(entry, html("broken", true));
  await until(
    "document.querySelector('[data-error]').textContent.includes('deliberate broken build')",
    "broken build is visible",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('[data-source-version]').textContent",
    ),
    valid,
  );
  assert.ok(server.session().session.sourceVersion.startsWith(valid));
  await evaluate("document.querySelector('[data-inspect]').click()");
  await until(
    "document.querySelector('[data-inspection]').textContent.includes('updated 12')",
    "last valid source remains inspectable",
  );
  await writeFile(entry, html("recovered"));
  await until(
    `document.querySelector('[data-source-version]').textContent !== ${JSON.stringify(valid)}`,
    "later valid build recovers",
  );
  await until(
    "!document.querySelector('[data-play]').disabled",
    "recovery ready",
  );
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await evaluate("document.querySelector('[data-inspect]').click()");
  await until(
    "document.querySelector('[data-inspection]').textContent.includes('recovered 12')",
    "recovered frame and inspection",
  );
  const beforeRemote = server.session();
  await writeFile(entry, html("another-tab"));
  const externalRefresh = await fetch(server.url + "/api/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expectedSourceVersion: beforeRemote.session.sourceVersion,
    }),
  });
  assert.equal(externalRefresh.status, 200);
  await until(
    `document.querySelector('[data-source-version]').textContent === ${JSON.stringify(server.session().session.sourceVersion.slice(0, 16))} && !document.querySelector('[data-play]').disabled`,
    "resynchronize after another tab commits",
  );
  await evaluate("document.querySelector('[data-inspect]').click()");
  await until(
    "document.querySelector('[data-inspection]').textContent.includes('another-tab 12')",
    "other tab source is inspectable",
  );
  const beforeAudio = server.session();
  await writeFile(join(dist, "tone.wav"), "corrupt authored audio");
  await writeFile(entry, html("audio-ready", false, true));
  await until(
    "!document.querySelector('[data-error]').hidden && document.querySelector('[data-error]').textContent.toLowerCase().includes('decode')",
    "invalid candidate audio is rejected before committing",
  );
  assert.equal(
    server.session().session.sessionId,
    beforeAudio.session.sessionId,
  );
  await evaluate("document.querySelector('[data-inspect]').click()");
  await until(
    "document.querySelector('[data-inspection]').textContent.includes('another-tab 12')",
    "failed audio retains working picture",
  );
  const wav = Buffer.alloc(44 + 96000 * 2);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48000, 24);
  wav.writeUInt32LE(96000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(96000 * 2, 40);
  for (let i = 0; i < 96000; i++)
    wav.writeInt16LE(
      Math.round(Math.sin((i * Math.PI * 2 * 440) / 48000) * 3000),
      44 + i * 2,
    );
  await writeFile(join(dist, "tone.wav"), wav);
  await until(
    `document.querySelector('[data-source-version]').textContent !== ${JSON.stringify(beforeAudio.session.sourceVersion.slice(0, 16))} && !document.querySelector('[data-play]').disabled`,
    "corrected audio build recovers",
  );
  await evaluate("document.querySelector('[data-inspect]').click()");
  await until(
    "document.querySelector('[data-inspection]').textContent.includes('audio-ready 12')",
    "validated candidate audio and selected frame publish together",
  );
  assert.equal(
    await evaluate(
      "getComputedStyle(document.querySelector('iframe')).visibility",
    ),
    "visible",
  );
  const capture = await call("Page.captureScreenshot", { format: "png" });
  await writeFile(
    join(project, "preview.png"),
    Buffer.from(capture.data, "base64"),
  );
  await writeFile(
    join(project, "result.json"),
    JSON.stringify(
      {
        status: "PASS",
        checks: [
          "initial load",
          "frame seek",
          "element bounds/styles/source",
          "auto refresh",
          "selection preserved",
          "failed build retained old source",
          "recovered build",
          "composition-scoped inspection",
          "other preview client resynchronization",
          "invalid candidate audio retained old source",
          "corrected audio recovers",
        ],
        screenshot: join(project, "preview.png"),
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ status: "PASS", evidence: project }));
} finally {
  socket?.close();
  await server.close();
  if (chrome.exitCode === null) {
    const stopped = new Promise((done) => chrome.once("close", done));
    chrome.kill();
    await stopped;
  }
  // Remove only the owned browser profile; keep verification evidence.
  assert.equal(resolve(profile), join(project, "chrome-profile"));
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}

import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createStudioServer } from "../../packages/cli/dist/studio/studio-server.js";
import {
  cleanupBrowserResources,
  launchCdpBrowser,
} from "../../packages/cli/dist/media/browser-cdp.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const project = await mkdtemp(join(tmpdir(), "velocast-studio-source-"));
const dist = join(project, "dist");
function html(label, broken = false, audio = false) {
  return `<!doctype html><style>body{margin:0;background:#fff}h1{color:#123;font:24px sans-serif;margin:20px}</style>
<h1 id="outside">Not part of the composition</h1><main id="composition"><h1 id="headline"></h1></main>
<script type="module">
import { registerFrameAdapter } from './core/index.js';
registerFrameAdapter('demo', {id:'test',getDurationFrames:()=>60,
${audio ? "getAudioPlan:()=>({sampleRate:48000,durationSamples:96000,clips:[{source:'tone.wav',startSample:0,sourceStartSample:0,durationSamples:96000,gain:0.1}]})," : ""}
seekFrame(frame){
${broken ? "throw new Error('deliberate broken build');" : `document.querySelector('#headline').textContent = ${JSON.stringify(label)} + ' ' + frame;`}
}}, {width:320,height:180,fps:30,target:'#composition'});
</script>`;
}
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const activeSource =
  "Array.from(document.querySelectorAll('[data-stage] iframe')).find(frame=>getComputedStyle(frame).visibility==='visible')?.src";
let server;
let browser;
let primary;
try {
  await mkdir(dist);
  await cp(join(root, "packages/core/dist"), join(dist, "core"), {
    recursive: true,
  });
  const entry = join(dist, "index.html");
  await writeFile(entry, html("original"));
  server = await createStudioServer(
    { entry: "dist/index.html", renderer: { snapshotRoot: "dist" } },
    { pathOptions: { cwd: project, env: {} } },
  );
  browser = await launchCdpBrowser(server.url);
  const evaluate = (expression) => browser.evaluate(expression);
  const until = async (condition, label) => {
    let lastError;
    for (let attempt = 0; attempt < 150; attempt++) {
      try {
        if (
          await (typeof condition === "string"
            ? evaluate(condition)
            : condition())
        )
          return;
      } catch (error) {
        lastError = error;
      }
      await delay(100);
    }
    throw new Error(
      `${label}: ${await evaluate("document.querySelector('[data-error]')?.textContent")} ${lastError?.message ?? ""}`,
    );
  };
  const frameState = async () => {
    const src = await evaluate(activeSource);
    const { frameTree } = await browser.call("Page.getFrameTree");
    const find = (tree) =>
      tree.frame.url === src
        ? tree.frame
        : tree.childFrames?.map(find).find(Boolean);
    const frame = find(frameTree);
    if (!frame) return undefined;
    const { executionContextId } = await browser.call(
      "Page.createIsolatedWorld",
      { frameId: frame.id, worldName: "velocast-source-verification" },
    );
    const result = await browser.call("Runtime.evaluate", {
      contextId: executionContextId,
      returnByValue: true,
      expression:
        "(()=>{const root=document.querySelector('#composition'),title=root?.querySelector('#headline');return title?{text:title.textContent,color:getComputedStyle(title).color,width:title.getBoundingClientRect().width,outsideInside:!!root.querySelector('#outside')}:null})()",
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const shows = (text) =>
    until(
      async () => (await frameState())?.text === text,
      `composition shows ${text}`,
    );
  const synced = () =>
    until(
      async () =>
        (await evaluate(activeSource)) === server.session().snapshotUrl &&
        (await evaluate("!document.querySelector('[data-play]').disabled")),
      "visible composition matches published source",
    );

  await until(
    "document.querySelector('[data-play]')?.disabled === false",
    "initial source loads",
  );
  await synced();
  assert.equal(
    await evaluate("document.querySelector('.empty-state').hidden"),
    true,
  );
  await evaluate(
    "(()=>{document.querySelector('[data-range-start]').value='10';document.querySelector('[data-range-end]').value='40';document.querySelector('[data-apply-range]').click();})()",
  );
  await evaluate(
    "(()=>{const s=document.querySelector('[data-seek]');s.value='12';s.dispatchEvent(new Event('change',{bubbles:true}));})()",
  );
  await shows("original 12");
  const rendered = await frameState();
  assert.equal(rendered.color, "rgb(17, 34, 51)");
  assert.ok(rendered.width > 0);
  assert.equal(rendered.outsideInside, false);
  const initial = server.session();

  await writeFile(entry, html("updated"));
  await shows("updated 12");
  await synced();
  assert.notEqual(
    server.session().session.sourceVersion,
    initial.session.sourceVersion,
  );
  assert.deepEqual(
    await evaluate(
      "[document.querySelector('[data-range-start]').value,document.querySelector('[data-range-end]').value]",
    ),
    ["10", "40"],
  );
  const valid = server.session();
  await writeFile(entry, html("broken", true));
  await until(
    "document.querySelector('[data-error]').textContent.includes('deliberate broken build')",
    "broken source is reported",
  );
  assert.equal(
    server.session().session.sourceVersion,
    valid.session.sourceVersion,
  );
  assert.equal(await evaluate(activeSource), valid.snapshotUrl);
  await shows("updated 12");

  await writeFile(entry, html("recovered"));
  await shows("recovered 12");
  await synced();
  assert.notEqual(
    server.session().session.sourceVersion,
    valid.session.sourceVersion,
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
  await shows("another-tab 12");
  await synced();

  const beforeAudio = server.session();
  await writeFile(join(dist, "tone.wav"), "corrupt authored audio");
  await writeFile(entry, html("audio-ready", false, true));
  await until(
    "!document.querySelector('[data-error]').hidden && document.querySelector('[data-error]').textContent.toLowerCase().includes('decode')",
    "invalid candidate audio is rejected",
  );
  assert.equal(
    server.session().session.sessionId,
    beforeAudio.session.sessionId,
  );
  assert.equal(await evaluate(activeSource), beforeAudio.snapshotUrl);
  await shows("another-tab 12");
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
  await shows("audio-ready 12");
  await synced();
  assert.notEqual(
    server.session().session.sourceVersion,
    beforeAudio.session.sourceVersion,
  );
  console.log(
    JSON.stringify({
      status: "PASS",
      checks: [
        "composition DOM and exact frame",
        "automatic source refresh",
        "frame and range preserved",
        "failed source retained working frame",
        "recovery",
        "another client refresh",
        "invalid candidate audio retained working frame",
        "corrected audio published with selected frame",
      ],
    }),
  );
} catch (error) {
  primary = { error };
  throw error;
} finally {
  await cleanupBrowserResources(
    [
      async () => browser?.close(),
      async () => server?.close(),
    ],
    primary,
  );
  assert.equal(dirname(resolve(project)), resolve(tmpdir()));
  assert.ok(basename(project).startsWith("velocast-studio-source-"));
  await rm(project, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}

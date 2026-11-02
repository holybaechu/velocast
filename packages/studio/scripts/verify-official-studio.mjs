import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, appendFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const projectPath = process.env.VELOCAST_STUDIO_GATE_PROJECT;
const cliPath = process.env.VELOCAST_STUDIO_GATE_CLI;
if (!projectPath || !cliPath)
  throw new Error(
    "Set VELOCAST_STUDIO_GATE_PROJECT and VELOCAST_STUDIO_GATE_CLI to an installed external consumer",
  );
const cli = resolve(cliPath);
// Use the same installed CLI's browser transport and process ownership rules.
const { launchCdpBrowser, stopBrowser, cleanupBrowserResources } = await import(
  pathToFileURL(join(dirname(cli), "media/browser-cdp.js")).href
);
const { terminateRendererProcess } = await import(
  pathToFileURL(join(dirname(cli), "render/renderer-process.js")).href
);
const authoredPath = join(projectPath, "dist/index.html");
const authoredBefore = await readFile(authoredPath);
const config =
  process.env.VELOCAST_STUDIO_GATE_CONFIG ??
  (existsSync(join(projectPath, "velocast.config.mjs"))
    ? "velocast.config.mjs"
    : "velocast.config.ts");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let server;
let browser;
let serverStopped;
let studioStarted = false;
let primary;
let serverLog = "";
try {
  server = spawn(
    process.execPath,
    [
      cli,
      "studio",
      "--config",
      config,
      "--port",
      "0",
      "--json",
      "--input-props-file",
      "props.json",
      "--output-directory",
      "output",
    ],
    {
      cwd: projectPath,
      env: { ...process.env, INIT_CWD: projectPath },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      detached: process.platform !== "win32",
    },
  );
  serverStopped = new Promise((done) => {
    server.once("exit", done);
    server.once("error", done);
  });
  server.on("message", (message) => {
    if (message?.type === "velocast.studio.starting") studioStarted = true;
  });
  server.stderr.on("data", (chunk) => (serverLog += chunk));
  const ready = await new Promise((resolveReady, reject) => {
    let text = "";
    const finish = (error, value) => {
      clearTimeout(timer);
      server.stdout.removeListener("data", onData);
      server.removeListener("error", onError);
      server.removeListener("close", onClose);
      error ? reject(error) : resolveReady(value);
    };
    const onError = (error) => finish(error);
    const onClose = (code) =>
      finish(new Error(`CLI exited ${code}\n${serverLog}`));
    const onData = (chunk) => {
      text += chunk;
      const lines = text.split(/\r?\n/);
      // A stdout chunk can end halfway through the readiness JSON.
      const line = lines
        .slice(0, -1)
        .find((item) => item.trim().startsWith("{"));
      if (line) {
        try {
          finish(undefined, JSON.parse(line));
        } catch (error) {
          finish(error);
        }
      }
    };
    const timer = setTimeout(
      () => finish(new Error(`CLI startup timeout\n${serverLog}`)),
      15000,
    );
    server.stdout.on("data", onData);
    server.once("error", onError);
    server.once("close", onClose);
  });
  browser = await launchCdpBrowser(ready.url);
  const call = (method, params) => browser.call(method, params);
  const evaluate = (expression) => browser.evaluate(expression);
  const activeSource =
    "Array.from(document.querySelectorAll('[data-stage] iframe')).find(frame=>getComputedStyle(frame).visibility==='visible')?.src";
  const assertCompositionFrame = async (expected) => {
    const src = await evaluate(activeSource);
    const { frameTree } = await call("Page.getFrameTree");
    const find = (tree) =>
      tree.frame.url === src
        ? tree.frame
        : tree.childFrames?.map(find).find(Boolean);
    const frame = find(frameTree);
    if (!frame) throw new Error("Visible composition frame is missing");
    const { executionContextId } = await call("Page.createIsolatedWorld", {
      frameId: frame.id,
      worldName: "velocast-output-verification",
    });
    const result = await call("Runtime.evaluate", {
      contextId: executionContextId,
      returnByValue: true,
      expression: "document.querySelector('#root')?.dataset.frame",
    });
    if (result.exceptionDetails || result.result.value !== String(expected))
      throw new Error(`Composition DOM did not commit frame ${expected}`);
  };
  const until = async (expression, label, attempts = 600) => {
    for (let index = 0; index < attempts; index += 1) {
      if (await evaluate(expression)) return;
      await wait(100);
    }
    const diagnostic = await evaluate(
      `({status:document.querySelector('[data-status]')?.textContent,error:document.querySelector('[data-error]')?.textContent,output:document.querySelector('[data-output]')?.textContent})`,
    );
    throw new Error(`${label}: ${JSON.stringify(diagnostic)}\n${serverLog}`);
  };
  await call("Runtime.enable");
  await until(
    `document.querySelector('[data-status]')?.textContent==='Frame ready'`,
    "initial studio",
  );
  await evaluate(
    `document.querySelector('[data-seek]').value='12';document.querySelector('[data-seek]').dispatchEvent(new Event('change',{bubbles:true}))`,
  );
  await wait(100);
  await until(
    `document.querySelector('[data-status]').textContent==='Frame ready'&&document.querySelector('[data-frame]').textContent.includes('0012')`,
    "seek frame 12",
  );
  await assertCompositionFrame(12);
  await evaluate(
    `document.querySelector('[data-range-start]').value='10';document.querySelector('[data-range-end]').value='15';document.querySelector('[data-apply-range]').click()`,
  );
  await wait(100);
  await until(
    `document.querySelector('[data-status]').textContent==='Frame ready'`,
    "range selection",
  );
  await evaluate(`document.querySelector('[data-output-frame]').click()`);
  await until(
    `document.querySelector('[data-output] a')?.href.includes('/artifacts/')`,
    "native frame output",
  );
  const frameUrl = await evaluate(
    `document.querySelector('[data-output] a').href`,
  );
  const frame = new Uint8Array(await (await fetch(frameUrl)).arrayBuffer());
  if (frame.length < 100 || frame[0] !== 0x89 || frame[1] !== 0x50)
    throw new Error("frame artifact is not PNG");
  await evaluate(`document.querySelector('[data-output-range]').click()`);
  await until(
    `document.querySelector('[data-output] a')?.href.endsWith('.mp4')`,
    "native range output",
    1200,
  );
  const rangeUrl = await evaluate(
    `document.querySelector('[data-output] a').href`,
  );
  const range = new Uint8Array(await (await fetch(rangeUrl)).arrayBuffer());
  if (
    range.length < 1000 ||
    new TextDecoder().decode(range.slice(4, 12)).includes("ftyp") === false
  )
    throw new Error("range artifact is not MP4");
  const oldVersion = ready.session.sourceVersion;
  const oldSource = await evaluate(activeSource);
  await appendFile(authoredPath, "\n<!-- refreshed -->\n");
  await evaluate(`document.querySelector('[data-refresh]').click()`);
  await until(
    `(${activeSource})!==${JSON.stringify(oldSource)}&&document.querySelector('[data-status]').textContent==='Frame ready'&&document.querySelector('[data-frame]').textContent.includes('0012')`,
    "source refresh",
  );
  const next = await (await fetch(`${ready.url}/api/session`)).json();
  if (
    next.session.sourceVersion === oldVersion ||
    (await evaluate(activeSource)) !== next.snapshotUrl
  )
    throw new Error("Studio did not publish the refreshed source session");
  await assertCompositionFrame(12);
  console.log(
    JSON.stringify(
      {
        officialCli: ready.url,
        installedPackages: true,
        initialSourceVersion: oldVersion,
        refreshedSourceVersion: next.session.sourceVersion,
        selectedFrame: 12,
        outputRange: [10, 15],
        frameArtifact: { url: frameUrl, bytes: frame.length },
        rangeArtifact: { url: rangeUrl, bytes: range.length },
        browser: "Chrome headless",
      },
      null,
      2,
    ),
  );
} catch (error) {
  primary = { error };
  throw error;
} finally {
  await cleanupBrowserResources(
    [
      async () => {
        await browser?.close();
      },
      async () => {
        if (server) {
          // Disconnect asks studio to cancel and join detached native work on every OS.
          if (server.connected) server.disconnect();
          if (!studioStarted) {
            let timer;
            try {
              await Promise.race([
                serverStopped,
                new Promise((done) => {
                  timer = setTimeout(done, 5000);
                }),
              ]);
            } finally {
              clearTimeout(timer);
            }
            // Before studio starts there is no native work to reap. A stalled
            // config import can be terminated without interrupting owned cleanup.
            if (!studioStarted)
              await terminateRendererProcess(
                server,
                { cause: "abort", escalate: () => {} },
                0,
              );
          }
          await serverStopped;
          await stopBrowser(server);
        }
        await writeFile(authoredPath, authoredBefore);
      },
    ],
    primary,
  );
}

import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const packageRoot = resolve(import.meta.dirname, "..");
const dist = resolve(
  process.env.VELOCAST_STUDIO_DIST || join(packageRoot, "dist"),
);
const { browserProtocolVersion } = JSON.parse(
  await readFile(join(dist, "platform/manifest.json"), "utf8"),
);
const chromePath =
  process.env.CHROME_PATH ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
};
const contentType = (path) =>
  mime[Object.keys(mime).find((key) => path.endsWith(key))] ||
  "application/octet-stream";
const listen = (handler) =>
  new Promise((resolveListen) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolveListen(server));
  });
const origin = (server) => `http://127.0.0.1:${server.address().port}`;
const body = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
};
const send = (response, status, value, type = "application/json") => {
  response.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
  });
  response.end(type === "application/json" ? JSON.stringify(value) : value);
};

let parentOrigin;
let changedRevision;
let changeObservations = 0;
let changeError = false;
let selectionWaiting = false;
let frameWaiting = false;
let changesReleased = Promise.withResolvers();
const selectionReleased = Promise.withResolvers();
let frameReleased = Promise.withResolvers();
const child = await listen(async (request, response) => {
  const path = new URL(request.url, "http://fixture").pathname;
  if (path === "/hold-frame") {
    frameWaiting = true;
    await frameReleased.promise;
    send(response, 200, {});
    return;
  }
  if (path === "/hold-selection") {
    selectionWaiting = true;
    await selectionReleased.promise;
    send(response, 200, {});
    return;
  }
  if (path === "/") {
    send(
      response,
      200,
      `<!doctype html><html><head><style>html,body,#root{margin:0;width:100%;height:100%}#root{display:grid;place-items:center;background:#13263b;color:#fff;font:700 28px sans-serif}</style></head><body><div id="root">boot</div><script>
      (()=>{let session; const root=document.querySelector('#root'); window.__velocast={protocolVersion:${browserProtocolVersion},
      async beginSession(value){session={...value}},getSession(){return session},cancelPending(){},
      async getCompositions(){return ['scene','other'].map(id=>({id,width:320,height:180,fps:30,durationFrames:60,target:'#root'}))},
      async getDurationFrames(){return 60},async setInputProps(value){root.dataset.label=value?.label||''},
      async seekFrame(_id,frame){if(_id==='other')await fetch('/hold-selection');root.dataset.frame=String(frame);root.textContent=(root.dataset.label||'scene')+' / '+frame;if(frame===1){const later=document.createElement('span');later.id='only-frame-one';later.textContent='frame one';root.appendChild(later)}root.style.width=frame===1?'100px':'320px';if(frame===1)await fetch('/hold-frame')},
      async getAudioPlan(){return null},async waitForReady(){},async destroy(){root.dataset.destroyed='true'}}})();
      </script><script type="module" src="/__velocast-studio/bridge.js"></script></body></html>`,
      "text/html",
    );
    return;
  }
  if (path === "/__velocast-studio/config.js") {
    send(
      response,
      200,
      `export const studioConfig=${JSON.stringify({ parentOrigin })};`,
      "text/javascript",
    );
    return;
  }
  if (path.startsWith("/__velocast-studio/")) {
    const name = path.slice("/__velocast-studio/".length);
    try {
      send(
        response,
        200,
        await readFile(join(dist, "platform", name)),
        contentType(name),
      );
    } catch {
      send(response, 404, "missing", "text/plain");
    }
    return;
  }
  send(response, 404, "missing", "text/plain");
});

let source = 1;
const outputs = [];
const jobs = new Map();
let cancellations = 0;
const parent = await listen(async (request, response) => {
  const path = new URL(request.url, "http://fixture").pathname;
  if (path === "/api/changes") {
    if (changedRevision && ++changeObservations === 2) {
      await changesReleased.promise;
      if (changeError) {
        send(response, 500, { error: "fixture changes failure" });
        return;
      }
    }
    send(response, 200, {
      enabled: true,
      revision: changedRevision ?? `revision-${source}`,
    });
    return;
  }
  if (path === "/api/session" || path === "/api/refresh") {
    if (path === "/api/refresh") {
      const requestBody = await body(request);
      if (requestBody.expectedSourceVersion !== `source-${source}`) {
        send(response, 409, { error: "source version is stale" });
        return;
      }
      source += 1;
    }
    send(response, 200, {
      snapshotUrl: `${origin(child)}/?source=${source}`,
      session: {
        sessionId: `session-${source}`,
        sourceVersion: `source-${source}`,
      },
      inputProps: { label: `source-${source}` },
      sourceRevision: `revision-${source}`,
      autoRefresh: true,
    });
    return;
  }
  if (path === "/api/inputs") {
    send(response, 200, { enabled: false });
    return;
  }
  if (path === "/api/code") {
    send(response, 200, {
      enabled: false,
      compositionId: new URL(request.url, "http://fixture").searchParams.get(
        "compositionId",
      ),
      elements: [],
      canUndo: false,
      canRedo: false,
    });
    return;
  }
  if (path === "/api/jobs" && request.method === "POST") {
    const requestBody = await body(request);
    if (requestBody.expectedSourceVersion !== `source-${source}`) {
      send(response, 409, { error: "source version is stale" });
      return;
    }
    outputs.push(requestBody);
    const timestamp = new Date().toISOString();
    const record = {
      id: `job-${outputs.length}`,
      status: "running",
      request: requestBody,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const done = new Promise((resolveDone) =>
      setTimeout(() => {
        record.updatedAt = new Date().toISOString();
        if (record.status === "cancelling") {
          record.status = "cancelled";
          record.error = {
            code: "studio.cancelled",
            message: "Fixture job cleanup completed",
          };
        } else {
          record.status = "succeeded";
          record.result = {
            outputPath:
              requestBody.frame === undefined
                ? `range-${requestBody.range.start}-${requestBody.range.end}.mp4`
                : `frame-${requestBody.frame}.png`,
          };
        }
        resolveDone();
      }, 180),
    );
    jobs.set(record.id, { record, done });
    send(response, 202, record);
    return;
  }
  if (path === "/api/jobs" && request.method === "GET") {
    send(response, 200, {
      jobs: [...jobs.values()].map(({ record }) => record),
    });
    return;
  }
  const jobPath = /^\/api\/jobs\/([^/]+)(\/cancel)?$/.exec(path);
  if (jobPath) {
    const job = jobs.get(jobPath[1]);
    if (!job) {
      send(response, 404, {
        code: "studio.job_not_found",
        message: "Fixture job missing",
      });
      return;
    }
    if (request.method === "POST" && jobPath[2]) {
      if (job.record.status === "running") {
        cancellations += 1;
        job.record.status = "cancelling";
        job.record.updatedAt = new Date().toISOString();
      }
      await job.done;
      send(response, 200, job.record);
      return;
    }
    if (request.method !== "GET" || jobPath[2]) {
      send(response, 405, {
        code: "studio.method",
        message: "Unsupported fixture method",
      });
      return;
    }
    send(response, 200, job.record);
    return;
  }
  const relative = path === "/" ? "ui/index.html" : `ui/${path.slice(1)}`;
  try {
    const content = await readFile(join(dist, relative));
    send(response, 200, content, contentType(relative));
  } catch {
    send(response, 404, "missing", "text/plain");
  }
});
parentOrigin = origin(parent);

const profile = await mkdtemp(join(tmpdir(), "velocast-studio-chrome-"));
const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--disable-gpu",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--no-first-run",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    parentOrigin,
  ],
  { stdio: "ignore" },
);

let socket;
let nextId = 0;
const pending = new Map();
const wait = (milliseconds) =>
  new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
try {
  let endpoint;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const [port, token] = (
        await readFile(join(profile, "DevToolsActivePort"), "utf8")
      )
        .trim()
        .split(/\r?\n/);
      endpoint = `http://127.0.0.1:${port}`;
      if (token) break;
    } catch {}
    await wait(50);
  }
  if (!endpoint) throw new Error("Chrome DevTools endpoint did not start");
  let target;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const targets = await (await fetch(`${endpoint}/json/list`)).json();
    target = targets.find((item) => item.type === "page");
    if (target) break;
    await wait(50);
  }
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  const call = (method, params = {}) =>
    new Promise((resolveCall, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve: resolveCall, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const until = async (expression, message) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (
        await (typeof expression === "function"
          ? expression()
          : evaluate(expression))
      )
        return;
      await wait(50);
    }
    throw new Error(message);
  };

  await call("Runtime.enable");
  await until(
    `document.querySelector('[data-status]')?.textContent==='Frame ready'`,
    "initial frame not ready",
  );
  for (const selector of ["[data-playback-options]"]) {
    if (await evaluate(`document.querySelector('${selector}').open`))
      throw new Error("advanced controls should begin collapsed");
    await evaluate(`document.querySelector('${selector} > summary').focus()`);
    await call("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: " ",
      code: "Space",
      text: " ",
      windowsVirtualKeyCode: 32,
    });
    await call("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: " ",
      code: "Space",
      windowsVirtualKeyCode: 32,
    });
    await until(
      `document.querySelector('${selector}').open`,
      `advanced controls ${selector} did not open from the keyboard`,
    );
    await call("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: " ",
      code: "Space",
      text: " ",
      windowsVirtualKeyCode: 32,
    });
    await call("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: " ",
      code: "Space",
      windowsVirtualKeyCode: 32,
    });
    await until(
      `!document.querySelector('${selector}').open`,
      "advanced controls did not close from the keyboard",
    );
  }
  await evaluate(
    `document.querySelector('[data-seek]').value='12';document.querySelector('[data-seek]').dispatchEvent(new Event('change',{bubbles:true}))`,
  );
  await until(
    `document.querySelector('[data-frame]').textContent.includes('0012')&&document.querySelector('[data-status]').textContent==='Frame ready'`,
    "seek 12 not presented",
  );
  await evaluate(
    `document.querySelector('[data-range-start]').value='10';document.querySelector('[data-range-end]').value='15';document.querySelector('[data-apply-range]').click()`,
  );
  await wait(100);
  await until(
    `document.querySelector('[data-frame]').textContent.includes('0012')&&document.querySelector('[data-status]').textContent==='Frame ready'`,
    "range not applied",
  );
  await evaluate(`document.querySelector('[data-play]').click()`);
  await until(
    `document.querySelector('[data-status]').textContent==='Range complete'`,
    "range playback did not complete",
  );
  await evaluate(`document.querySelector('[data-output-frame]').click()`);
  await until(
    `document.querySelector('[data-output]').textContent.includes('Image ready')`,
    "frame output missing",
  );
  await evaluate(`document.querySelector('[data-output-range]').click()`);
  await until(
    `document.querySelector('[data-output]').textContent.includes('Video ready')`,
    "range output missing",
  );
  await evaluate(`document.querySelector('[data-refresh]').click()`);
  await until(
    `document.querySelector('iframe')?.src.includes('source=2')&&document.querySelector('[data-frame]').textContent.includes('0014')&&!document.querySelector('[data-refresh]').disabled`,
    "refresh did not preserve frame",
  );
  await evaluate(
    `document.querySelector('[data-output-frame]').click();document.querySelector('[data-refresh]').click()`,
  );
  await until(
    `document.querySelector('iframe')?.src.includes('source=3')`,
    "second refresh missing",
  );
  await wait(250);
  const stale = await evaluate(
    `document.querySelector('[data-output]').textContent`,
  );
  if (stale.includes("Image ready"))
    throw new Error("stale output was published");
  if (
    (await evaluate(`document.querySelector('[data-error]').hidden`)) !== true
  )
    throw new Error("UI ended with visible error");
  if (outputs.length !== 3)
    throw new Error(`expected 3 output requests, received ${outputs.length}`);
  if (cancellations !== 1 || jobs.get("job-3")?.record.status !== "cancelled")
    throw new Error(
      "source refresh did not cancel and join its prior output job",
    );

  // Mark the next task after a changes response is consumed, so the test can
  // release selection only after the poll continuation has decided what to do.
  await evaluate(`{
    for (const method of ['json', 'text']) {
      const read = Response.prototype[method];
      Response.prototype[method] = async function () {
        const value = await read.call(this);
        if (new URL(this.url).pathname === '/api/changes')
          setTimeout(() => window.pollHandled = true, 0);
        return value;
      };
    }
  }`);
  changedRevision = "revision-4";
  await until(
    () => changeObservations === 2,
    "changes poll did not reach gate",
  );
  await evaluate(
    `document.querySelector('[data-composition]').value='other';document.querySelector('[data-composition]').dispatchEvent(new Event('change'))`,
  );
  await until(
    () => selectionWaiting,
    "composition selection did not reach gate",
  );
  await evaluate(`window.pollHandled = false`);
  changesReleased.resolve();
  await until(
    `window.pollHandled`,
    "delayed changes response was not consumed",
  );
  selectionReleased.resolve();
  await until(
    `document.querySelector('[data-composition]').value==='other'&&document.querySelector('[data-status]').textContent==='Frame ready'&&!document.querySelector('[data-composition]').disabled`,
    "delayed poll replaced the user's composition selection",
  );
  await until(
    `document.querySelector('iframe')?.src.includes('source=4')&&!document.querySelector('[data-refresh]').disabled`,
    "automatic refresh did not resume after selection",
  );
  if (
    (await evaluate(`document.querySelector('[data-composition]').value`)) !==
    "other"
  )
    throw new Error("automatic refresh lost the selected composition");

  changesReleased = Promise.withResolvers();
  changeObservations = 0;
  changeError = true;
  changedRevision = "revision-5";
  await until(() => changeObservations === 2, "failed poll did not reach gate");
  await evaluate(
    `document.querySelector('[data-composition]').value='scene';document.querySelector('[data-composition]').dispatchEvent(new Event('change'))`,
  );
  await until(
    `document.querySelector('[data-status]').textContent==='Frame ready'&&!document.querySelector('[data-composition]').disabled`,
    "selection did not finish before the delayed poll failure",
  );
  await evaluate(`window.pollHandled = false`);
  changesReleased.resolve();
  await until(`window.pollHandled`, "delayed changes failure was not consumed");
  if (
    (await evaluate(`document.querySelector('[data-status]').textContent`)) !==
    "Frame ready"
  )
    throw new Error("stale poll failure replaced the selected frame's status");

  // Keep the canvas offscreen independently of the responsive layout, as when
  // an inspector scroll moves it out of view and Chromium suspends its paint callbacks.
  changedRevision = undefined;
  changeError = false;
  await call("Emulation.setDeviceMetricsOverride", {
    width: 434,
    height: 767,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await evaluate(
    `Object.assign(document.querySelector('[data-stage]').style, {position:'fixed',top:'-2000px',width:'320px',height:'180px'})`,
  );
  await wait(250);
  if (
    !(await evaluate(
      `document.querySelector('[data-stage]').getBoundingClientRect().bottom < 0`,
    ))
  )
    throw new Error(
      "offscreen refresh fixture did not move the canvas out of view",
    );
  await evaluate(`document.querySelector('[data-refresh]').click()`);
  await until(
    `document.querySelector('iframe')?.src.includes('source=5')&&document.querySelector('[data-status]').textContent==='Frame ready'&&!document.querySelector('[data-refresh]').disabled`,
    "source refresh stalled while the composition iframe was offscreen",
  );
  console.log(
    JSON.stringify(
      {
        browser: "Chrome headless",
        initialSeek: 12,
        playbackRange: [10, 15],
        endedFrame: 14,
        refreshedVersions: ["source-2", "source-3", "source-4", "source-5"],
        staleOutputSuppressed: true,
        outputCancellationJoined: true,
        advancedControlsKeyboardAccessible: true,
        selectionPreservedDuringPoll: true,
        stalePollFailureSuppressed: true,
        offscreenSourceRefresh: true,
        outputRequests: outputs,
      },
      null,
      2,
    ),
  );
} finally {
  frameReleased.resolve();
  changesReleased.resolve();
  selectionReleased.resolve();
  socket?.close();
  chrome.kill();
  await Promise.race([
    new Promise((resolveExit) => chrome.once("exit", resolveExit)),
    wait(2000),
  ]);
  await Promise.all([
    new Promise((resolveClose) => parent.close(resolveClose)),
    new Promise((resolveClose) => child.close(resolveClose)),
  ]);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

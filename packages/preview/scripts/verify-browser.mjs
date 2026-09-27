import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const packageRoot = resolve(import.meta.dirname, "..");
const dist = resolve(
  process.env.VELOCAST_PREVIEW_DIST || join(packageRoot, "dist"),
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
const child = await listen(async (request, response) => {
  const path = new URL(request.url, "http://fixture").pathname;
  if (path === "/") {
    send(
      response,
      200,
      `<!doctype html><html><head><style>html,body,#root{margin:0;width:100%;height:100%}#root{display:grid;place-items:center;background:#13263b;color:#fff;font:700 28px sans-serif}</style></head><body><div id="root">boot</div><script>
      (()=>{let session; const root=document.querySelector('#root'); window.__velocast={protocolVersion:${browserProtocolVersion},
      async beginSession(value){session={...value}},getSession(){return session},cancelPending(){},
      async getCompositions(){return [{id:'scene',width:320,height:180,fps:30,durationFrames:60,target:'#root'}]},
      async getDurationFrames(){return 60},async setInputProps(value){root.dataset.label=value?.label||''},
      async seekFrame(_id,frame){root.dataset.frame=String(frame);root.textContent=(root.dataset.label||'scene')+' / '+frame},
      async getAudioPlan(){return null},async waitForReady(){},async destroy(){root.dataset.destroyed='true'}}})();
      </script><script type="module" src="/__velocast-preview/bridge.js"></script></body></html>`,
      "text/html",
    );
    return;
  }
  if (path === "/__velocast-preview/config.js") {
    send(
      response,
      200,
      `export const previewConfig=${JSON.stringify({ parentOrigin })};`,
      "text/javascript",
    );
    return;
  }
  if (path.startsWith("/__velocast-preview/")) {
    const name = path.slice("/__velocast-preview/".length);
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
const parent = await listen(async (request, response) => {
  const path = new URL(request.url, "http://fixture").pathname;
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
    });
    return;
  }
  if (path === "/api/output") {
    const requestBody = await body(request);
    if (requestBody.expectedSourceVersion !== `source-${source}`) {
      send(response, 409, { error: "source version is stale" });
      return;
    }
    outputs.push(requestBody);
    await new Promise((resolveWait) => setTimeout(resolveWait, 180));
    send(response, 200, {
      outputPath:
        requestBody.frame === undefined
          ? `range-${requestBody.range.start}-${requestBody.range.end}.mp4`
          : `frame-${requestBody.frame}.png`,
    });
    return;
  }
  const relative = path === "/" ? "ui/index.html" : `ui/${path.slice(1)}`;
  try {
    send(
      response,
      200,
      await readFile(join(dist, relative)),
      contentType(relative),
    );
  } catch {
    send(response, 404, "missing", "text/plain");
  }
});
parentOrigin = origin(parent);

const profile = await mkdtemp(join(tmpdir(), "velocast-preview-chrome-"));
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
      if (await evaluate(expression)) return;
      await wait(50);
    }
    throw new Error(message);
  };

  await call("Runtime.enable");
  await until(
    `document.querySelector('[data-status]')?.textContent==='Frame ready'`,
    "initial frame not ready",
  );
  if (
    (await evaluate(
      `document.querySelector('[data-source-version]').textContent`,
    )) !== "source-1"
  )
    throw new Error("initial version mismatch");
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
    `document.querySelector('[data-output]').textContent.includes('frame-14.png')`,
    "frame output missing",
  );
  await evaluate(`document.querySelector('[data-output-range]').click()`);
  await until(
    `document.querySelector('[data-output]').textContent.includes('range-10-15.mp4')`,
    "range output missing",
  );
  await evaluate(`document.querySelector('[data-refresh]').click()`);
  await until(
    `document.querySelector('[data-source-version]').textContent==='source-2'&&document.querySelector('[data-frame]').textContent.includes('0014')&&!document.querySelector('[data-refresh]').disabled`,
    "refresh did not preserve frame",
  );
  await evaluate(
    `document.querySelector('[data-output-frame]').click();document.querySelector('[data-refresh]').click()`,
  );
  await until(
    `document.querySelector('[data-source-version]').textContent==='source-3'`,
    "second refresh missing",
  );
  await wait(250);
  const stale = await evaluate(
    `document.querySelector('[data-output]').textContent`,
  );
  if (stale.includes("frame-14.png"))
    throw new Error("stale output was published");
  if (
    (await evaluate(`document.querySelector('[data-error]').hidden`)) !== true
  )
    throw new Error("UI ended with visible error");
  if (outputs.length !== 3)
    throw new Error(`expected 3 output requests, received ${outputs.length}`);
  console.log(
    JSON.stringify(
      {
        browser: "Chrome headless",
        initialSeek: 12,
        playbackRange: [10, 15],
        endedFrame: 14,
        refreshedVersions: ["source-2", "source-3"],
        staleOutputSuppressed: true,
        outputRequests: outputs,
      },
      null,
      2,
    ),
  );
} finally {
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

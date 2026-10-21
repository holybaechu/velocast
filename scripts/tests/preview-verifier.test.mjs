import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const verifier = fileURLToPath(
  new URL(
    "../../packages/preview/scripts/verify-official-preview.mjs",
    import.meta.url,
  ),
);
const browserHelpers = new URL(
  "../../packages/cli/dist/media/browser-cdp.js",
  import.meta.url,
).href;
const rendererHelpers = new URL(
  "../../packages/cli/dist/render/renderer-process.js",
  import.meta.url,
).href;
const previewCommand = new URL(
  "../../packages/cli/dist/preview/preview-command.js",
  import.meta.url,
).href;

for (const phase of ["startup", "ready"]) {
  test(
    `preview command observes parent disconnect during ${phase}`,
    { timeout: 10_000 },
    async (t) => {
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      import assert from 'node:assert/strict';
      import { previewCommand } from ${JSON.stringify(previewCommand)};
      const early = ${JSON.stringify(phase)} === 'startup';
      if (early) {
        const disconnected = new Promise((done) => process.once('disconnect', done));
        process.send('ready');
        await disconnected;
      }
      let acquired = false;
      let closed = false;
      try {
        await previewCommand({}, {}, {
          createServer: async () => {
            acquired = true;
            return {url:'http://localhost:1',session:()=>({}),close:async()=>{
              await new Promise((done)=>setTimeout(done,30)); closed=true;
            }};
          },
          write:()=>process.send('ready'),
        });
        assert.equal(early, false);
        assert.equal(closed, true);
      } catch(error) {
        if (!early || error.name !== 'AbortError') throw error;
        assert.equal(acquired, false);
      }
      console.log('joined');
    `,
        ],
        {
          stdio: ["ignore", "pipe", "pipe", "ipc"],
          env: { ...process.env, VELOCAST_PREVIEW_GATE_CLI: "fixture" },
        },
      );
      const closed = Promise.all([
        new Promise((done) => child.once("exit", done)),
        finished(child.stdout),
        finished(child.stderr),
      ]).then(([code]) => code);
      t.after(async () => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
        await closed;
      });
      let output = "";
      child.stdout.on("data", (data) => {
        output += data;
      });
      child.stderr.on("data", (data) => {
        output += data;
      });
      await new Promise((done, reject) => {
        child.on("message", (message) => {
          if (message === "ready") done();
        });
        child.once("error", reject);
        child.once("exit", () => reject(new Error(output)));
      });
      child.disconnect();
      assert.equal(await closed, 0, output);
      assert.match(output, /joined/);
    },
  );
}

for (const failure of ["startup", "browser", "verification", "unresponsive"]) {
  test(
    `preview verifier reaps owned processes and restores source after ${failure} failure`,
    { timeout: 30_000 },
    async (t) => {
      const root = mkdtempSync(join(tmpdir(), "velocast-preview-verifier-"));
      let child;
      let closed;
      const pidPath = join(root, "pids.json");
      t.after(async () => {
        const pids = existsSync(pidPath)
          ? JSON.parse(readFileSync(pidPath, "utf8"))
          : [];
        for (const pid of [...pids, child?.pid].filter(Boolean)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        }
        await closed;
        for (const pid of pids)
          assert.equal(
            await processExited(pid),
            true,
            `fixture process ${pid} survived cleanup`,
          );
        rmSync(root, { recursive: true, force: true });
      });
      mkdirSync(join(root, "dist"));
      mkdirSync(join(root, "media"));
      mkdirSync(join(root, "render"));
      writeFileSync(
        join(root, "render/renderer-process.js"),
        `export { terminateRendererProcess } from ${JSON.stringify(rendererHelpers)};`,
      );
      const authored = join(root, "dist/index.html");
      writeFileSync(authored, "original");
      writeFileSync(join(root, "package.json"), '{"type":"module"}');
      writeFileSync(
        join(root, "media/browser-cdp.js"),
        `
      export { stopBrowser, cleanupBrowserResources } from ${JSON.stringify(browserHelpers)};
      import { writeFileSync } from 'node:fs';
      export async function launchCdpBrowser() {
        if (${JSON.stringify(failure)} === 'browser') throw new Error('fixture.browser_failure');
        return {
          call: async () => {},
          evaluate: async () => { throw new Error('fixture.verification_failure'); },
          close: async () => writeFileSync(${JSON.stringify(join(root, "browser-closed"))}, 'closed'),
        };
      }
    `,
      );
      writeFileSync(
        join(root, "cli.mjs"),
        `
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      let child;
      process.once('disconnect', () => {
        if (${JSON.stringify(failure)} === 'unresponsive') return;
        child.once('close', () => process.exit(0));
        child.kill('SIGKILL');
      });
      if (${JSON.stringify(failure)} === 'unresponsive') {
        writeFileSync('pids.json', JSON.stringify([process.pid]));
        writeFileSync('dist/index.html', 'changed');
      } else process.send({type:'velocast.preview.starting'}, (error) => {
        if (error) throw error;
        child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio:'ignore', detached:process.platform !== 'win32' });
        child.once('spawn', () => {
          writeFileSync('pids.json', JSON.stringify([process.pid, child.pid]));
          writeFileSync('dist/index.html', 'changed');
          const line = ${JSON.stringify(failure)} === 'startup' ? '{broken' : JSON.stringify({url:'http://localhost:1',session:{sourceVersion:'fixture'}});
          // Deliberately split readiness across chunks.
          process.stdout.write(line.slice(0,3));
          setTimeout(()=>process.stdout.write(line.slice(3)+'\\n'),20);
        });
      });
      setInterval(() => {}, 1000);
    `,
      );
      child = spawn(process.execPath, [verifier], {
        env: {
          ...process.env,
          VELOCAST_PREVIEW_GATE_PROJECT: root,
          VELOCAST_PREVIEW_GATE_CLI: join(root, "cli.mjs"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      closed = new Promise((done) => child.once("close", done));
      let output = "";
      child.stdout.on("data", (data) => {
        output += data;
      });
      child.stderr.on("data", (data) => {
        output += data;
      });
      const code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      assert.notEqual(code, 0, output);
      assert.match(
        output,
        failure === "startup"
          ? /SyntaxError/
          : failure === "unresponsive"
            ? /CLI startup timeout/
            : new RegExp(`fixture\\.${failure}_failure`),
      );
      assert.equal(readFileSync(authored, "utf8"), "original");
      for (const pid of JSON.parse(
        readFileSync(join(root, "pids.json"), "utf8"),
      )) {
        assert.equal(
          await processExited(pid),
          true,
          `owned process ${pid} survived verifier shutdown`,
        );
      }
      if (failure === "verification")
        assert.equal(
          readFileSync(join(root, "browser-closed"), "utf8"),
          "closed",
        );
    },
  );
}

async function processExited(pid) {
  // A terminated descendant can briefly remain until its parent reaps it.
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      return true;
    }
    await new Promise((done) => setTimeout(done, 20));
  }
  return false;
}

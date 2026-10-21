import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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

for (const failure of ["startup", "browser", "verification"]) {
  test(
    `preview verifier reaps owned processes and restores source after ${failure} failure`,
    { timeout: 20_000 },
    async (t) => {
      const root = mkdtempSync(join(tmpdir(), "velocast-preview-verifier-"));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      mkdirSync(join(root, "dist"));
      mkdirSync(join(root, "media"));
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
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      child.once('spawn', () => {
        writeFileSync('pids.json', JSON.stringify([process.pid, child.pid]));
        writeFileSync('dist/index.html', 'changed');
        const line = ${JSON.stringify(failure)} === 'startup' ? '{broken' : JSON.stringify({url:'http://localhost:1',session:{sourceVersion:'fixture'}});
        // Deliberately split readiness across chunks.
        process.stdout.write(line.slice(0, 3));
        setTimeout(() => process.stdout.write(line.slice(3) + '\\n'), 20);
      });
      setInterval(() => {}, 1000);
    `,
      );
      const child = spawn(process.execPath, [verifier], {
        env: {
          ...process.env,
          VELOCAST_PREVIEW_GATE_PROJECT: root,
          VELOCAST_PREVIEW_GATE_CLI: join(root, "cli.mjs"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
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
          : new RegExp(`fixture\\.${failure}_failure`),
      );
      assert.equal(readFileSync(authored, "utf8"), "original");
      for (const pid of JSON.parse(
        readFileSync(join(root, "pids.json"), "utf8"),
      )) {
        // The OS can briefly retain a terminated descendant until its parent reaps it.
        let alive = true;
        for (let attempt = 0; attempt < 100; attempt++) {
          try {
            process.kill(pid, 0);
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
            alive = false;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(
          alive,
          false,
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

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { URL } from "node:url";

const loader = new URL(
  "../../packages/cli/dist/config-loader.js",
  import.meta.url,
).href;

test("compiled config loader handles TypeScript without inherited loader hooks", () => {
  const temporary = mkdtempSync(join(tmpdir(), "velocast-config-loader-"));
  try {
    writeFileSync(join(temporary, "package.json"), '{"type":"module"}');
    writeFileSync(join(temporary, "index.html"), "<!doctype html>");
    writeFileSync(
      join(temporary, "helper.ts"),
      "export const base: number = 2;",
    );
    for (const extension of ["ts", "tsx", "mts", "cts"])
      writeFileSync(
        join(temporary, `config.${extension}`),
        `import { base } from "./helper.js";
enum Workers { One = 1 }
export default {
  entry: "index.html",
  renderer: { concurrency: base + Workers.One },
};`,
      );
    writeFileSync(
      join(temporary, "config.mjs"),
      'export default { serve: { url: "http://127.0.0.1:9999" } };',
    );
    writeFileSync(
      join(temporary, "error.mjs"),
      'throw new Error("user config failed");',
    );
    const probe = join(temporary, "probe.mjs");
    writeFileSync(
      probe,
      `import assert from "node:assert/strict";
import { join } from "node:path";
import { loadConfigFromPath } from ${JSON.stringify(loader)};
for (const extension of ["ts", "tsx", "mts", "cts"]) {
  const config = await loadConfigFromPath(join(process.cwd(), "config." + extension));
  assert.equal(config.entry, join(process.cwd(), "index.html"));
  assert.equal(config.renderer.concurrency, 3);
}
const javascript = join(process.cwd(), "config.mjs");
assert.strictEqual(await loadConfigFromPath(javascript), await loadConfigFromPath(javascript));
await assert.rejects(loadConfigFromPath(join(process.cwd(), "error.mjs")), /user config failed/);
`,
    );
    const result = spawnSync(process.execPath, [probe], {
      cwd: temporary,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: "",
        TMPDIR: temporary,
        TMP: temporary,
        TEMP: temporary,
      },
      timeout: 30_000,
      windowsHide: true,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

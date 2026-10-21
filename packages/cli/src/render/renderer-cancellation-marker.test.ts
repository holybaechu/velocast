import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runRenderer } from "./renderer-process.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    const absolute = realpathSync(root);
    expect(dirname(absolute)).toBe(realpathSync(tmpdir()));
    rmSync(absolute, { recursive: true, force: true });
  }
});

it.each([false, true])(
  "writes the marker before termination and preserves preexisting markers=%s",
  async (preexisting) => {
    const root = mkdtempSync(join(tmpdir(), "velocast-cancel-marker-"));
    roots.push(root);
    const eventPath = join(root, "events.jsonl");
    const observed = join(root, "observed.json");
    const trigger = join(root, "trigger");
    const controller = new AbortController();
    let marker = "";
    const code = `
    const fs = require('node:fs');
    const [events, observed, trigger, existing] = process.argv.slice(1);
    const marker = events + '.' + process.pid + '.cancel';
    if(existing === 'true') fs.writeFileSync(marker, 'preexisting');
    process.stdout.write('READY\\n');
    setInterval(() => {
      if(fs.existsSync(trigger) && fs.existsSync(marker)) {
        fs.writeFileSync(observed, JSON.stringify({marker, body:fs.readFileSync(marker,'utf8')}));
        process.exit(1);
      }
    }, 5);
  `;
    await expect(
      runRenderer(
        process.execPath,
        { event_log_path: eventPath },
        {
          signal: controller.signal,
          terminationGraceMs: 3_000,
          resolveProcessEnv: () => process.env,
          spawnRenderer: (binary, _args, options) => {
            const child = spawn(
              binary,
              ["-e", code, eventPath, observed, trigger, String(preexisting)],
              options,
            );
            marker = `${eventPath}.${child.pid}.cancel`;
            child.stdout!.once("data", () => {
              controller.abort();
              writeFileSync(trigger, "cancel requested");
            });
            return child;
          },
        },
      ),
    ).rejects.toThrow("cancelled");
    expect(JSON.parse(readFileSync(observed, "utf8"))).toEqual({
      marker,
      body: preexisting ? "preexisting" : "",
    });
    expect(existsSync(marker)).toBe(preexisting);
    if (preexisting) expect(readFileSync(marker, "utf8")).toBe("preexisting");
  },
);

it("publishes a per-process marker for timeout as well as an AbortSignal", async () => {
  const root = mkdtempSync(join(tmpdir(), "velocast-cancel-marker-"));
  roots.push(root);
  const eventPath = join(root, "events.jsonl"),
    observed = join(root, "observed");
  let marker = "";
  const code = `const fs=require('node:fs');const [events,out]=process.argv.slice(1);const marker=events+'.'+process.pid+'.cancel';setInterval(()=>{if(fs.existsSync(marker)){fs.writeFileSync(out,'seen');process.exit(1);}},5);`;
  await expect(
    runRenderer(
      process.execPath,
      { event_log_path: eventPath },
      {
        timeoutMs: 200,
        terminationGraceMs: 3_000,
        resolveProcessEnv: () => process.env,
        spawnRenderer: (binary, _args, options) => {
          const child = spawn(
            binary,
            ["-e", code, eventPath, observed],
            options,
          );
          marker = `${eventPath}.${child.pid}.cancel`;
          return child;
        },
      },
    ),
  ).rejects.toThrow("timed out");
  expect(readFileSync(observed, "utf8")).toBe("seen");
  expect(existsSync(marker)).toBe(false);
});

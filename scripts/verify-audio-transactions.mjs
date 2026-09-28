import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, stat, realpath, rm, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [binaryArgument, sourceArgument, directoryArgument] = process.argv.slice(2);
assert(binaryArgument && sourceArgument && directoryArgument,
  "Usage: node scripts/verify-audio-transactions.mjs RENDERER VERIFIED_AUDIO_GATE_DIRECTORY OUTPUT_DIRECTORY");
const binary = resolve(binaryArgument), source = resolve(sourceArgument), directory = resolve(directoryArgument);
const load = (path) => import(pathToFileURL(join(root, path)).href);
const { createInputSnapshot } = await load("packages/cli/dist/input-snapshot.js");
const { runRenderer } = await load("packages/cli/dist/renderer-process.js");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
await mkdir(directory, { recursive: true });
await mkdir(join(directory, "cache"), { recursive: true });
// Deliberately distinct from the new full render: deterministic reproduction of
// the same output would make a hash-only publication-race check inconclusive.
const previous = await readFile(join(source, "range.mp4")), previousHash = hash(previous);
assert(previous.subarray(4, 8).equals(Buffer.from("ftyp")), "Prior output must be the actual verified MP4");
const env = { ...process.env, TEMP: join(directory, "cache"), TMP: join(directory, "cache") };
let events = [], results = [];
try { events = JSON.parse(await readFile(join(directory, "command-executions.json"), "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
try { results = JSON.parse(await readFile(join(directory, "results.json"), "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
async function save() {
  await writeFile(join(directory, "command-executions.json"), JSON.stringify(events, null, 2));
  await writeFile(join(directory, "results.json"), JSON.stringify(results, null, 2));
}
async function waitForFile(path, event, controller, label) {
  for (let i = 0; i < 2000 && event.exitStatus === undefined; i++) {
    try {
      const info = await stat(path);
      if (info.isFile() && info.size > 0) {
        event.interruption = { label, path, size: info.size, at: new Date().toISOString() };
        controller.abort(new Error(`fixture cancel during actual ${label}`));
        return;
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    await sleep(2);
  }
  throw new Error(`Did not observe actual ${label} file bytes`);
}
async function run(name, snapshot, fault, extra = {}) {
  if (results.some((result) => result.name === name && result.status === "pass")) return;
  const output = join(directory, `${name}.mp4`);
  await writeFile(output, previous);
  const job = { mode: "composition", composition_id: "audio-hero", serve_url: snapshot.url,
    render_session: snapshot.session, output, codec: "h264", acceleration: "off",
    concurrency: 1, assembly_mode: "reference", report_path: join(directory, `${name}.report.json`),
    result_path: join(directory, `${name}.result.json`), ...extra };
  const event = { name, startedAt: new Date().toISOString(), stdout: "", stderr: "", cwd: root };
  const controller = new AbortController();
  let hook = null, workspace, closed;
  try {
    await runRenderer(binary, job, { signal: controller.signal, resolveProcessEnv: () => env, timeoutMs: 120000,
      spawnRenderer(executable, args, options) {
        event.command = [executable, ...args];
        const child = spawn(executable, args, { ...options, cwd: root });
        event.pid = child.pid;
        workspace = join(directory, ".velocast/tmp", `${basename(output, ".mp4")}-${child.pid}`);
        child.stdout.on("data", (bytes) => event.stdout += bytes);
        child.stderr.on("data", (bytes) => {
          event.stderr += bytes;
          if (hook) return;
          if (fault === "mux-failure" && event.stderr.includes("stage=mix")) {
            // An explicit owned-workspace I/O fault. The media mux must
            // fail opening its destination; no fake encoder or fabricated exit.
            hook = mkdir(join(workspace, "audio-muxed.mp4")).then(() => {
              event.fault = { path: join(workspace, "audio-muxed.mp4"), kind: "destination-is-directory" };
            });
          } else if (fault === "mux-cancel" && event.stderr.includes("stage=mux")) {
            hook = waitForFile(join(workspace, "audio-muxed.mp4"), event, controller, "mux");
          } else if (fault === "download-cancel" && event.stderr.includes('stage="audio.download"')) {
            hook = waitForFile(join(workspace, "audio-source-0.input"), event, controller, "download");
          }
          hook?.catch((error) => { event.hookError = String(error); controller.abort(error); });
        });
        closed = new Promise((done) => child.on("close", (code, signal) => {
          event.exitStatus = code; event.signal = signal; done();
        }));
        return child;
      } });
  } catch (error) { event.error = String(error); }
  if (closed) await closed;
  if (hook) await hook;
  event.finishedAt = new Date().toISOString(); events.push(event); await save();
  assert(event.error, `${name}: failure/cancellation did not happen`);
  assert(!event.hookError, event.hookError);
  if (fault === "mux-failure") {
    assert(event.fault && event.stderr.includes("audio.mux_failed"), event.stderr);
    assert(event.stderr.includes("Is a directory") || event.stderr.includes("Permission denied"), event.stderr);
  } else if (fault.endsWith("cancel")) {
    assert(event.interruption?.size > 0 && event.error.includes("cancel"), JSON.stringify(event));
  } else assert(event.stderr.includes("audio.mix_failed"), event.stderr);
  assert.equal(hash(await readFile(output)), previousHash);
  let retained = [];
  try { retained = await readdir(workspace); } catch (error) { if (error.code !== "ENOENT") throw error; }
  // Forced process termination cannot run Rust Drop/async cleanup. Record any
  // private leftovers honestly, verify the owned process exited, then remove
  // only this exact canonical gate workspace. Ordinary errors must self-clean.
  if (fault.endsWith("cancel")) {
    assert.throws(() => process.kill(event.pid, 0));
    if (retained.length) {
      const expected = await realpath(join(directory, ".velocast/tmp"));
      const actual = await realpath(workspace);
      assert(actual.startsWith(expected + sep));
      await rm(actual, { recursive: true });
    }
  } else assert.deepEqual(retained, []);
  results.push({ name, status: "pass", previousHash, exitStatus: event.exitStatus,
    interruption: event.interruption, injectedIoFault: event.fault,
    retainedAfterForcedTermination: retained, scopedHarnessCleanup: retained.length > 0 });
  await save();
  console.log(`AUDIO_TRANSACTION_PASS: ${name}; previous MP4 unchanged`);
}

const snapshot = await createInputSnapshot({ root: join(source, "react/dist"), entryPath: "index.html" });
try {
  await run("mux-failure", snapshot, "mux-failure");
  await run("mux-cancel", snapshot, "mux-cancel");
  const badRoot = join(directory, "bad");
  await mkdir(badRoot, { recursive: true });
  // Corrupt media is frozen and hash-valid, so only the real decoder rejects it.
  const { cp } = await import("node:fs/promises");
  await cp(join(source, "react/dist"), badRoot, { recursive: true });
  await writeFile(join(badRoot, "tone.wav"), Buffer.from("not an audio container"));
  const badSnapshot = await createInputSnapshot({ root: badRoot, entryPath: "index.html" });
  try { await run("decode-failure", badSnapshot, "decode-failure", { output_range: { startFrame: 0, endFrame: 4 } }); }
  finally { await badSnapshot.close(); }

  const bytes = await readFile(join(source, "react/dist/tone.wav"));
  const sockets = new Set();
  const server = createServer(async (request, response) => {
    try {
      if (request.url === "/tone.wav") {
        response.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": bytes.length,
          "X-Velocast-Source-Version": snapshot.session.sourceVersion,
          "X-Velocast-Content-SHA256": hash(bytes) });
        response.write(bytes.subarray(0, 32768));
        // Intentionally withhold the rest until cancellation closes the socket.
      } else {
        const fetched = await fetch(new URL(request.url, snapshot.url));
        response.writeHead(fetched.status, Object.fromEntries(fetched.headers));
        response.end(Buffer.from(await fetched.arrayBuffer()));
      }
    } catch (error) { response.destroy(error); }
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  try { await run("download-cancel", { session: snapshot.session,
    url: `http://127.0.0.1:${server.address().port}/index.html` }, "download-cancel"); }
  finally { for (const socket of sockets) socket.destroy(); await new Promise((done) => server.close(done)); }
} finally { await snapshot.close(); }
console.log(`AUDIO_TRANSACTIONS_PASS: ${results.length} actual native failure/cancellation gates`);

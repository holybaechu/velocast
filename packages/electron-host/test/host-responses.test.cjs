"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { hostResponses } = require("./host-responses.cjs");

test("pre-handshake child failure reports exit status and complete stderr", async () => {
  const child = spawn(process.execPath, ["-e", 'process.stderr.write("sandbox launch denied\\n"); process.exitCode=23;'], { windowsHide: true });
  const responses = hostResponses(child);
  await assert.rejects(responses.next(), /Host closed \(code=23, signal=null\): sandbox launch denied/);
  await assert.rejects(responses.next(), /sandbox launch denied/);
});

test("handshake remains readable before orderly EOF, and later reads report closure", async () => {
  const child = spawn(process.execPath, ["-e", 'process.stdout.write("\\n{\\"event\\":\\"ready\\"}\\n");'], { windowsHide: true });
  const responses = hostResponses(child);
  assert.deepEqual(await responses.next(), { event: "ready" });
  await assert.rejects(responses.next(), /Host closed \(code=0/);
});

test("malformed host output rejects the active response instead of throwing from event callback", async () => {
  const child = spawn(process.execPath, ["-e", 'process.stdout.write("invalid\\n");'], { windowsHide: true });
  const responses = hostResponses(child);
  await assert.rejects(responses.next(), /invalid JSON: invalid/);
});

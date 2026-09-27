"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { configureProfileDirectory } = require("../profile-directory.cjs");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "velocast-profile-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function app(ready = false) {
  const paths = new Map();
  return { paths, isReady: () => ready, setPath: (name, value) => paths.set(name, value) };
}

test("each host directs both user and Chromium session data into its own profile", (t) => {
  const firstDirectory = fixture(t);
  const secondDirectory = fixture(t);
  const first = app();
  const second = app();
  configureProfileDirectory(first, firstDirectory);
  configureProfileDirectory(second, secondDirectory);
  assert.deepEqual([...first.paths], [["userData", firstDirectory], ["sessionData", firstDirectory]]);
  assert.deepEqual([...second.paths], [["userData", secondDirectory], ["sessionData", secondDirectory]]);
  for (const [host, contents] of [[first, "first"], [second, "second"]]) {
    fs.mkdirSync(path.join(host.paths.get("sessionData"), "GPUCache"));
    fs.writeFileSync(path.join(host.paths.get("sessionData"), "GPUCache", "data_0"), contents);
  }
  assert.equal(fs.readFileSync(path.join(firstDirectory, "GPUCache", "data_0"), "utf8"), "first");
  assert.equal(fs.readFileSync(path.join(secondDirectory, "GPUCache", "data_0"), "utf8"), "second");
});

test("profile configuration rejects late initialization and invalid native paths", (t) => {
  const directory = fixture(t);
  const late = app(true);
  assert.throws(() => configureProfileDirectory(late, directory), /before readiness/);
  assert.equal(late.paths.size, 0);
  const file = path.join(directory, "file");
  fs.writeFileSync(file, "keep");
  for (const invalid of [undefined, "", "relative/profile", file, path.join(directory, "missing")]) {
    const host = app();
    assert.throws(() => configureProfileDirectory(host, invalid));
    assert.equal(host.paths.size, 0);
  }
  assert.equal(fs.readFileSync(file, "utf8"), "keep");
});

test("profile configuration refuses a directory symlink", { skip: process.platform === "win32" }, (t) => {
  const directory = fixture(t);
  const target = fixture(t);
  const link = path.join(directory, "profile-link");
  fs.symlinkSync(target, link, "dir");
  assert.throws(() => configureProfileDirectory(app(), link), /existing absolute directory/);
});

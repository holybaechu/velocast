import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  collectDependencies,
  packageElectronRuntime,
  peArchitecture,
  withDllSearchPath,
} from "../electron-runtime-package.mjs";

test("capability probe receives explicit DLL directories without mutating caller PATH", () => {
  const environment = { PATH: "machine", Path: "stale", KEEP: "yes" };
  const result = withDllSearchPath(["vcpkg-bin", "system32"], environment);
  assert.equal(
    result.PATH,
    ["vcpkg-bin", "system32", "machine"].join(delimiter),
  );
  assert.deepEqual(
    Object.keys(result).filter((key) => key.toLowerCase() === "path"),
    ["PATH"],
  );
  assert.equal(result.KEEP, "yes");
  assert.equal(environment.PATH, "machine");
  assert.equal(environment.Path, "stale");
});

function executableFixture(machine = 0x8664) {
  const bytes = Buffer.alloc(128);
  bytes.write("MZ");
  bytes.writeUInt32LE(64, 0x3c);
  bytes.writeUInt32LE(0x00004550, 64);
  bytes.writeUInt16LE(machine, 68);
  return bytes;
}

test("dependency closure includes redistributables, refuses missing imports and CEF", (t) => {
  const root = mkdtempSync(join(tmpdir(), "velocast-package-deps-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const vcpkg = join(root, "vcpkg-bin"),
    system32 = join(root, "system32");
  mkdirSync(vcpkg);
  mkdirSync(system32);
  writeFileSync(join(root, "renderer.exe"), executableFixture());
  writeFileSync(join(vcpkg, "codec.dll"), executableFixture());
  writeFileSync(join(system32, "vcruntime140.dll"), executableFixture());
  const imports = {
    "renderer.exe": ["codec.dll", "KERNEL32.dll"],
    "codec.dll": ["vcruntime140.dll"],
    "vcruntime140.dll": ["api-ms-win-crt-runtime-l1-1-0.dll"],
  };
  const collect = (readImports) =>
    collectDependencies([join(root, "renderer.exe")], {
      searchDirs: [root, vcpkg, system32],
      readImports,
    });
  assert.equal(
    collect((file) => imports[file.split(/[\\/]/).at(-1)]).files.length,
    3,
  );
  assert.throws(
    () => collect(() => ["missing.dll"]),
    /runtime.dependency_missing/,
  );
  assert.throws(() => collect(() => ["libcef.dll"]), /runtime.cef_dependency/);
});

test("candidate stages an Electron-only runtime, hashes files, and refuses overwrite or hybrid builds", (t) => {
  const root = mkdtempSync(join(tmpdir(), "velocast-package-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const electron = join(root, "electron-input"),
    host = join(root, "host");
  mkdirSync(electron);
  mkdirSync(host);
  for (const name of ["velocast-renderer.exe", "ffmpeg.exe", "ffprobe.exe"])
    writeFileSync(join(root, name), executableFixture());
  for (const name of [
    "electron.exe",
    "LICENSE",
    "LICENSES.chromium.html",
    "version",
  ])
    writeFileSync(
      join(electron, name),
      name.endsWith(".exe") ? executableFixture() : "fixture",
    );
  writeFileSync(join(host, "main.cjs"), "fixture-host");
  writeFileSync(join(host, "webcodecs.html"), "trusted-encoder-page");
  const options = {
    platform: "win32",
    arch: "x64",
    renderer: join(root, "velocast-renderer.exe"),
    electron,
    host,
    ffmpeg: join(root, "ffmpeg.exe"),
    ffprobe: join(root, "ffprobe.exe"),
    output: join(root, "candidate"),
    readImports: () => ["KERNEL32.dll"],
    probeCapabilities: () => ({
      browserHosts: ["electron"],
      defaultBrowserHost: "electron",
      electronHostProtocolVersion: 1,
    }),
  };
  const result = packageElectronRuntime(options);
  assert.equal(result.status, "unsigned-local-candidate");
  assert.ok(result.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));
  assert.equal(
    readFileSync(join(options.output, "electron-host/main.cjs"), "utf8"),
    "fixture-host",
  );
  assert.throws(() => packageElectronRuntime(options), /runtime.output_exists/);
  assert.equal(readFileSync(join(options.output, "electron-host/webcodecs.html"), "utf8"), "trusted-encoder-page");
  assert.throws(
    () =>
      packageElectronRuntime({
        ...options,
        output: join(root, "bad"),
        probeCapabilities: () => ({ browserHosts: ["cef", "electron"] }),
      }),
    /runtime.not_electron_only/,
  );
  writeFileSync(options.renderer, executableFixture(0xaa64));
  assert.equal(peArchitecture(options.renderer), "arm64");
  assert.throws(
    () =>
      packageElectronRuntime({ ...options, output: join(root, "wrong-arch") }),
    /runtime.architecture_mismatch/,
  );
});

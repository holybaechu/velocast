import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";
import { create } from "tar";

const repo = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const cli = join(repo, "packages/cli/dist/bin.js");

test("installed CLI performs real fresh/cache/offline/corrupt/version setup I/O", async () => {
  assert.equal(
    statSync(cli).isFile(),
    true,
    "build packages/cli before this setup boundary test",
  );
  const root = mkdtempSync(join(tmpdir(), "velocast-private-rc-cli-"));
  try {
    const fixture = await artifactFixture(root);
    const cache = join(root, "cache");
    const manifest = writeRelease(root, fixture);
    const fresh = setup(manifest, cache);
    assert.equal(fresh.status, 0, fresh.stderr);
    const first = JSON.parse(fresh.stdout);
    assert.equal(first.source, "download");
    assert.equal(first.sha256, fixture.archiveSha256);

    const cached = setup(manifest, cache);
    assert.equal(cached.status, 0, cached.stderr);
    assert.equal(JSON.parse(cached.stdout).source, "cache");

    const offline = setup(manifest, cache, { VELOCAST_OFFLINE: "1" });
    assert.equal(offline.status, 0, offline.stderr);
    assert.equal(JSON.parse(offline.stdout).source, "cache");

    const renderer = join(first.artifactDir, "velocast-renderer.exe");
    const changed = readFileSync(renderer);
    changed[64] ^= 0xff;
    writeFileSync(renderer, changed);
    const corruptCache = setup(manifest, cache, { VELOCAST_OFFLINE: "1" });
    assert.notEqual(corruptCache.status, 0);
    assert.match(corruptCache.stderr, /artifact\.offline_missing/);

    const corruptArchive = join(root, "corrupt.tar.gz");
    copyFileSync(fixture.archive, corruptArchive);
    const corruptBytes = readFileSync(corruptArchive);
    corruptBytes[Math.floor(corruptBytes.length / 2)] ^= 0xff;
    writeFileSync(corruptArchive, corruptBytes);
    const corruptManifest = writeRelease(root, fixture, {
      name: "corrupt-release.json",
      url: pathToFileURL(corruptArchive).href,
    });
    const corruptArchiveResult = setup(
      corruptManifest,
      join(root, "corrupt-archive-cache"),
    );
    assert.notEqual(corruptArchiveResult.status, 0);
    assert.match(corruptArchiveResult.stderr, /artifact\.checksum_mismatch/);

    const mismatchManifest = writeRelease(root, fixture, {
      name: "mismatch-release.json",
      sourceCommit: "0".repeat(40),
    });
    const mismatch = setup(mismatchManifest, join(root, "mismatch-cache"));
    assert.notEqual(mismatch.status, 0);
    assert.match(
      mismatch.stderr,
      /release\.manifest_invalid: win32-x64 artifact sourceCommit differs from manifest sourceCommit/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function artifactFixture(root) {
  const release = JSON.parse(
    readFileSync(join(repo, "release/velocast-release.json"), "utf8"),
  );
  const sourceCommit = "a".repeat(40);
  const rootName = "velocast-private-rc-small-win32-x64";
  const staging = join(root, "staging", rootName);
  mkdirSync(staging, { recursive: true });
  const renderer = Buffer.alloc(512);
  renderer.write("MZ", 0, "ascii");
  renderer.writeUInt32LE(0x80, 0x3c);
  renderer.write("PE\0\0", 0x80, "binary");
  renderer.writeUInt16LE(0x8664, 0x84);
  const payloads = new Map([
    ["velocast-renderer.exe", renderer],
    ["electron/electron.exe", renderer],
    ["electron/version", Buffer.from(`${release.electronVersion}\n`)],
    ["electron/LICENSE", Buffer.from("private Electron license fixture\n")],
    [
      "electron/LICENSES.chromium.html",
      Buffer.from("<p>private Chromium credits fixture</p>\n"),
    ],
    [
      "electron-host/main.cjs",
      Buffer.from("// private Electron host fixture\n"),
    ],
    ["electron-host/media-client.cjs", Buffer.from("media client")],
    ["electron-host/media-runtime.cjs", Buffer.from("media runtime")],
  ]);
  const electronInventory = {
    schema: "velocast-electron-runtime-v1",
    status: "unsigned-local-candidate",
    browserHost: "electron",
    platform: "win32",
    arch: "x64",
    sourceCommit,
    renderer: "velocast-renderer.exe",
    electron: "electron/electron.exe",
    hostScript: "electron-host/main.cjs",
    mediaClient: "electron-host/media-client.cjs",
    mediaBundle: "electron-host/media-runtime.cjs",
    electronVersion: release.electronVersion,
    rendererCapabilities: {
      browserHosts: ["electron"],
      defaultBrowserHost: "electron",
      electronHostProtocolVersion: 2,
      videoEncoderBackend: "webcodecs",
      mediaRuntime: "mediabunny",
    },
    files: [...payloads].map(([path, bytes]) => ({
      path,
      size: bytes.length,
      sha256: digest(bytes),
    })),
  };
  payloads.set(
    "electron-runtime.json",
    Buffer.from(`${JSON.stringify(electronInventory, null, 2)}\n`),
  );
  for (const [name, bytes] of payloads) {
    mkdirSync(dirname(join(staging, name)), { recursive: true });
    writeFileSync(join(staging, name), bytes);
  }
  const inventory = {
    schema: "velocast-native-artifact-v1",
    target: "win32-x64",
    sourceCommit,
    packageVersion: release.packageVersion,
    nativeRendererVersion: release.nativeRendererVersion,
    protocolVersion: release.protocolVersion,
    files: [...payloads].map(([path, bytes]) => ({
      path,
      size: bytes.length,
      sha256: digest(bytes),
    })),
  };
  writeFileSync(
    join(staging, "artifact-manifest.json"),
    `${JSON.stringify(inventory, null, 2)}\n`,
  );
  const archive = join(root, "runtime.tar.gz");
  await create(
    {
      cwd: join(root, "staging"),
      file: archive,
      gzip: { portable: true },
      mtime: new Date(0),
      portable: true,
      strict: true,
    },
    [rootName],
  );
  return {
    release,
    sourceCommit,
    rootName,
    archive,
    archiveSize: statSync(archive).size,
    archiveSha256: digest(readFileSync(archive)),
    runtimeFiles: [...payloads.keys()],
    nativeFiles: [
      "velocast-renderer.exe",
      "electron/electron.exe",
    ],
  };
}

function writeRelease(root, fixture, overrides = {}) {
  const release = structuredClone(fixture.release);
  release.releaseChannel = "private-rc-test";
  release.sourceCommit = fixture.sourceCommit;
  const target = release.targets["win32-x64"];
  target.runtimeFiles = fixture.runtimeFiles;
  target.nativeFiles = fixture.nativeFiles;
  target.requirements = {
    ...target.requirements,
    validationStatus: "validated",
    minimumOsVersion: "10.0.17763",
    softwareFallbackRequired: true,
    softwareFallbackImplemented: true,
  };
  target.artifact = {
    name: "runtime.tar.gz",
    url: overrides.url ?? pathToFileURL(fixture.archive).href,
    format: "tar.gz",
    size: fixture.archiveSize,
    sha256: fixture.archiveSha256,
    sourceCommit: overrides.sourceCommit ?? fixture.sourceCommit,
    renderer: "velocast-renderer.exe",
    root: fixture.rootName,
  };
  target.blocker = null;
  const path = join(root, overrides.name ?? "private-release.json");
  writeFileSync(path, `${JSON.stringify(release, null, 2)}\n`);
  return path;
}

function setup(manifest, cache, additions = {}) {
  mkdirSync(cache, { recursive: true });
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const env = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    USERPROFILE: process.env.USERPROFILE,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    APPDATA: process.env.APPDATA,
    PATH: [
      dirname(process.execPath),
      join(systemRoot, "System32"),
      systemRoot,
    ].join(";"),
    VELOCAST_RELEASE_MANIFEST: manifest,
    VELOCAST_CACHE_DIR: cache,
    ...additions,
  };
  return spawnSync(process.execPath, [cli, "setup", "--json"], {
    cwd: dirname(manifest),
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

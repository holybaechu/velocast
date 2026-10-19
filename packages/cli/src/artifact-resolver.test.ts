import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ArtifactResolver,
  detectReleaseTarget,
  verifyExecutableArchitecture,
  verifyRuntimeDirectory,
} from "./artifact-resolver.js";
import type {
  ReleaseArtifact,
  ReleaseTargetId,
  VelocastReleaseManifest,
} from "./release-manifest.js";
import { RendererRuntimeAcquisition } from "./renderer-runtime.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("target detection", () => {
  it("detects every recognized host family and rejects musl", () => {
    expect(detectReleaseTarget("win32", "x64")).toBe("win32-x64");
    expect(detectReleaseTarget("darwin", "arm64")).toBe("darwin-arm64");
    expect(
      detectReleaseTarget("linux", "x64", { VELOCAST_TEST_LIBC: "glibc" }),
    ).toBe("linux-x64-gnu");
    expect(() =>
      detectReleaseTarget("linux", "x64", { VELOCAST_TEST_LIBC: "musl" }),
    ).toThrow("artifact.unsupported_target: linux-x64-musl");
    expect(() =>
      detectReleaseTarget("freebsd", "x64", {}, ["win32-x64"]),
    ).toThrow("Available targets: win32-x64");
  });
});

describe("native artifact verification", () => {
  it("rejects wrong-architecture executables", () => {
    const dir = tempDir();
    const executable = join(dir, "renderer.exe");
    writeFileSync(executable, peExecutable(0xaa64));
    expect(() => verifyExecutableArchitecture(executable, "x64")).toThrow(
      "artifact.wrong_architecture",
    );
  });

  it("detects corrupt runtime files", async () => {
    const fixture = await releaseFixture();
    fixture.verify();
    writeFileSync(join(fixture.runtimeDir, "velocast-renderer.exe"), "corrupt");
    expect(fixture.verify).toThrow("artifact.runtime_corrupt");
  });

  it.each(["helper.dll", "resources.pak", "locales/en-US.pak"])(
    "rejects a missing required runtime file: %s",
    async (missing) => {
      const fixture = await releaseFixture();
      rmSync(join(fixture.runtimeDir, missing), { force: true });
      expect(fixture.verify).toThrow(`artifact.runtime_missing: ${missing}`);
    },
  );

  it("rejects incompatible native and protocol versions", async () => {
    const fixture = await releaseFixture();
    const inventoryPath = join(fixture.runtimeDir, "artifact-manifest.json");
    const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
    inventory.protocolVersion = 2;
    writeFileSync(inventoryPath, JSON.stringify(inventory));
    expect(fixture.verify).toThrow("artifact.compatibility_mismatch");

    const nativeFixture = await releaseFixture();
    const nativeInventoryPath = join(
      nativeFixture.runtimeDir,
      "artifact-manifest.json",
    );
    const nativeInventory = JSON.parse(
      readFileSync(nativeInventoryPath, "utf8"),
    );
    nativeInventory.nativeRendererVersion = "0.2.0";
    writeFileSync(nativeInventoryPath, JSON.stringify(nativeInventory));
    expect(nativeFixture.verify).toThrow("artifact.compatibility_mismatch");
  });

  it("checks architecture for native helpers as well as the renderer", async () => {
    const fixture = await releaseFixture();
    const helperPath = join(fixture.runtimeDir, "helper.dll");
    const helper = peExecutable(0xaa64);
    writeFileSync(helperPath, helper);
    const inventoryPath = join(fixture.runtimeDir, "artifact-manifest.json");
    const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
    const record = inventory.files.find(
      (file: { path: string }) => file.path === "helper.dll",
    );
    record.size = helper.length;
    record.sha256 = sha256(helper);
    writeFileSync(inventoryPath, JSON.stringify(inventory));
    expect(fixture.verify).toThrow("artifact.wrong_architecture");
  });

  it("verifies optional files declared by the complete runtime inventory", async () => {
    const fixture = await releaseFixture();
    const optional = Buffer.from("bundled transitive dependency");
    writeFileSync(join(fixture.runtimeDir, "optional-dependency.js"), optional);
    const inventoryPath = join(fixture.runtimeDir, "artifact-manifest.json");
    const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
    inventory.files.push({
      path: "optional-dependency.js",
      size: optional.length,
      sha256: sha256(optional),
    });
    writeFileSync(inventoryPath, JSON.stringify(inventory));
    fixture.verify();

    writeFileSync(
      join(fixture.runtimeDir, "optional-dependency.js"),
      "changed",
    );
    expect(fixture.verify).toThrow(
      "artifact.runtime_corrupt: optional-dependency.js failed verification",
    );
  });

  it.each([
    { path: "../outside.dll", reason: "artifact.path_invalid" },
    {
      path: "resources.pak",
      duplicate: true,
      reason: "duplicate checksum inventory path",
    },
  ])(
    "rejects invalid inventory paths and duplicate records: %j",
    async ({ path, duplicate, reason }) => {
      const fixture = await releaseFixture();
      const inventoryPath = join(fixture.runtimeDir, "artifact-manifest.json");
      const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
      const record = duplicate
        ? inventory.files.find((file: { path: string }) => file.path === path)
        : inventory.files[0];
      inventory.files.push(duplicate ? { ...record } : { ...record, path });
      writeFileSync(inventoryPath, JSON.stringify(inventory));
      expect(fixture.verify).toThrow(reason);
    },
  );

  it("checks architecture of native modules declared outside the required file list", async () => {
    const fixture = await releaseFixture();
    const addon = peExecutable(0xaa64);
    writeFileSync(join(fixture.runtimeDir, "transitive.node"), addon);
    const inventoryPath = join(fixture.runtimeDir, "artifact-manifest.json");
    const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
    inventory.files.push({
      path: "transitive.node",
      size: addon.length,
      sha256: sha256(addon),
    });
    writeFileSync(inventoryPath, JSON.stringify(inventory));
    expect(fixture.verify).toThrow("artifact.wrong_architecture");
  });
});

describe("artifact setup", () => {
  it.each(["headers", "body"])(
    "joins cancellation while waiting for download %s and removes only its owned work",
    async (phase) => {
      const fixture = await releaseFixture();
      const cache = tempDir();
      const controller = new AbortController();
      const failure = new Error("render interrupted during acquisition");
      let started!: () => void;
      const downloading = new Promise<void>((resolve) => {
        started = resolve;
      });
      let joined = false;
      const fetch = (async (_url, options) => {
        expect(options?.signal).toBe(controller.signal);
        if (phase === "headers") {
          return new Promise((_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => {
                setImmediate(() => {
                  joined = true;
                  reject(options.signal?.reason);
                });
              },
              { once: true },
            );
            started();
          });
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              stream.enqueue(readFileSync(fixture.archive).subarray(0, 100));
              started();
            },
            cancel() {
              return new Promise<void>((resolve) => {
                setImmediate(() => {
                  joined = true;
                  resolve();
                });
              });
            },
          }),
        );
      }) as typeof globalThis.fetch;
      const resolver = new ArtifactResolver({
        platform: "win32",
        arch: "x64",
        manifest: fixture.manifest,
        env: { VELOCAST_CACHE_DIR: cache },
        fetch,
      });
      const acquisition = new RendererRuntimeAcquisition({
        env: {},
        resolveRendererBinary: () => undefined,
        artifactResolver: resolver,
      });
      const acquiring = acquisition.acquire(undefined, controller.signal);
      await downloading;
      controller.abort(failure);
      await expect(acquiring).rejects.toBe(failure);
      expect(joined).toBe(true);
      expect(findNames(cache, ".partial-")).toEqual([]);
      expect(findNames(cache, ".staging-")).toEqual([]);
      expect(findNames(cache, ".lock")).toEqual([]);
      expect(resolver.inspect()).toBeUndefined();
    },
  );

  it("preserves an aged active owner's lock and staging when a waiter is cancelled", async () => {
    const fixture = await releaseFixture();
    const cache = tempDir();
    const holder = new AbortController();
    const waiter = new AbortController();
    let downloading!: () => void;
    const downloadStarted = new Promise<void>((resolve) => {
      downloading = resolve;
    });
    const fetch = vi.fn(
      (async (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true },
          );
          downloading();
        })) as typeof globalThis.fetch,
    );
    const resolver = new ArtifactResolver({
      platform: "win32",
      arch: "x64",
      manifest: fixture.manifest,
      env: { VELOCAST_CACHE_DIR: cache },
      fetch,
    });
    const owningSetup = resolver.setup(holder.signal);
    let waitingSetup: ReturnType<ArtifactResolver["setup"]> | undefined;
    const failure = new Error("waiting render interrupted");
    try {
      await downloadStarted;
      const lock = join(cache, findNames(cache, ".lock")[0]!);
      const staging = join(cache, findNames(cache, ".staging-")[0]!);
      const sentinel = join(staging, "in-progress.txt");
      writeFileSync(sentinel, "active download");
      const old = new Date(Date.now() - 11 * 60_000);
      utimesSync(lock, old, old);
      const work = [findNames(cache, ".lock"), findNames(cache, ".staging-")];
      waitingSetup = resolver.setup(waiter.signal);
      await new Promise<void>((resolve) => setImmediate(resolve));
      waiter.abort(failure);
      await expect(waitingSetup).rejects.toBe(failure);
      expect([
        findNames(cache, ".lock"),
        findNames(cache, ".staging-"),
      ]).toEqual(work);
      expect(readFileSync(sentinel, "utf8")).toBe("active download");
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      waiter.abort(failure);
      holder.abort(failure);
      await Promise.allSettled([owningSetup, waitingSetup]);
    }
    expect(findNames(cache, ".lock")).toEqual([]);
    expect(findNames(cache, ".staging-")).toEqual([]);
  });

  it("inspects verified Linux overrides without changing permissions, then prepares on setup", async () => {
    const fixture = await releaseFixture("linux-x64-gnu");
    const binary = join(fixture.runtimeDir, fixture.artifact.renderer);
    const inventorySha = sha256(
      readFileSync(join(fixture.runtimeDir, "artifact-manifest.json")),
    );
    const resolver = new ArtifactResolver({
      platform: "linux",
      arch: "x64",
      manifest: fixture.manifest,
      env: {
        VELOCAST_TEST_LIBC: "glibc",
        VELOCAST_TEST_GLIBC_VERSION: "2.40",
        VELOCAST_TEST_OS_VERSION: "6.0.0",
        VELOCAST_ARTIFACT_DIR: fixture.runtimeDir,
        VELOCAST_ARTIFACT_MANIFEST_SHA256: inventorySha,
      },
    });
    chmodSync(binary, 0o444);
    const mode = statSync(binary).mode;

    expect(resolver.inspect()?.source).toBe("local-override");
    expect(statSync(binary).mode).toBe(mode);
    expect((await resolver.setup()).source).toBe("local-override");
    expect(statSync(binary).mode & 0o200).toBe(0o200);
  });

  it("does not inspect a Linux cache as ready when its declared renderer is absent", async () => {
    const fixture = await releaseFixture("linux-x64-gnu");
    const resolver = new ArtifactResolver({
      platform: "linux",
      arch: "x64",
      manifest: fixture.manifest,
      env: {
        VELOCAST_TEST_LIBC: "glibc",
        VELOCAST_TEST_GLIBC_VERSION: "2.40",
        VELOCAST_TEST_OS_VERSION: "6.0.0",
        VELOCAST_CACHE_DIR: tempDir(),
      },
      fetch: (async () =>
        new Response(readFileSync(fixture.archive))) as typeof globalThis.fetch,
    });
    const cached = await resolver.setup();
    fixture.artifact.renderer = "bin/absent-renderer";

    expect(resolver.inspect()).toBeUndefined();
    expect(readFileSync(cached.rendererBinary)).toEqual(
      readFileSync(join(fixture.runtimeDir, "velocast-renderer")),
    );
    await expect(resolver.setup()).rejects.toThrow(
      "artifact.runtime_missing: bin/absent-renderer",
    );
  });

  it("serializes concurrent setup and reuses the verified cache offline", async () => {
    const fixture = await releaseFixture();
    let downloads = 0;
    const cache = tempDir();
    const fetch = async () => {
      downloads += 1;
      return new Response(readFileSync(fixture.archive));
    };
    const resolver = new ArtifactResolver({
      platform: "win32",
      arch: "x64",
      manifest: fixture.manifest,
      env: { VELOCAST_CACHE_DIR: cache },
      fetch: fetch as typeof globalThis.fetch,
    });

    const [first, second] = await Promise.all([
      resolver.setup(),
      resolver.setup(),
    ]);
    expect(downloads).toBe(1);
    expect(first.artifactDir).toBe(second.artifactDir);
    expect([first.source, second.source].sort()).toEqual(["cache", "download"]);

    const offline = new ArtifactResolver({
      platform: "win32",
      arch: "x64",
      manifest: fixture.manifest,
      env: { VELOCAST_CACHE_DIR: cache, VELOCAST_OFFLINE: "1" },
      fetch: (() => {
        throw new Error("network must not be used");
      }) as typeof globalThis.fetch,
    });
    expect((await offline.setup()).source).toBe("cache");
  });

  it("times out without removing an occupied lock and supports confirmed manual recovery", async () => {
    const fixture = await releaseFixture();
    const cache = tempDir();
    const artifact = fixture.manifest.targets["win32-x64"].artifact;
    if (!artifact) throw new Error("fixture artifact missing");
    const lock = join(
      cache,
      `artifact-schema-${fixture.manifest.artifactSchemaVersion}`,
      fixture.manifest.nativeRendererVersion,
      "win32-x64",
      `${artifact.sha256}.lock`,
    );
    mkdirSync(lock, { recursive: true });
    const sentinel = join(lock, "owner.txt");
    writeFileSync(sentinel, "preserve until the owner is confirmed stopped");
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(lock, old, old);
    let now = Date.now();
    const fetch = vi.fn(
      async () => new Response(readFileSync(fixture.archive)),
    );
    const resolver = new ArtifactResolver({
      platform: "win32",
      arch: "x64",
      manifest: fixture.manifest,
      env: { VELOCAST_CACHE_DIR: cache },
      fetch,
      now: () => now,
    });

    const waiting = resolver.setup();
    now += 30_000;
    await expect(waiting).rejects.toThrow(
      `artifact.setup_locked: another setup may still be using ${lock}; wait for it to finish, or remove this lock only after confirming no setup is running, then rerun velocast setup`,
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(readFileSync(sentinel, "utf8")).toBe(
      "preserve until the owner is confirmed stopped",
    );

    rmSync(lock, { recursive: true, force: true });
    const result = await resolver.setup();
    expect(fetch).toHaveBeenCalledOnce();
    expect(result.source).toBe("download");
    expect(findNames(cache, ".lock")).toEqual([]);
  });

  it("removes interrupted downloads and never promotes them", async () => {
    const fixture = await releaseFixture();
    const cache = tempDir();
    const resolver = new ArtifactResolver({
      platform: "win32",
      arch: "x64",
      manifest: fixture.manifest,
      env: { VELOCAST_CACHE_DIR: cache },
      fetch: (async () =>
        new Response(Buffer.from("truncated"))) as typeof globalThis.fetch,
    });
    await expect(resolver.setup()).rejects.toThrow("artifact.size_mismatch");
    expect(findNames(cache, ".partial-")).toEqual([]);
    expect(findNames(cache, ".staging-")).toEqual([]);
  });

  it("rejects a same-size archive with the wrong checksum", async () => {
    const fixture = await releaseFixture();
    const resolver = new ArtifactResolver({
      platform: "win32",
      arch: "x64",
      manifest: fixture.manifest,
      env: { VELOCAST_CACHE_DIR: tempDir() },
      fetch: (async () =>
        new Response(
          Buffer.alloc(fixture.artifact.size, 0x5a),
        )) as typeof globalThis.fetch,
    });
    await expect(resolver.setup()).rejects.toThrow(
      "artifact.checksum_mismatch",
    );
  });

  it("inspects a corrupt cache without changing it, then repairs it during acquisition", async () => {
    const fixture = await releaseFixture();
    let downloads = 0;
    const resolver = new ArtifactResolver({
      platform: "win32",
      arch: "x64",
      manifest: fixture.manifest,
      env: { VELOCAST_CACHE_DIR: tempDir() },
      fetch: (async () => {
        downloads += 1;
        return new Response(readFileSync(fixture.archive));
      }) as typeof globalThis.fetch,
    });
    const first = await resolver.setup();
    writeFileSync(first.rendererBinary, "corrupt");
    const sentinel = join(first.artifactDir, "inspection-sentinel.txt");
    writeFileSync(sentinel, "preserve during inspection");
    const inventory = readFileSync(
      join(first.artifactDir, "artifact-manifest.json"),
    );
    const acquisition = new RendererRuntimeAcquisition({
      cwd: tempDir(),
      env: {},
      platform: "win32",
      arch: "x64",
      fallbackTargetDirs: [],
      artifactResolver: resolver,
    });

    expect(acquisition.inspect()).toBeUndefined();
    expect(readFileSync(first.rendererBinary, "utf8")).toBe("corrupt");
    expect(readFileSync(sentinel, "utf8")).toBe("preserve during inspection");
    expect(
      readFileSync(join(first.artifactDir, "artifact-manifest.json")),
    ).toEqual(inventory);
    expect(downloads).toBe(1);

    expect((await acquisition.acquire()).source).toBe("download");
    expect(readFileSync(first.rendererBinary)).toEqual(
      readFileSync(join(fixture.runtimeDir, "velocast-renderer.exe")),
    );
    expect(downloads).toBe(2);
  });

  it("enforces validated requirements before downloading", async () => {
    const fixture = await releaseFixture();
    fixture.manifest.targets["win32-x64"].requirements.validationStatus =
      "blocked";
    let fetched = false;
    const resolver = new ArtifactResolver({
      platform: "win32",
      arch: "x64",
      manifest: fixture.manifest,
      fetch: (async () => {
        fetched = true;
        throw new Error("unexpected");
      }) as typeof globalThis.fetch,
    });
    await expect(resolver.setup()).rejects.toThrow(
      "artifact.requirements_unvalidated",
    );
    expect(fetched).toBe(false);

    const incompatible = await releaseFixture();
    incompatible.manifest.targets["win32-x64"].requirements.minimumOsVersion =
      "9999.0.0";
    const hostResolver = new ArtifactResolver({
      platform: "win32",
      arch: "x64",
      manifest: incompatible.manifest,
      env: { VELOCAST_TEST_OS_VERSION: "10.0.0" },
      fetch: (async () => {
        fetched = true;
        throw new Error("unexpected");
      }) as typeof globalThis.fetch,
    });
    await expect(hostResolver.setup()).rejects.toThrow(
      "artifact.host_incompatible",
    );
    expect(fetched).toBe(false);
  });

  it("fails before downloading when a target has no artifact", async () => {
    const fixture = await releaseFixture();
    fixture.manifest.targets["win32-x64"].artifact = null;
    fixture.manifest.targets["win32-x64"].blocker = "native validation missing";
    let fetched = false;
    const resolver = new ArtifactResolver({
      platform: "win32",
      arch: "x64",
      manifest: fixture.manifest,
      fetch: (async () => {
        fetched = true;
        throw new Error("unexpected");
      }) as typeof globalThis.fetch,
    });
    await expect(resolver.setup()).rejects.toThrow("Available targets: none");
    expect(fetched).toBe(false);
  });

  it("lists only actually available targets for unsupported hosts", async () => {
    const fixture = await releaseFixture();
    const resolver = new ArtifactResolver({
      platform: "aix",
      arch: "ppc64",
      manifest: fixture.manifest,
    });
    await expect(resolver.setup()).rejects.toThrow(
      "Available targets: win32-x64",
    );
  });

  it("accepts only a local override with a trusted inventory digest", async () => {
    const fixture = await releaseFixture();
    const withoutDigest = new ArtifactResolver({
      platform: "win32",
      arch: "x64",
      manifest: fixture.manifest,
      env: { VELOCAST_ARTIFACT_DIR: fixture.runtimeDir },
    });
    await expect(withoutDigest.setup()).rejects.toThrow(
      "artifact.local_override_invalid",
    );

    const inventorySha = sha256(
      readFileSync(join(fixture.runtimeDir, "artifact-manifest.json")),
    );
    const verified = new ArtifactResolver({
      platform: "win32",
      arch: "x64",
      manifest: fixture.manifest,
      env: {
        VELOCAST_ARTIFACT_DIR: fixture.runtimeDir,
        VELOCAST_ARTIFACT_MANIFEST_SHA256: inventorySha,
      },
    });
    expect((await verified.setup()).source).toBe("local-override");
  });
});

async function releaseFixture(
  targetId: "win32-x64" | "linux-x64-gnu" = "win32-x64",
): Promise<{
  archive: string;
  artifact: ReleaseArtifact;
  manifest: VelocastReleaseManifest;
  runtimeDir: string;
  verify(): void;
}> {
  const root = tempDir();
  const runtimeDir = join(root, "velocast");
  mkdirSync(runtimeDir);
  const linux = targetId === "linux-x64-gnu";
  const rendererName = linux ? "velocast-renderer" : "velocast-renderer.exe";
  const helperName = linux ? "helper.so" : "helper.dll";
  const renderer = linux ? elfExecutable() : peExecutable(0x8664);
  writeFileSync(join(runtimeDir, rendererName), renderer);
  writeFileSync(join(runtimeDir, helperName), renderer);
  writeFileSync(join(runtimeDir, "resources.pak"), "resource");
  mkdirSync(join(runtimeDir, "locales"));
  writeFileSync(join(runtimeDir, "locales", "en-US.pak"), "locale");
  for (const file of [
    "electron",
    "main.cjs",
    "media-client.cjs",
    "media-runtime.cjs",
  ])
    writeFileSync(join(runtimeDir, file), "fixture");
  writeFileSync(
    join(runtimeDir, "electron-runtime.json"),
    JSON.stringify({
      schema: "velocast-electron-runtime-v1",
      browserHost: "electron",
      platform: linux ? "linux" : "win32",
      arch: "x64",
      renderer: rendererName,
      electron: "electron",
      hostScript: "main.cjs",
      mediaClient: "media-client.cjs",
      mediaBundle: "media-runtime.cjs",
    }),
  );
  const runtimeFiles = [
    "electron-runtime.json",
    "electron",
    "main.cjs",
    "media-client.cjs",
    "media-runtime.cjs",
    rendererName,
    helperName,
    "resources.pak",
    "locales/en-US.pak",
  ];
  const inventory = {
    schema: "velocast-native-artifact-v1",
    target: targetId,
    sourceCommit: "a".repeat(40),
    packageVersion: "0.1.0",
    nativeRendererVersion: "0.1.0",
    protocolVersion: 1,
    files: runtimeFiles.map((path) => {
      const bytes = readFileSync(join(runtimeDir, path));
      return { path, size: bytes.length, sha256: sha256(bytes) };
    }),
  };
  writeFileSync(
    join(runtimeDir, "artifact-manifest.json"),
    `${JSON.stringify(inventory)}\n`,
  );
  const archive = join(root, `velocast-${targetId}.tar.gz`);
  await create({ gzip: true, cwd: root, file: archive }, ["velocast"]);
  const archiveBytes = readFileSync(archive);
  const artifact: ReleaseArtifact = {
    name: `velocast-${targetId}.tar.gz`,
    url: `https://artifacts.invalid/velocast-${targetId}.tar.gz`,
    format: "tar.gz",
    size: archiveBytes.length,
    sha256: sha256(archiveBytes),
    sourceCommit: "a".repeat(40),
    renderer: rendererName,
    root: "velocast",
  };
  const manifest = fakeManifest(artifact, targetId);
  return {
    archive,
    artifact,
    runtimeDir,
    manifest,
    verify: () =>
      verifyRuntimeDirectory(
        runtimeDir,
        targetId,
        manifest.targets[targetId],
        artifact,
        manifest,
      ),
  };
}

function fakeManifest(
  artifact: ReleaseArtifact,
  targetId: "win32-x64" | "linux-x64-gnu" = "win32-x64",
): VelocastReleaseManifest {
  const linux = targetId === "linux-x64-gnu";
  const helperName = linux ? "helper.so" : "helper.dll";
  const target = {
    platform: linux ? ("linux" as const) : ("win32" as const),
    arch: "x64",
    libc: linux ? ("glibc" as const) : null,
    rustTarget: "x86_64-pc-windows-msvc",
    toolchain: "test",
    minimumHost: "test",
    runner: "test",
    backend: "test",
    signing: "test",
    runtimeFiles: [
      "electron-runtime.json",
      "electron",
      "main.cjs",
      "media-client.cjs",
      "media-runtime.cjs",
      artifact.renderer,
      helperName,
      "resources.pak",
      "locales/en-US.pak",
    ],
    nativeFiles: [artifact.renderer, helperName],
    requirements: {
      validationStatus: "validated" as const,
      minimumOsVersion: "0.0.0",
      minimumGlibcVersion: linux ? "2.17" : null,
      gpuRequired: true,
      captureBackends: ["test-capture"],
      conversionBackends: ["test-conversion"],
      encoderBackends: ["test-encoder"],
      softwareFallbackRequired: false,
      softwareFallbackImplemented: false,
    },
    artifact,
    blocker: null,
  };
  const ids: ReleaseTargetId[] = [
    "win32-x64",
    "win32-arm64",
    "darwin-x64",
    "darwin-arm64",
    "linux-x64-gnu",
    "linux-arm64-gnu",
  ];
  return {
    schema: "velocast-release-manifest-v1",
    artifactSchemaVersion: 1,
    releaseChannel: "test",
    productVersion: "0.1.0",
    packageVersion: "0.1.0",
    nativeRendererVersion: "0.1.0",
    protocolVersion: 1,
    electronVersion: "test",
    chromiumVersion: "test",
    sourceCommit: "a".repeat(40),
    distributionModel: "cli-download",
    targets: Object.fromEntries(
      ids.map((id) => [
        id,
        id === targetId
          ? target
          : { ...target, artifact: null, blocker: "test blocker" },
      ]),
    ) as VelocastReleaseManifest["targets"],
  };
}

function peExecutable(machine: number): Buffer {
  const bytes = Buffer.alloc(512);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write("PE\0\0", 0x80, "ascii");
  bytes.writeUInt16LE(machine, 0x84);
  return bytes;
}

function elfExecutable(): Buffer {
  const bytes = Buffer.alloc(64);
  bytes[0] = 0x7f;
  bytes.write("ELF", 1, "ascii");
  bytes.writeUInt16LE(0x3e, 18);
  return bytes;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "velocast-artifact-test-"));
  tempDirs.push(dir);
  return dir;
}

function findNames(root: string, substring: string): string[] {
  return readdirSync(root, { recursive: true })
    .map(String)
    .filter((name) => name.includes(substring));
}

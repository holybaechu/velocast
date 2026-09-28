import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RendererRuntimeResolver,
  resolveRendererBinary,
  resolveRendererBinaryPath,
} from "./renderer-binary.js";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const caps = {
  outputApiVersion: 1,
  browserHosts: ["electron"],
  defaultBrowserHost: "electron",
  electronHostProtocolVersion: 3,
  supportedMediaBackends: ["webcodecs", "native"],
  videoEncoderBackend: "webcodecs",
  mediaRuntime: "mediabunny",
  hardwareAccelerationGuarantee: false,
};
function fixture(platform: NodeJS.Platform = "win32") {
  const cwd = mkdtempSync(join(tmpdir(), "velocast-discovery-"));
  dirs.push(cwd);
  const exe =
    platform === "win32" ? "velocast-renderer.exe" : "velocast-renderer";
  const binary = join(cwd, "target/debug", exe);
  const electron = join(cwd, "electron");
  const host = join(cwd, "main.cjs");
  for (const path of [binary, electron, host]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "fixture");
  }
  const env = {
    VELOCAST_ELECTRON_BINARY: electron,
    VELOCAST_ELECTRON_HOST_SCRIPT: host,
  };
  return {
    cwd,
    binary,
    exe,
    env,
    options: {
      cwd,
      platform,
      arch: "x64",
      env,
      fallbackTargetDirs: [] as string[],
      spawnRendererCapabilities: () => ({
        status: 0,
        stdout: JSON.stringify(caps),
        stderr: "",
      }),
    },
  };
}
describe("native binary discovery", () => {
  it("preserves env/config/package/cache precedence", () => {
    expect(
      resolveRendererBinaryPath({
        env: { VELOCAST_RENDERER_BINARY: "env" },
        configBinary: "config",
        platformPackageBinary: "package",
      }),
    ).toEqual({ path: "env", source: "env" });
    expect(
      resolveRendererBinaryPath({
        env: {},
        configBinary: "config",
        platformPackageBinary: "package",
      }).source,
    ).toBe("config");
    expect(
      resolveRendererBinaryPath({
        env: {},
        platformPackageBinary: "package",
        managedCacheBinary: "cache",
      }).source,
    ).toBe("platform-package");
    expect(() => resolveRendererBinaryPath({ env: {} })).toThrow(
      "renderer.binary_unavailable",
    );
  });
  it("resolves configured relative paths using invocation cwd", () => {
    const f = fixture();
    expect(resolveRendererBinary("custom/renderer", f.options)).toBe(
      join(f.cwd, "custom/renderer"),
    );
    expect(
      resolveRendererBinary("custom", {
        ...f.options,
        env: { ...f.env, VELOCAST_RENDERER_BINARY: "override" },
      }),
    ).toBe("override");
  });
  it.each(["win32", "linux", "darwin"] as const)(
    "checks Electron capability negotiation for automatic %s binaries",
    (platform) => {
      const f = fixture(platform);
      const resolver = new RendererRuntimeResolver(f.options);
      expect(resolver.resolve().binary).toBe(f.binary);
      const stale = new RendererRuntimeResolver({
        ...f.options,
        spawnRendererCapabilities: () => ({
          status: 0,
          stdout: '{"outputApiVersion":1}',
          stderr: "",
        }),
      });
      expect(() => stale.resolveBinary()).toThrow(
        "renderer.binary_unavailable",
      );
    },
  );
  it("skips a stale preferred release binary and chooses a capable debug binary", () => {
    const f = fixture();
    const release = join(f.cwd, "target/release", f.exe);
    mkdirSync(dirname(release));
    writeFileSync(release, "old");
    const resolver = new RendererRuntimeResolver({
      ...f.options,
      spawnRendererCapabilities: (binary) => ({
        status: 0,
        stdout: JSON.stringify(
          binary === release ? { outputApiVersion: 1 } : caps,
        ),
        stderr: "",
      }),
    });
    expect(resolver.resolveBinary()).toBe(f.binary);
  });
  it("rejects explicitly selected legacy or dual-host binaries before launch", () => {
    const f = fixture();
    const resolver = new RendererRuntimeResolver({
      ...f.options,
      spawnRendererCapabilities: () => ({
        status: 0,
        stdout: JSON.stringify({
          ...caps,
          browserHosts: ["cef", "electron"],
          defaultBrowserHost: "cef",
        }),
        stderr: "",
      }),
    });
    expect(() => resolver.resolve(f.binary)).toThrow(
      "renderer.electron_unsupported",
    );
  });
  it("memoizes capabilities and returns independent environment copies", () => {
    const f = fixture();
    let probes = 0;
    const resolver = new RendererRuntimeResolver({
      ...f.options,
      spawnRendererCapabilities: () => {
        probes++;
        return { status: 0, stdout: JSON.stringify(caps), stderr: "" };
      },
    });
    const first = resolver.resolve();
    first.env.VELOCAST_BROWSER = "changed";
    expect(resolver.resolve().env.VELOCAST_BROWSER).toBe("electron");
    expect(probes).toBe(1);
  });
  it("keeps configured paths separate from automatic cache keys", () => {
    const f = fixture();
    const resolver = new RendererRuntimeResolver(f.options);
    expect(resolver.resolveBinary()).toBe(f.binary);
    expect(resolver.resolveBinary("<auto>")).toBe(join(f.cwd, "<auto>"));
  });
  it("rejects retired browser selection before candidate filtering", () => {
    const f = fixture();
    expect(() =>
      resolveRendererBinary("auto", {
        ...f.options,
        env: { ...f.env, VELOCAST_BROWSER: "cef" },
      }),
    ).toThrow("browser.host_not_supported");
  });
  it("honors CARGO_TARGET_DIR before checkout and fallback targets", () => {
    const f = fixture();
    const target = join(f.cwd, "custom-target");
    const binary = join(target, "release", f.exe);
    mkdirSync(dirname(binary), { recursive: true });
    writeFileSync(binary, "fixture");
    expect(
      resolveRendererBinary("auto", {
        ...f.options,
        env: { ...f.env, CARGO_TARGET_DIR: target },
      }),
    ).toBe(binary);
  });
});

it("keeps developer DLL paths available while diagnosing missing Electron files", () => {
  const f = fixture();
  rmSync(f.env.VELOCAST_ELECTRON_BINARY);
  const dllDirectory = join(f.cwd, "native-dlls");
  mkdirSync(dllDirectory);
  mkdirSync(join(f.cwd, ".velocast"));
  writeFileSync(
    join(f.cwd, ".velocast/accelerated-env.ps1"),
    `$pathAdditions = @(\n  '${dllDirectory}'\n)`,
  );
  let inspected = false;
  const resolver = new RendererRuntimeResolver({
    ...f.options,
    spawnRendererCapabilities: (_binary, _args, options) => {
      inspected = true;
      expect((options.env.PATH ?? options.env.Path)?.split(";")).toContain(
        dllDirectory,
      );
      return { status: 0, stdout: JSON.stringify(caps), stderr: "" };
    },
  });
  expect(() => resolver.resolve(f.binary)).toThrow("runtime.electron_missing");
  expect(inspected).toBe(true);
});

it.each([false, true])(
  "discovers the helper output before legacy fallbacks (nested cwd: %s)",
  (nested) => {
    const f = fixture();
    const helperBinary = join(f.cwd, "target/electron/release", f.exe);
    const legacyTarget = join(f.cwd, "legacy-target");
    const legacyBinary = join(legacyTarget, "release", f.exe);
    const packageCwd = join(f.cwd, "packages/project");
    const cargoManifest = join(f.cwd, "crates/renderer/Cargo.toml");
    for (const file of [helperBinary, legacyBinary, cargoManifest]) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "fixture");
    }
    mkdirSync(packageCwd, { recursive: true });
    const visited: string[] = [];
    const resolver = new RendererRuntimeResolver({
      ...f.options,
      cwd: nested ? packageCwd : f.cwd,
      fallbackTargetDirs: [legacyTarget],
      spawnRendererCapabilities: (binary) => {
        visited.push(binary);
        return {
          status: 0,
          stdout: JSON.stringify(
            binary === helperBinary
              ? caps
              : {
                  ...caps,
                  browserHosts: ["cef", "electron"],
                  defaultBrowserHost: "cef",
                },
          ),
          stderr: "",
        };
      },
    });
    expect(resolver.resolveBinary()).toBe(helperBinary);
    expect(visited).toEqual([f.binary, helperBinary]);
  },
);

it("keeps standard Cargo and explicit target precedence over helper output", () => {
  const f = fixture();
  const helperBinary = join(f.cwd, "target/electron/release", f.exe);
  const explicitTarget = join(f.cwd, "custom-target");
  const explicitBinary = join(explicitTarget, "release", f.exe);
  for (const file of [helperBinary, explicitBinary]) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "fixture");
  }
  expect(new RendererRuntimeResolver(f.options).resolveBinary()).toBe(f.binary);
  expect(
    new RendererRuntimeResolver({
      ...f.options,
      env: { ...f.env, CARGO_TARGET_DIR: explicitTarget },
    }).resolveBinary(),
  ).toBe(explicitBinary);
});

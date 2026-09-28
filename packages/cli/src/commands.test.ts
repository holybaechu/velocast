import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Config } from "@velocast/core";
import { afterEach, describe, expect, it } from "vitest";
import { RendererRuntimeResolver } from "./renderer-binary.js";
import { RendererRuntimeAcquisition } from "./renderer-runtime.js";
import { loadConfigFromPath } from "./config-loader.js";
import {
  doctorCommand,
  executeRendererJob,
  probeCapture,
  renderComposition,
  renderUrl,
  parseCliCodec,
  resolveRendererCodec,
} from "./commands.js";

const tempDirs: string[] = [];
function fakeRuntimeResolver(): RendererRuntimeResolver {
  const resolver = new RendererRuntimeResolver();
  resolver.resolveProcessEnv = () => ({});
  return resolver;
}

afterEach(() => {
  cleanupTempDirs();
});

describe("doctorCommand", () => {
  it.each(["local", "cache"] as const)(
    "probes an inspected %s runtime with its complete environment",
    async (source) => {
      const writes: string[] = [];
      const runtime = {
        binary: "/verified/velocast-renderer",
        source,
        env: {
          VELOCAST_ELECTRON_BINARY: "/verified/electron",
          LD_LIBRARY_PATH: "/verified:/usr/lib",
          FEATURE_FLAG: "enabled",
        },
      };
      let probeEnv: NodeJS.ProcessEnv | undefined;
      let capabilityEnv: NodeJS.ProcessEnv | undefined;
      await doctorCommand(
        { json: true },
        {
          write: (value) => writes.push(value),
          runtimeAcquisition: { inspect: () => runtime },
          artifactResolver: {
            inspect: () => {
              throw new Error("use the acquisition adapter");
            },
          },
          probeHost: (options) => {
            probeEnv = options?.env;
            capabilityEnv = options?.resolveRendererProcessEnv?.({
              rendererBinary: runtime.binary,
            });
            return {
              platform: "linux",
              arch: "x64",
              rendererBinary: options?.env?.VELOCAST_RENDERER_BINARY,
              browserRuntime: {
                host: "electron" as const,
                available: true,
                gpuCaptureSupported: true,
              },

              webCodecsAvailable: true,
            };
          },
        },
      );

      const expectedEnv = {
        ...runtime.env,
        VELOCAST_RENDERER_BINARY: runtime.binary,
      };
      expect(probeEnv).toEqual(expectedEnv);
      expect(capabilityEnv).toEqual(expectedEnv);
      expect(JSON.parse(writes.join(""))).toMatchObject({
        rendererBinary: runtime.binary,
      });
    },
  );

  it("preserves an existing local renderer without requiring a managed artifact", async () => {
    const writes: string[] = [];
    const localProbe = {
      platform: "win32" as const,
      arch: "x64",
      rendererBinary: "C:\\vc-target\\debug\\velocast-renderer.exe",
      browserRuntime: {
        host: "electron" as const,
        available: true,
        gpuCaptureSupported: true,
      },
      requiredGpuPrerequisites: [],
      requiredGpuBackends: [],

      webCodecsAvailable: true,
    };

    await doctorCommand(
      { json: true },
      {
        write: (value) => writes.push(value),
        probeHost: () => localProbe,
        artifactResolver: {
          inspect: () => {
            throw new Error("managed resolver must remain a fallback");
          },
        },
      },
    );

    expect(JSON.parse(writes.join(""))).toMatchObject({
      rendererBinary: localProbe.rendererBinary,
    });
  });

  it("reports legacy host readiness when no managed artifact is available", async () => {
    const writes: string[] = [];
    const unavailableProbe = {
      platform: "win32" as const,
      arch: "x64",
      browserRuntime: {
        host: "electron" as const,
        available: false,
        gpuCaptureSupported: true,
      },
      requiredGpuPrerequisites: [],
      requiredGpuBackends: [],

      webCodecsAvailable: true,
    };

    await doctorCommand(
      { json: true },
      {
        write: (value) => writes.push(value),
        probeHost: () => unavailableProbe,
        artifactResolver: { inspect: () => undefined },
      },
    );

    expect(JSON.parse(writes.join(""))).toMatchObject({
      requiredGpu: {
        available: false,
        reason: "renderer binary unavailable",
      },
    });
  });

  it("prints doctor JSON when requested", async () => {
    const writes: string[] = [];
    await doctorCommand(
      { json: true },
      {
        write: (value) => writes.push(value),
        probe: () => ({
          platform: "win32",
          arch: "x64",
          rendererBinary: "/tmp/velocast-renderer",
          browserRuntime: {
            host: "electron" as const,
            available: true,
            gpuCaptureSupported: true,
          },
          displayVariablesUnset: true,
          requiredGpuBackends: [
            {
              backend: "webcodecs",
              available: true,
              packetWriterAvailable: true,
            },
          ],

          webCodecsAvailable: true,
          requiredGpuPacketWriterAvailable: true,
        }),
      },
    );

    expect(JSON.parse(writes.join(""))).toMatchObject({
      requiredGpu: { available: true, backend: "webcodecs" },
    });
  });

  it("prints the selected Windows required GPU backend in text output", async () => {
    const writes: string[] = [];
    await doctorCommand(
      { json: false },
      {
        write: (value) => writes.push(value),
        probe: () => ({
          platform: "win32",
          arch: "x64",
          rendererBinary: "C:\\vc-target\\debug\\velocast-renderer.exe",
          browserRuntime: {
            host: "electron" as const,
            available: true,
            gpuCaptureSupported: true,
          },
          requiredGpuPrerequisites: [],
          requiredGpuBackends: [
            {
              backend: "webcodecs",
              available: true,
              packetWriterAvailable: true,
            },
          ],

          webCodecsAvailable: true,
        }),
      },
    );

    const output = writes.join("");
    expect(output).toContain("Velocast doctor (win32/x64)");
    expect(output).toContain("Required GPU: available");
    expect(output).toContain("Backend: webcodecs");
    expect(output).toContain("WebCodecs runtime: available");
  });

  it("prints Windows backend candidates without claiming one was selected", async () => {
    const writes: string[] = [];
    await doctorCommand(
      { json: false },
      {
        write: (value) => writes.push(value),
        probe: () => ({
          platform: "win32",
          arch: "x64",
          rendererBinary: "C:\\vc-target\\debug\\velocast-renderer.exe",
          browserRuntime: {
            host: "electron" as const,
            available: true,
            gpuCaptureSupported: true,
          },
          requiredGpuPrerequisites: [],
          requiredGpuBackends: [
            {
              backend: "webcodecs",
              available: true,
              packetWriterAvailable: true,
            },
            {
              backend: "webcodecs",
              available: true,
              packetWriterAvailable: true,
            },
          ],

          webCodecsAvailable: true,
        }),
      },
    );

    const output = writes.join("");
    expect(output).toContain("Required GPU: available");
    expect(output).toContain("Backend candidates: webcodecs, webcodecs");
    expect(output).not.toContain("Backend: webcodecs");
  });

  it("prints structured doctor diagnostics in JSON when required GPU is unavailable", async () => {
    const writes: string[] = [];
    await doctorCommand(
      { json: true },
      {
        write: (value) => writes.push(value),
        probe: () => ({
          platform: "win32",
          arch: "x64",
          rendererBinary: "/tmp/velocast-renderer",
          browserRuntime: {
            host: "electron" as const,
            available: true,
            gpuCaptureSupported: true,
          },
          requiredGpuPrerequisites: [
            {
              available: false,
              code: "platform.device_unavailable",
              reason: "GPU device unavailable",
            },
          ],
          requiredGpuBackends: [
            {
              backend: "webcodecs",
              available: false,
              unavailableCode: "encoder.codec_unavailable",
              reason: "WebCodecs encoder webcodecs unavailable",
              packetWriterAvailable: true,
            },
          ],

          webCodecsAvailable: true,
        }),
      },
    );

    expect(JSON.parse(writes.join(""))).toMatchObject({
      requiredGpu: {
        available: false,
        reason: "GPU device unavailable",
        diagnostics: [
          {
            kind: "prerequisite",
            code: "platform.device_unavailable",
            reason: "GPU device unavailable",
          },
        ],
      },
    });
  });

  it("prints software fallback reasons in text output", async () => {
    const writes: string[] = [];
    await doctorCommand(
      { json: false },
      {
        write: (value) => writes.push(value),
        probe: () => ({
          platform: "win32",
          arch: "x64",
          rendererBinary: "/tmp/velocast-renderer",
          browserRuntime: {
            host: "electron" as const,
            available: true,
            gpuCaptureSupported: true,
          },
          requiredGpuPrerequisites: [
            {
              available: false,
              code: "platform.device_unavailable",
              reason: "GPU device unavailable",
            },
          ],
          requiredGpuBackends: [
            {
              backend: "webcodecs",
              available: false,
              reason: "WebCodecs encoder webcodecs unavailable",
              packetWriterAvailable: true,
            },
          ],

          webCodecsAvailable: false,
        }),
      },
    );

    const output = writes.join("");
    expect(output).toContain("Required GPU: unavailable");
    expect(output).toContain("Reason: GPU device unavailable");
    expect(output).toContain("Diagnostics:");
    expect(output).toContain(
      "- platform.device_unavailable: GPU device unavailable",
    );
    expect(output).toContain("WebCodecs runtime: unavailable");
    expect(output).toContain(
      "WebCodecs runtime reason: WebCodecs runtime unavailable",
    );
  });
});

describe("command entrypoint exports", () => {
  it("re-exports codec helpers", () => {
    expect(parseCliCodec(" av1 ")).toBe("av1");
    expect(
      resolveRendererCodec({
        renderer: { codec: " hevc " },
      } as unknown as Config),
    ).toBe("hevc");
  });
});

describe("executeRendererJob", () => {
  it("uses config-file-relative snapshot paths for probes and closes after success", async () => {
    const project = mkTempDir("velocast-snapshot-config-");
    const invocation = mkTempDir("velocast-snapshot-invocation-");
    mkdirSync(join(project, "dist"));
    writeFileSync(join(project, "dist/index.html"), "project entry");
    writeFileSync(
      join(project, "velocast.config.mjs"),
      `export default {entry:"dist/index.html",renderer:{snapshotRoot:"dist"},serve:{command:"must not start"}}`,
    );
    const config = await loadConfigFromPath(
      join(project, "velocast.config.mjs"),
      { cwd: invocation, env: {} },
    );
    expect(config.renderer?.snapshotRoot).toBe(join(project, "dist"));
    let url = "";
    await executeRendererJob(
      {
        kind: "capture-probe",
        config,
        compositionId: "hero",
        options: { report: "probe.json" },
      },
      {
        pathOptions: { cwd: invocation, env: {} },
        runtimeResolver: fakeRuntimeResolver(),
        resolveRendererBinary: () => "renderer",
        runRenderer: async (_binary, value) => {
          const job = value as {
            serve_url: string;
            render_session: { sessionId: string; sourceVersion: string };
            report_path: string;
            input_props_path?: string;
          };
          url = job.serve_url;
          expect(await (await fetch(url)).text()).toBe("project entry");
          expect(job.render_session.sourceVersion).toMatch(/^[a-f0-9]{64}$/);
          expect(job.input_props_path).toBeUndefined();
          expect(job.report_path).toBe(join(invocation, "probe.json"));
        },
      },
    );
    await expect(fetch(url)).rejects.toThrow();
  });

  it("rejects snapshotting live serve URLs or render-url before acquiring a renderer", async () => {
    const dependencies = {
      runtimeResolver: fakeRuntimeResolver(),
      resolveRendererBinary: () => {
        throw new Error("must reject before acquisition");
      },
    };
    await expect(
      executeRendererJob(
        {
          kind: "composition",
          config: {
            entry: "missing.html",
            serve: { url: "http://127.0.0.1:9999" },
            renderer: { snapshotRoot: "dist" },
          },
          compositionId: "hero",
          output: "out.mp4",
        },
        dependencies,
      ),
    ).rejects.toThrow("snapshot.requires_local_entry");
    await expect(
      executeRendererJob(
        {
          kind: "capture-probe",
          config: { renderer: { snapshotRoot: "dist" } },
          compositionId: "hero",
          options: { report: "report.json" },
        },
        dependencies,
      ),
    ).rejects.toThrow("snapshot.requires_local_entry");
    await expect(
      executeRendererJob(
        {
          kind: "url",
          config: { renderer: { snapshotRoot: "dist" } },
          url: "http://127.0.0.1:9999",
          selector: "#root",
          output: "out.mp4",
        },
        dependencies,
      ),
    ).rejects.toThrow("snapshot.requires_local_entry");
  });

  it("sends stable source digests but fresh sessions for separately executed unchanged snapshots", async () => {
    const cwd = mkTempDir("velocast-snapshot-identities-");
    writeFileSync(join(cwd, "index.html"), "same source");
    const sessions: Array<{ sessionId: string; sourceVersion: string }> = [];
    for (let run = 0; run < 2; run++) {
      await executeRendererJob(
        {
          kind: "composition",
          config: { entry: "index.html", renderer: { snapshotRoot: cwd } },
          compositionId: "hero",
          output: join(cwd, "out.mp4"),
        },
        {
          pathOptions: { cwd, env: {} },
          runtimeResolver: fakeRuntimeResolver(),
          resolveRendererBinary: () => "renderer",
          runRenderer: async (_binary, job) => {
            sessions.push(
              (
                job as {
                  render_session: { sessionId: string; sourceVersion: string };
                }
              ).render_session,
            );
          },
        },
      );
    }
    expect(sessions[1]!.sourceVersion).toBe(sessions[0]!.sourceVersion);
    expect(sessions[1]!.sessionId).not.toBe(sessions[0]!.sessionId);
  });

  it("keeps one frozen session alive for both workers and cleans up after renderer failure", async () => {
    const invocation = mkTempDir("velocast-command-snapshot-");
    const root = join(invocation, "dist");
    mkdirSync(root);
    writeFileSync(join(root, "index.html"), "original entry");
    writeFileSync(join(root, "asset.js"), "original asset");
    const props = join(invocation, "props.json");
    writeFileSync(props, '{"title":"original"}');
    const output = join(invocation, "output.mp4");
    writeFileSync(output, "previous completed output");
    let launched:
      | {
          serve_url: string;
          input_props_path: string;
          render_session: { sessionId: string; sourceVersion: string };
        }
      | undefined;
    const rendererFailure = new Error(
      "simulated renderer cancellation after workers joined",
    );
    await expect(
      executeRendererJob(
        {
          kind: "composition",
          config: {
            entry: "dist/index.html",
            serve: { command: "this command must never run" },
            renderer: { snapshotRoot: "dist" },
          },
          compositionId: "hero",
          output: "output.mp4",
          options: { inputPropsFile: "props.json" },
        },
        {
          pathOptions: { cwd: root, env: { INIT_CWD: invocation } },
          runtimeResolver: fakeRuntimeResolver(),
          resolveRendererBinary: () => "renderer",
          runRenderer: async (_binary, job) => {
            launched = job as typeof launched;
            expect(launched!.serve_url).toMatch(/^http:\/\/127\.0\.0\.1:/);
            expect(launched!.input_props_path).not.toBe(props);
            expect(launched!.render_session.sourceVersion).toMatch(
              /^[a-f0-9]{64}$/,
            );
            writeFileSync(join(root, "index.html"), "changed entry");
            writeFileSync(join(root, "asset.js"), "changed asset");
            writeFileSync(props, '{"title":"changed"}');
            const workers = await Promise.all(
              [0, 1].map(async (worker) => {
                if (worker)
                  await new Promise((resolve) => setTimeout(resolve, 20));
                return {
                  source: await (await fetch(launched!.serve_url)).text(),
                  asset: await (
                    await fetch(new URL("/asset.js", launched!.serve_url))
                  ).text(),
                  props: readFileSync(launched!.input_props_path, "utf8"),
                  session: launched!.render_session,
                };
              }),
            );
            expect(workers).toEqual(
              Array(2).fill({
                source: "original entry",
                asset: "original asset",
                props: '{"title":"original"}',
                session: launched!.render_session,
              }),
            );
            throw rendererFailure;
          },
        },
      ),
    ).rejects.toBe(rendererFailure);
    expect(launched).toBeDefined();
    await expect(fetch(launched!.serve_url)).rejects.toThrow();
    expect(existsSync(launched!.input_props_path)).toBe(false);
    expect(readFileSync(output, "utf8")).toBe("previous completed output");
  });

  it("preserves renderer-owned output when final diagnostics fail", async () => {
    const cwd = mkTempDir("velocast-output-ownership-");
    const output = join(cwd, "movie.mp4");
    writeFileSync(output, "previous video");
    const error = new Error(
      "terminal event log failed after output publication",
    );
    await expect(
      executeRendererJob(
        {
          kind: "url",
          config: {},
          url: "http://localhost/animation",
          selector: "#hero",
          output,
        },
        {
          pathOptions: { cwd, env: {} },
          runtimeAcquisition: {
            acquire: async () => ({
              binary: "renderer",
              env: {},
              source: "local",
            }),
          },
          runRenderer: async () => {
            writeFileSync(output, "complete published video");
            throw error;
          },
        },
      ),
    ).rejects.toBe(error);

    expect(readFileSync(output, "utf8")).toBe("complete published video");
  });

  it("passes the acquired runtime environment to the renderer launch adapter", async () => {
    const cwd = mkTempDir("velocast-managed-render-command-");
    const artifactDir = join(cwd, "verified-artifact");
    const binary = join(artifactDir, "velocast-renderer");
    mkdirSync(artifactDir, { recursive: true });
    for (const file of [
      "velocast-renderer",
      "electron",
      "main.cjs",
      "media-client.cjs",
      "media-runtime.cjs",
    ])
      writeFileSync(join(artifactDir, file), "fixture");
    writeFileSync(
      join(artifactDir, "electron-runtime.json"),
      JSON.stringify({
        schema: "velocast-electron-runtime-v1",
        browserHost: "electron",
        platform: "linux",
        arch: "x64",
        renderer: "velocast-renderer",
        electron: "electron",
        hostScript: "main.cjs",
        mediaClient: "media-client.cjs",
        mediaBundle: "media-runtime.cjs",
      }),
    );
    const runtimeAcquisition = new RendererRuntimeAcquisition({
      cwd,
      platform: "linux",
      arch: "x64",
      env: { FEATURE_FLAG: "enabled", LD_LIBRARY_PATH: "/usr/lib" },
      fallbackTargetDirs: [],
      artifactResolver: {
        inspect: () => undefined,
        setup: async () => ({
          targetId: "linux-x64-gnu",
          artifactDir,
          rendererBinary: binary,
          source: "cache",
          artifact: {
            name: "runtime.tar.gz",
            url: "https://example.invalid/runtime.tar.gz",
            format: "tar.gz",
            size: 100,
            sha256: "a".repeat(64),
            sourceCommit: "b".repeat(40),
            renderer: "velocast-renderer",
            root: "runtime",
          },
        }),
      },
    });
    let launched: unknown;

    await executeRendererJob(
      {
        kind: "url",
        config: {},
        url: "http://127.0.0.1:4545/page",
        selector: "#hero",
        output: "render.mp4",
      },
      {
        pathOptions: { cwd, env: {} },
        runtimeAcquisition,
        runtimeResolver: fakeRuntimeResolver(),
        resolveRendererBinary: () => {
          throw new Error("acquisition owns discovery");
        },
        runRenderer: async (rendererBinary, _job, runtime) => {
          launched = { binary: rendererBinary, env: runtime?.env };
        },
      },
    );

    expect(launched).toMatchObject({
      binary,
      env: {
        FEATURE_FLAG: "enabled",
        VELOCAST_BROWSER: "electron",
        VELOCAST_ELECTRON_BINARY: join(artifactDir, "electron"),
        VELOCAST_ELECTRON_HOST_SCRIPT: join(artifactDir, "main.cjs"),
        LD_LIBRARY_PATH: `${artifactDir}:/usr/lib`,
      },
    });
  });

  it("routes composition, probe, and URL requests through one renderer pipeline", async () => {
    const cwd = mkTempDir("velocast-execute-renderer-job-");
    const calls: Array<{ binary: string; job: Record<string, unknown> }> = [];
    const dependencies = {
      pathOptions: { cwd, env: {} },
      runRenderer: async (binary: string, job: unknown) => {
        calls.push({ binary, job: job as Record<string, unknown> });
      },
      runtimeResolver: fakeRuntimeResolver(),
      resolveRendererBinary: (configuredBinary?: string) =>
        `resolved:${configuredBinary ?? "auto"}`,
    };

    await executeRendererJob(
      {
        kind: "composition",
        config: {
          serve: { url: "http://127.0.0.1:4545" },
          renderer: {
            binary: "configured-renderer",
            reportPath: "reports/composition.json",
          },
        },
        compositionId: "product-hero",
        output: "renders/composition.mp4",
      },
      dependencies,
    );
    await executeRendererJob(
      {
        kind: "capture-probe",
        config: { serve: { url: "http://127.0.0.1:4545" } },
        compositionId: "product-hero",
        options: { report: "reports/probe.json" },
      },
      dependencies,
    );
    await executeRendererJob(
      {
        kind: "url",
        config: { renderer: { binary: "url-renderer", acceleration: "off" } },
        url: "http://127.0.0.1:4545/page",
        selector: "#hero",
        output: "renders/url.mp4",
      },
      dependencies,
    );

    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.binary)).toEqual([
      "resolved:configured-renderer",
      "resolved:auto",
      "resolved:url-renderer",
    ]);
    expect(calls.map((call) => call.job.mode)).toEqual([
      "composition",
      "composition",
      "url",
    ]);
    expect(calls[0]?.job).toMatchObject({
      output: join(cwd, "renders/composition.mp4"),
      report_path: join(cwd, "reports/composition.json"),
    });
    expect(calls[1]?.job).toMatchObject({
      capture_probe: "accelerated_paint",
      output: join(cwd, ".velocast/tmp/capture-probe-unused.mp4"),
      report_path: join(cwd, "reports/probe.json"),
    });
    expect(calls[2]?.job).toMatchObject({
      serve_url: "http://127.0.0.1:4545/page",
      selector: "#hero",
      output: join(cwd, "renders/url.mp4"),
    });
    expect(existsSync(join(cwd, "renders"))).toBe(true);
    expect(existsSync(join(cwd, "reports"))).toBe(true);
    expect(existsSync(join(cwd, ".velocast/tmp"))).toBe(true);
  });

  it("reports missing probe report when direct probe requests omit options", async () => {
    await expect(
      executeRendererJob({
        kind: "capture-probe",
        config: { serve: { url: "http://127.0.0.1:4545" } },
        compositionId: "product-hero",
      }),
    ).rejects.toThrow("--report is required for probe-capture");
  });
});

describe("probeCapture", () => {
  it("builds capture-probe jobs without requiring a real output", async () => {
    const jobs: unknown[] = [];
    const cwd = mkTempDir("velocast-probe-capture-paths-");
    await probeCapture(
      { serve: { url: "http://127.0.0.1:4545" } },
      "product-hero",
      { report: "renders/linux-capture-probe.report.json" },
      {
        pathOptions: { cwd, env: {} },
        runRenderer: async (_binary, job) => {
          expect(existsSync(join(cwd, ".velocast/tmp"))).toBe(true);
          expect(existsSync(join(cwd, "renders"))).toBe(true);
          jobs.push(job);
        },
        runtimeResolver: fakeRuntimeResolver(),
        resolveRendererBinary: () => "velocast-renderer",
      },
    );

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      mode: "composition",
      composition_id: "product-hero",
      capture_probe: "accelerated_paint",
      acceleration: "required",
      output: join(cwd, ".velocast/tmp/capture-probe-unused.mp4"),
      report_path: join(cwd, "renders/linux-capture-probe.report.json"),
    });
  });

  it("builds capture-probe jobs from entry-backed configs", async () => {
    const jobs: unknown[] = [];
    const cwd = mkTempDir("velocast-probe-entry-");
    const entry = join(cwd, "index.html");
    writeFileSync(entry, "<!doctype html>");

    await probeCapture(
      { entry: "index.html" },
      "product-hero",
      { report: "reports/capture-probe.report.json" },
      {
        pathOptions: { cwd, env: {} },
        runRenderer: async (_binary, job) => {
          jobs.push(job);
        },
        runtimeResolver: fakeRuntimeResolver(),
        resolveRendererBinary: () => "velocast-renderer",
      },
    );

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      mode: "composition",
      composition_id: "product-hero",
      serve_url: pathToFileURL(entry).href,
      capture_probe: "accelerated_paint",
      report_path: join(cwd, "reports/capture-probe.report.json"),
    });
  });

  it("keeps missing and blank report errors distinct", async () => {
    await expect(
      probeCapture(
        { serve: { url: "http://127.0.0.1:4545" } },
        "product-hero",
        {},
      ),
    ).rejects.toThrow("--report is required for probe-capture");

    await expect(
      probeCapture(
        { serve: { url: "http://127.0.0.1:4545" } },
        "product-hero",
        {
          report: "",
        },
      ),
    ).rejects.toThrow("--report must be a non-empty string");
  });
});

describe("renderComposition", () => {
  it("uses injected renderer dependencies for composition renders", async () => {
    const calls: Array<{ binary: string; job: Record<string, unknown> }> = [];
    const output = join(mkTempDir("velocast-render-composition-"), "out.mp4");

    await renderComposition(
      {
        serve: { url: "http://127.0.0.1:4545" },
        renderer: { binary: "configured-renderer", acceleration: "off" },
      },
      "product-hero",
      output,
      {},
      {
        runRenderer: async (binary, job) => {
          calls.push({ binary, job: job as Record<string, unknown> });
        },
        runtimeResolver: fakeRuntimeResolver(),
        resolveRendererBinary: (configuredBinary) =>
          `resolved:${configuredBinary ?? "auto"}`,
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      binary: "resolved:configured-renderer",
      job: {
        mode: "composition",
        composition_id: "product-hero",
        serve_url: "http://127.0.0.1:4545",
        output,
      },
    });
  });

  it("renders entry-backed composition configs without a serve command", async () => {
    const calls: Array<{ binary: string; job: Record<string, unknown> }> = [];
    const cwd = mkTempDir("velocast-render-entry-");
    const entry = join(cwd, "index.html");
    const output = join(cwd, "out.mp4");
    writeFileSync(entry, "<!doctype html>");

    await renderComposition(
      {
        entry: "index.html",
        renderer: { binary: "configured-renderer", acceleration: "off" },
      },
      "product-hero",
      output,
      {},
      {
        pathOptions: { cwd, env: {} },
        runRenderer: async (binary, job) => {
          calls.push({ binary, job: job as Record<string, unknown> });
        },
        runtimeResolver: fakeRuntimeResolver(),
        resolveRendererBinary: (configuredBinary) =>
          `resolved:${configuredBinary ?? "auto"}`,
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      binary: "resolved:configured-renderer",
      job: {
        mode: "composition",
        composition_id: "product-hero",
        serve_url: pathToFileURL(entry).href,
        output,
      },
    });
  });

  it("resolves composition command paths from injected invocation context", async () => {
    const calls: Array<{ job: Record<string, unknown> }> = [];
    const cwd = mkTempDir("velocast-render-composition-paths-");
    writeFileSync(join(cwd, "input-props.json"), '{"title":"Launch"}');

    await renderComposition(
      {
        serve: { url: "http://127.0.0.1:4545" },
        renderer: {
          binary: "configured-renderer",
          acceleration: "off",
          reportPath: "reports/render.json",
        },
      },
      "product-hero",
      "renders/out.mp4",
      { inputPropsFile: "input-props.json" },
      {
        pathOptions: { cwd, env: {} },
        runRenderer: async (_binary, job) => {
          expect(existsSync(join(cwd, "renders"))).toBe(true);
          expect(existsSync(join(cwd, "reports"))).toBe(true);
          calls.push({ job: job as Record<string, unknown> });
        },
        runtimeResolver: fakeRuntimeResolver(),
        resolveRendererBinary: () => "velocast-renderer",
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.job).toMatchObject({
      output: join(cwd, "renders/out.mp4"),
      report_path: join(cwd, "reports/render.json"),
      input_props_path: join(cwd, "input-props.json"),
    });
  });
});

describe("renderUrl", () => {
  it("uses injected renderer dependencies for URL renders", async () => {
    const calls: Array<{ binary: string; job: Record<string, unknown> }> = [];
    const output = join(mkTempDir("velocast-render-url-"), "out.mp4");

    await renderUrl(
      { renderer: { binary: "configured-url-renderer", acceleration: "off" } },
      "http://127.0.0.1:4545/page",
      "#hero",
      output,
      {},
      {
        runRenderer: async (binary, job) => {
          calls.push({ binary, job: job as Record<string, unknown> });
        },
        runtimeResolver: fakeRuntimeResolver(),
        resolveRendererBinary: (configuredBinary) =>
          `resolved:${configuredBinary ?? "auto"}`,
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      binary: "resolved:configured-url-renderer",
      job: {
        mode: "url",
        serve_url: "http://127.0.0.1:4545/page",
        selector: "#hero",
        output,
      },
    });
  });

  it("resolves URL render output and report paths from injected invocation context", async () => {
    const calls: Array<{ job: Record<string, unknown> }> = [];
    const cwd = mkTempDir("velocast-render-url-paths-");

    await renderUrl(
      {
        renderer: {
          binary: "configured-url-renderer",
          acceleration: "off",
          reportPath: "reports/url.json",
        },
      },
      "http://127.0.0.1:4545/page",
      "#hero",
      "renders/url.mp4",
      {},
      {
        pathOptions: { cwd, env: {} },
        runRenderer: async (_binary, job) => {
          expect(existsSync(join(cwd, "renders"))).toBe(true);
          expect(existsSync(join(cwd, "reports"))).toBe(true);
          calls.push({ job: job as Record<string, unknown> });
        },
        runtimeResolver: fakeRuntimeResolver(),
        resolveRendererBinary: () => "velocast-renderer",
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.job).toMatchObject({
      output: join(cwd, "renders/url.mp4"),
      report_path: join(cwd, "reports/url.json"),
    });
  });
});

function mkTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function cleanupTempDirs(): void {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

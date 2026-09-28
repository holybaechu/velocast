import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli, type CliDependencies } from "./cli.js";

const config = { entry: "index.html" };

function commandDependencies() {
  return {
    loadConfigFromPath: vi.fn().mockResolvedValue(config),
    renderComposition: vi.fn().mockResolvedValue(undefined),
    renderUrl: vi.fn().mockResolvedValue(undefined),
    probeCapture: vi.fn().mockResolvedValue(undefined),
    setupCommand: vi.fn().mockResolvedValue(undefined),
    doctorCommand: vi.fn().mockResolvedValue(undefined),
    versionsCommand: vi.fn().mockResolvedValue(undefined),
  } satisfies CliDependencies;
}

function argv(...args: string[]): string[] {
  return ["node", "velocast", ...args];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CLI dispatch", () => {
  it("dispatches official preview configuration and explicit build-watch options", async () => {
    const dependencies = commandDependencies();
    const previewCommand = vi.fn().mockResolvedValue(undefined);
    await runCli(
      argv(
        "preview",
        "--port",
        "0",
        "--watch-command",
        "vite build --watch",
        "--json",
      ),
      { ...dependencies, previewCommand },
    );
    expect(previewCommand).toHaveBeenCalledWith(
      config,
      expect.objectContaining({
        port: 0,
        watchCommand: "vite build --watch",
        json: true,
      }),
    );
  });
  it("forwards the explicit preview auto-refresh opt-out", async () => {
    const dependencies = commandDependencies();
    const previewCommand = vi.fn().mockResolvedValue(undefined);
    await runCli(argv("preview", "--no-auto-refresh"), {
      ...dependencies,
      previewCommand,
    });
    expect(previewCommand).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ autoRefresh: false }),
    );
  });

  it("dispatches browser checks and packaged creative workflows", async () => {
    const dependencies = commandDependencies();
    const auditCommand = vi.fn().mockResolvedValue(undefined);
    await runCli(
      argv(
        "check",
        "lyrics-starter",
        "--frames",
        "0,30",
        "--assertions",
        "audit.json",
        "--json",
      ),
      { ...dependencies, auditCommand },
    );
    expect(auditCommand).toHaveBeenCalledWith(
      config,
      "lyrics-starter",
      expect.objectContaining({
        frames: "0,30",
        assertions: "audit.json",
        json: true,
      }),
    );

    const importTranscriptCommand = vi.fn().mockResolvedValue(undefined);
    await runCli(
      argv(
        "transcript",
        "import",
        "lyrics.srt",
        "--output",
        "lyrics.json",
        "--overwrite",
      ),
      {
        ...dependencies,
        importTranscriptCommand,
      },
    );
    expect(importTranscriptCommand).toHaveBeenCalledWith(
      "lyrics.srt",
      expect.objectContaining({ output: "lyrics.json", overwrite: true }),
    );

    const analyzeMusicCommand = vi.fn().mockResolvedValue(undefined);
    await runCli(
      argv(
        "analyze-audio",
        "song.wav",
        "--output",
        "analysis.json",
        "--overwrite",
      ),
      {
        ...dependencies,
        analyzeMusicCommand,
      },
    );
    expect(analyzeMusicCommand).toHaveBeenCalledWith(
      "song.wav",
      expect.objectContaining({
        output: "analysis.json",
        maxDuration: 900,
        overwrite: true,
      }),
    );
  });
  it("dispatches composition listing, inspection and exact frames using the existing config loader", async () => {
    const dependencies = commandDependencies();
    const inspectCompositions = vi.fn().mockResolvedValue(undefined),
      renderFrame = vi.fn().mockResolvedValue(undefined);
    await runCli(argv("compositions", "--json"), {
      ...dependencies,
      inspectCompositions,
      renderFrame,
    });
    expect(inspectCompositions).toHaveBeenLastCalledWith(
      config,
      undefined,
      expect.objectContaining({ json: true }),
    );
    await runCli(argv("inspect", "hero"), {
      ...dependencies,
      inspectCompositions,
      renderFrame,
    });
    expect(inspectCompositions).toHaveBeenLastCalledWith(
      config,
      "hero",
      expect.anything(),
    );
    await runCli(
      argv("frame", "hero", "--frame", "12", "--output", "frame.png", "--json"),
      { ...dependencies, inspectCompositions, renderFrame },
    );
    expect(renderFrame).toHaveBeenCalledExactlyOnceWith(
      config,
      "hero",
      "frame.png",
      expect.objectContaining({ frame: 12, json: true }),
    );
  });

  it("forwards public half-open range options and JSON without using worker switches", async () => {
    const dependencies = commandDependencies();
    await runCli(
      argv(
        "render",
        "hero",
        "--start-frame",
        "12",
        "--end-frame",
        "90",
        "--output",
        "range.mp4",
        "--json",
      ),
      dependencies,
    );
    expect(dependencies.renderComposition).toHaveBeenCalledExactlyOnceWith(
      config,
      "hero",
      "range.mp4",
      expect.objectContaining({ startFrame: 12, endFrame: 90, json: true }),
    );
  });

  it("prints a structured failure when config loading fails before native execution", async () => {
    const dependencies = commandDependencies();
    dependencies.loadConfigFromPath.mockRejectedValue(
      new Error("config.missing: no config"),
    );
    const output = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await expect(
      runCli(argv("inspect", "hero", "--json"), dependencies),
    ).rejects.toThrow("config.missing");
    const result = JSON.parse(
      output.mock.calls.map((call) => String(call[0])).join(""),
    );
    expect(result).toMatchObject({
      status: "failure",
      operation: "inspect",
      request: { compositionId: "hero" },
      error: { code: "config.missing" },
    });
  });

  it("dispatches init options without loading project configuration", async () => {
    const dependencies = commandDependencies();
    const initCommand = vi.fn().mockResolvedValue(undefined);
    await runCli(argv("init", "new project", "--json"), {
      ...dependencies,
      initCommand,
    });
    expect(initCommand).toHaveBeenCalledExactlyOnceWith("new project", {
      json: true,
    });
    expect(dependencies.loadConfigFromPath).not.toHaveBeenCalled();
    expect(dependencies.setupCommand).not.toHaveBeenCalled();
  });

  it("selects the packaged lyrics starter", async () => {
    const dependencies = commandDependencies();
    const initCommand = vi.fn().mockResolvedValue(undefined);
    await runCli(argv("init", "lyrics", "--template", "lyrics"), {
      ...dependencies,
      initCommand,
    });
    expect(initCommand).toHaveBeenCalledWith("lyrics", {
      json: undefined,
      template: "lyrics",
    });
  });

  it("passes numeric-looking render options to command preparation", async () => {
    const dependencies = commandDependencies();

    await runCli(
      argv(
        "render",
        "hero",
        "--output",
        "out.mp4",
        "--concurrency",
        "2",
        "--bitrate",
        "60000000",
      ),
      dependencies,
    );

    expect(dependencies.loadConfigFromPath).toHaveBeenCalledWith(
      "velocast.config.ts",
    );
    expect(dependencies.renderComposition).toHaveBeenCalledExactlyOnceWith(
      config,
      "hero",
      "out.mp4",
      expect.objectContaining({ concurrency: 2, bitrate: 60_000_000 }),
    );
  });

  it.each([
    {
      name: "composition",
      args: ["render", "hero"],
      command: "renderComposition" as const,
      request: [config, "hero", "out.mp4"],
    },
    {
      name: "URL",
      args: ["render-url", "https://example.com/page", "--selector", "#hero"],
      command: "renderUrl" as const,
      request: [config, "https://example.com/page", "#hero", "out.mp4"],
    },
  ])(
    "forwards every shared $name render option",
    async ({ args, command, request }) => {
      const dependencies = commandDependencies();

      await runCli(
        argv(
          ...args,
          "--config",
          "custom.config.ts",
          "--output",
          "out.mp4",
          "--concurrency",
          "auto",
          "--codec",
          "hevc",
          "--container",
          "mov",
          "--audio-codec",
          "pcm-s24",
          "--media-backend",
          "native",
          "--video-profile",
          "prores_ks",
          "--pixel-format",
          "nv12",
          "--bitrate",
          "60M",
          "--acceleration",
          "required",
          "--assembly",
          "segments",
          "--report",
          "report.json",
          "--events",
          "events.jsonl",
          "--input-props-file",
          "props.json",
          "--verify-segments",
        ),
        dependencies,
      );

      expect(dependencies.loadConfigFromPath).toHaveBeenCalledExactlyOnceWith(
        "custom.config.ts",
      );
      expect(dependencies[command]).toHaveBeenCalledExactlyOnceWith(
        ...request,
        expect.objectContaining({
          concurrency: "auto",
          codec: "hevc",
          container: "mov",
          audioCodec: "pcm-s24",
          mediaBackend: "native",
          videoProfile: "prores_ks",
          pixelFormat: "nv12",
          bitrate: "60M",
          acceleration: "required",
          assembly: "segments",
          report: "report.json",
          events: "events.jsonl",
          inputPropsFile: "props.json",
          verifySegments: true,
        }),
      );
    },
  );

  it("keeps an explicit false render option", async () => {
    const dependencies = commandDependencies();

    await runCli(
      argv("render", "hero", "--output", "out.mp4", "--no-verify-segments"),
      dependencies,
    );

    expect(dependencies.renderComposition).toHaveBeenCalledWith(
      config,
      "hero",
      "out.mp4",
      expect.objectContaining({ verifySegments: false }),
    );
  });

  it.each([
    { args: ["render", "hero"], error: "--output is required" },
    {
      args: ["render-url", "https://example.com"],
      error: "--selector is required",
    },
    {
      args: ["render-url", "https://example.com", "--output", "out.mp4"],
      error: "--selector is required",
    },
    {
      args: ["render-url", "https://example.com", "--selector", "#hero"],
      error: "--output is required",
    },
  ])("validates $args before loading config", async ({ args, error }) => {
    const dependencies = commandDependencies();

    await expect(runCli(argv(...args), dependencies)).rejects.toThrow(error);

    expect(dependencies.loadConfigFromPath).not.toHaveBeenCalled();
    expect(dependencies.renderComposition).not.toHaveBeenCalled();
    expect(dependencies.renderUrl).not.toHaveBeenCalled();
  });

  it.each([
    {
      args: ["render", "--output", "out.mp4"],
      error: /missing required args/i,
    },
    {
      args: ["render", "hero", "--output", "out.mp4", "--unknown"],
      error: /unknown option/i,
    },
  ])("rejects invalid parser input $args", async ({ args, error }) => {
    const dependencies = commandDependencies();

    await expect(runCli(argv(...args), dependencies)).rejects.toThrow(error);

    expect(dependencies.loadConfigFromPath).not.toHaveBeenCalled();
    expect(dependencies.renderComposition).not.toHaveBeenCalled();
  });

  it("propagates config failures before dispatch", async () => {
    const dependencies = commandDependencies();
    const error = new Error("config could not load");
    dependencies.loadConfigFromPath.mockRejectedValue(error);

    await expect(
      runCli(argv("render", "hero", "--output", "out.mp4"), dependencies),
    ).rejects.toBe(error);

    expect(dependencies.renderComposition).not.toHaveBeenCalled();
  });

  it("awaits command failures so the executable can set its exit status", async () => {
    const dependencies = commandDependencies();
    const error = new Error("render failed");
    dependencies.renderComposition.mockRejectedValue(error);

    await expect(
      runCli(argv("render", "hero", "--output", "out.mp4"), dependencies),
    ).rejects.toBe(error);
  });

  it("dispatches capture probes with their config and options", async () => {
    const dependencies = commandDependencies();

    await runCli(
      argv(
        "probe-capture",
        "hero",
        "--config",
        "probe.config.ts",
        "--report",
        "probe.json",
        "--input-props-file",
        "props.json",
      ),
      dependencies,
    );

    expect(dependencies.loadConfigFromPath).toHaveBeenCalledExactlyOnceWith(
      "probe.config.ts",
    );
    expect(dependencies.probeCapture).toHaveBeenCalledExactlyOnceWith(
      config,
      "hero",
      expect.objectContaining({
        report: "probe.json",
        inputPropsFile: "props.json",
      }),
    );
    expect(dependencies.renderComposition).not.toHaveBeenCalled();
  });

  it.each([
    ["setup", "setupCommand"],
    ["doctor", "doctorCommand"],
    ["versions", "versionsCommand"],
  ] as const)(
    "dispatches %s with text or JSON output",
    async (command, handler) => {
      for (const json of [undefined, true]) {
        const dependencies = commandDependencies();

        await runCli(argv(command, ...(json ? ["--json"] : [])), dependencies);

        expect(dependencies[handler]).toHaveBeenCalledExactlyOnceWith({ json });
        expect(dependencies.loadConfigFromPath).not.toHaveBeenCalled();
        expect(dependencies.renderComposition).not.toHaveBeenCalled();
      }
    },
  );

  it("shows command help without dispatching or loading config", async () => {
    const dependencies = commandDependencies();
    const output = vi.spyOn(console, "info").mockImplementation(() => {});

    await runCli(argv("render", "--help"), dependencies);

    expect(output.mock.calls.flat().join("\n")).toContain("--concurrency");
    expect(dependencies.loadConfigFromPath).not.toHaveBeenCalled();
    expect(dependencies.renderComposition).not.toHaveBeenCalled();
  });
});

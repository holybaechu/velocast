import { expect, it, vi } from "vitest";
import { HttpStudioApi } from "./studio-api.js";

const session = { sessionId: "session-1", sourceVersion: "source-1" };

it("delivers an inspection command from the heartbeat response to the live browser", async () => {
  const command = {
    id: "inspect-1",
    action: "inspect",
    elementId: "title",
    expectedRevision: 1,
    expectedSourceVersion: "source-1",
  };
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(Response.json({ commands: [command] }));
  const api = new HttpStudioApi({ baseUrl: "http://127.0.0.1:90", fetch });
  const result = await api.heartbeat("tab", {
    state: {
      revision: 1,
      sourceVersion: "source-1",
      compositions: [],
      dirty: false,
      ready: false,
      exportReady: false,
      playing: false,
    },
  });
  expect(result.commands).toEqual([command]);
});

it("accepts interrupted-edit recovery state without a current source revision", async () => {
  const source = {
    enabled: true,
    compositionId: "demo",
    path: "src/demo.jsx",
    recoveryRequired: true,
    recoveryPath: ".velocast/source-history/demo",
    elements: [],
    canUndo: false,
    canRedo: false,
  };
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(Response.json(source));
  const api = new HttpStudioApi({ baseUrl: "http://127.0.0.1:90", fetch });
  expect(await api.getCode("demo")).toEqual(source);
});

it("loads the installed agent command and sends browser context and acknowledgements to its own endpoint", async () => {
  const connection = {
    command: "C:/Node/node.exe",
    args: ["C:/Velocast/bin.js", "mcp", "--url", "http://127.0.0.1:90"],
  };
  const command = {
    id: "seek-1",
    action: "seek",
    frame: 12,
    expectedRevision: 1,
    expectedSourceVersion: "source-1",
  };
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json(connection))
    .mockResolvedValueOnce(Response.json({ commands: [command] }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  const api = new HttpStudioApi({ baseUrl: "http://127.0.0.1:90", fetch });
  expect(await api.agentConnection()).toEqual(connection);
  const heartbeat = {
    state: {
      revision: 1,
      sourceVersion: "source-1",
      compositions: [],
      frame: 2,
      dirty: false,
      ready: true,
      exportReady: true,
      playing: false,
    },
  };
  expect(await api.heartbeat("tab-1", heartbeat)).toEqual({
    commands: [command],
  });
  await api.disconnect("tab-1");
  expect(String(fetch.mock.calls[1]![0])).toBe(
    "http://127.0.0.1:90/api/clients/tab-1",
  );
  expect(JSON.parse(String(fetch.mock.calls[1]![1]!.body))).toEqual(heartbeat);
  expect(fetch.mock.calls[2]![1]).toMatchObject({
    method: "DELETE",
    keepalive: true,
  });
});

it("preserves frozen build receipts and rejects invalid receipt maps", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      Response.json({
        snapshotUrl: "http://127.0.0.1:91/",
        session,
        codeRevisions: { demo: "file-1" },
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        snapshotUrl: "http://127.0.0.1:91/",
        session,
        codeRevisions: { demo: 42 },
      }),
    );
  const api = new HttpStudioApi({ baseUrl: "http://127.0.0.1:90/", fetch });
  expect((await api.getSession()).codeRevisions).toEqual({ demo: "file-1" });
  await expect(api.getSession()).rejects.toThrow(
    "invalid source build receipts",
  );
});

it("discovers source fields and shares source guards for code edits and history", async () => {
  const source = {
    enabled: true,
    compositionId: "demo",
    path: "src/Demo.tsx",
    revision: "file-1",
    elements: [
      {
        id: "title",
        name: "Title",
        kind: "layer",
        line: 12,
        fields: {
          text: { value: "Hello", editable: true },
          x: { editable: false, reason: "Computed in source" },
        },
      },
    ],
    canUndo: false,
    canRedo: false,
  };
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async () => Response.json(source));
  const api = new HttpStudioApi({ baseUrl: "http://127.0.0.1:90/", fetch });
  expect(await api.getCode("demo")).toEqual(source);
  const guard = {
    compositionId: "demo",
    expectedSourceVersion: "source-1",
    expectedRevision: "file-1",
  };
  await api.saveCode({
    ...guard,
    edits: [{ id: "title", field: "text", value: "Edited" }],
  });
  await api.changeCodeHistory({ ...guard, action: "undo" });
  await api.recoverCode({
    compositionId: "demo",
    expectedSourceVersion: "source-1",
  });
  expect(String(fetch.mock.calls[0]![0])).toBe(
    "http://127.0.0.1:90/api/code?compositionId=demo",
  );
  expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body))).toEqual({
    ...guard,
    edits: [{ id: "title", field: "text", value: "Edited" }],
  });
  expect(String(fetch.mock.calls[2]![0])).toBe(
    "http://127.0.0.1:90/api/code/history",
  );
  expect(String(fetch.mock.calls[3]![0])).toBe(
    "http://127.0.0.1:90/api/code/recover",
  );
  expect(JSON.parse(String(fetch.mock.calls[3]![1]?.body))).toEqual({
    compositionId: "demo",
    expectedSourceVersion: "source-1",
  });
});

it("waits for owned output jobs and returns the completed artifact with source guards", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ snapshotUrl: "http://127.0.0.1:91/", session }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ snapshotUrl: "http://127.0.0.1:92/", session }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "frame-job", status: "running" })),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "frame-job",
          status: "succeeded",
          result: { outputPath: "frame.png" },
        }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "range-job",
          status: "succeeded",
          result: { outputPath: "range.mp4" },
        }),
      ),
    );
  const api = new HttpStudioApi({ baseUrl: "http://127.0.0.1:90/ui/", fetch });

  await api.getSession();
  await api.refresh("source-1");
  expect(
    await api.output({
      compositionId: "scene",
      expectedSourceVersion: "source-1",
      frame: 12,
    }),
  ).toEqual({ outputPath: "frame.png" });
  expect(
    await api.output({
      compositionId: "scene",
      expectedSourceVersion: "source-1",
      range: { start: 12, end: 30 },
    }),
  ).toEqual({ outputPath: "range.mp4" });

  expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
    "http://127.0.0.1:90/api/session",
    "http://127.0.0.1:90/api/refresh",
    "http://127.0.0.1:90/api/jobs",
    "http://127.0.0.1:90/api/jobs/frame-job",
    "http://127.0.0.1:90/api/jobs",
  ]);
  expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body))).toEqual({
    expectedSourceVersion: "source-1",
  });
  expect(JSON.parse(String(fetch.mock.calls[2]![1]?.body))).toEqual({
    compositionId: "scene",
    expectedSourceVersion: "source-1",
    frame: 12,
  });
  expect(JSON.parse(String(fetch.mock.calls[4]![1]?.body))).toEqual({
    compositionId: "scene",
    expectedSourceVersion: "source-1",
    range: { start: 12, end: 30 },
  });
});

it("rejects ambiguous outputs before fetch and preserves server diagnostics", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response(JSON.stringify({ error: "source version is stale" }), {
      status: 409,
    }),
  );
  const api = new HttpStudioApi({ baseUrl: "http://127.0.0.1:90", fetch });

  await expect(
    api.output({
      compositionId: "scene",
      expectedSourceVersion: "source",
      frame: -1,
    }),
  ).rejects.toThrow("frame must be a nonnegative safe integer");
  expect(fetch).not.toHaveBeenCalled();
  await expect(api.refresh("source")).rejects.toThrow(
    "studio.api_http_409: source version is stale",
  );
});

it("rejects session responses without immutable source identity", async () => {
  const api = new HttpStudioApi({
    baseUrl: "http://127.0.0.1:90",
    fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          snapshotUrl: "http://127.0.0.1:91/",
          session: { sessionId: "session-1" },
        }),
      ),
    ),
  });
  await expect(api.getSession()).rejects.toThrow("session identity");
});

it("preserves structured server codes so a stale studio can resynchronize", async () => {
  const api = new HttpStudioApi({
    fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "snapshot.version_mismatch",
          message: "Another studio committed a source",
        }),
        { status: 409 },
      ),
    ),
  });
  await expect(api.refresh("old-source")).rejects.toThrow(
    "snapshot.version_mismatch",
  );
});

it("preserves cancellation while reading the response body", async () => {
  const controller = new AbortController();
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(value) {
        body = value;
        body.enqueue(new TextEncoder().encode('{"snapshotUrl":'));
      },
    }),
  );
  const api = new HttpStudioApi({
    fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(response),
  });
  const result = api.getSession(controller.signal);
  await vi.waitFor(() => expect(response.bodyUsed).toBe(true));

  controller.abort();
  body.error(controller.signal.reason);

  await expect(result).rejects.toBe(controller.signal.reason);
});

it("still reports malformed response JSON", async () => {
  const api = new HttpStudioApi({
    fetch: vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("{")),
  });
  await expect(api.getSession()).rejects.toThrow(
    "studio.api_invalid: response is not valid JSON",
  );
});

it("cancels an owned job and joins cleanup when its caller aborts during submission", async () => {
  const controller = new AbortController();
  let submitted!: (value: Response) => void;
  let cleaned!: (value: Response) => void;
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          submitted = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          cleaned = resolve;
        }),
    );
  const api = new HttpStudioApi({ baseUrl: "http://127.0.0.1:90", fetch });
  let settled = false;
  const output = api.output(
    { compositionId: "scene", expectedSourceVersion: "source", frame: 5 },
    controller.signal,
  );
  void output.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  controller.abort();
  submitted(new Response(JSON.stringify({ id: "job-1", status: "running" })));
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(String(fetch.mock.calls[1]![0])).toBe(
    "http://127.0.0.1:90/api/jobs/job-1/cancel",
  );
  expect(fetch.mock.calls[1]![1]?.signal?.aborted).toBe(false);
  expect(settled).toBe(false);
  cleaned(new Response(JSON.stringify({ id: "job-1", status: "cancelled" })));
  await expect(output).rejects.toBe(controller.signal.reason);
});

it("preserves exact output failure diagnostics and emits job progress", async () => {
  const api = new HttpStudioApi({
    fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "job-2",
          status: "failed",
          error: {
            code: "renderer.invalid_frame",
            message: "frame 60 is outside [0, 60)",
          },
        }),
      ),
    ),
  });
  const progress = vi.fn();
  await expect(
    api.output(
      { compositionId: "scene", expectedSourceVersion: "source", frame: 60 },
      undefined,
      progress,
    ),
  ).rejects.toThrow("renderer.invalid_frame: frame 60 is outside [0, 60)");
  expect(progress).toHaveBeenCalledWith(
    expect.objectContaining({ id: "job-2", status: "failed" }),
  );
});

it.each(["succeeded", "failed"] as const)(
  "honors authoritative %s when publication finishes before cancellation",
  async (status) => {
    const controller = new AbortController();
    const result = {
      outputPath: "published.mp4",
      url: "http://127.0.0.1:90/artifacts/published.mp4",
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "job-race", status: "running" })),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "job-race",
            status,
            result,
            error:
              status === "failed"
                ? {
                    code: "renderer.publication_failed",
                    message: "destination is unavailable",
                  }
                : undefined,
          }),
        ),
      );
    const api = new HttpStudioApi({ baseUrl: "http://127.0.0.1:90", fetch });
    const progress: string[] = [];
    const output = api.output(
      {
        compositionId: "scene",
        expectedSourceVersion: "source",
        range: { start: 0, end: 10 },
      },
      controller.signal,
      (job) => {
        progress.push(job.status);
        if (job.status === "running") controller.abort();
      },
    );
    if (status === "succeeded") await expect(output).resolves.toEqual(result);
    else
      await expect(output).rejects.toThrow(
        "renderer.publication_failed: destination is unavailable",
      );
    expect(progress).toEqual(["running", status]);
    expect(String(fetch.mock.calls[1]![0])).toBe(
      "http://127.0.0.1:90/api/jobs/job-race/cancel",
    );
  },
);

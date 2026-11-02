import { expect, it, vi } from "vitest";
import { HttpStudioApi } from "./studio-api.js";

const session = { sessionId: "session-1", sourceVersion: "source-1" };

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
});

it("shares source guards for history and binary media imports", async () => {
  const saved = {
    enabled: true,
    path: "project.json",
    revision: "revision-2",
    inputProps: { name: "Demo" },
  };
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ canUndo: true, canRedo: false }))
    .mockResolvedValueOnce(Response.json(saved))
    .mockResolvedValueOnce(Response.json(saved));
  const api = new HttpStudioApi({ baseUrl: "http://127.0.0.1:90/", fetch });
  expect(await api.getHistory()).toEqual({ canUndo: true, canRedo: false });
  const guard = {
    expectedSourceVersion: "source-1",
    expectedRevision: "revision-1",
  };
  expect(await api.changeHistory({ ...guard, action: "undo" })).toEqual(saved);
  const data = new Blob(["image"], { type: "image/png" });
  expect(
    await api.importAsset({ ...guard, name: "Product image.png", data }),
  ).toEqual(saved);
  expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body))).toEqual({
    ...guard,
    action: "undo",
  });
  const upload = fetch.mock.calls[2]!;
  expect(new URL(String(upload[0])).searchParams.get("name")).toBe(
    "Product image.png",
  );
  expect(new URL(String(upload[0])).searchParams.get("expectedRevision")).toBe(
    "revision-1",
  );
  expect(upload[1]?.body).toBe(data);
  expect(upload[1]?.headers).toEqual({
    "content-type": "application/octet-stream",
  });
});

it("rejects unusable history responses and preserves import failures", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ canUndo: "yes", canRedo: false }))
    .mockResolvedValueOnce(
      Response.json(
        { code: "studio.inputs_conflict", message: "Reload the saved project" },
        { status: 409 },
      ),
    );
  const api = new HttpStudioApi({ baseUrl: "http://127.0.0.1:90/", fetch });
  await expect(api.getHistory()).rejects.toThrow("invalid history");
  await expect(
    api.importAsset({
      expectedSourceVersion: "source",
      expectedRevision: "revision",
      name: "file.png",
      data: new Blob(["file"]),
    }),
  ).rejects.toThrow("studio.inputs_conflict: Reload the saved project");
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

it("saves input objects with both source and persisted-file revision guards", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          snapshotUrl: "http://127.0.0.1:91/",
          session,
          inputProps: { title: "Saved" },
          inputPropsFile: {
            path: "C:/video/inputs.json",
            revision: "revision-1",
          },
        }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          enabled: true,
          path: "C:/video/inputs.json",
          revision: "revision-2",
          inputProps: { title: "Updated" },
        }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: "studio.inputs_conflict",
          message: "Saved inputs changed; reload before saving",
        }),
        { status: 409 },
      ),
    );
  const api = new HttpStudioApi({ fetch });
  expect((await api.getSession()).inputPropsFile).toEqual({
    path: "C:/video/inputs.json",
    revision: "revision-1",
  });
  const request = {
    expectedSourceVersion: "source-1",
    expectedRevision: "revision-1",
    inputProps: { title: "Updated" },
  };
  expect((await api.saveInputs(request)).revision).toBe("revision-2");
  expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body))).toEqual(request);
  await expect(api.saveInputs(request)).rejects.toThrow(
    "studio.inputs_conflict",
  );
});

import { expect, it, vi } from "vitest";
import { HttpPreviewApi } from "./preview-api.js";

const session = { sessionId: "session-1", sourceVersion: "source-1" };

it("uses the fixed session, refresh and output endpoints with source guards", async () => {
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
      new Response(JSON.stringify({ outputPath: "frame.png" })),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ outputPath: "range.mp4" })),
    );
  const api = new HttpPreviewApi({ baseUrl: "http://127.0.0.1:90/ui/", fetch });

  await api.getSession();
  await api.refresh("source-1");
  await api.output({
    compositionId: "scene",
    expectedSourceVersion: "source-1",
    frame: 12,
  });
  await api.output({
    compositionId: "scene",
    expectedSourceVersion: "source-1",
    range: { start: 12, end: 30 },
  });

  expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
    "http://127.0.0.1:90/api/session",
    "http://127.0.0.1:90/api/refresh",
    "http://127.0.0.1:90/api/output",
    "http://127.0.0.1:90/api/output",
  ]);
  expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body))).toEqual({
    expectedSourceVersion: "source-1",
  });
  expect(JSON.parse(String(fetch.mock.calls[2]![1]?.body))).toEqual({
    compositionId: "scene",
    expectedSourceVersion: "source-1",
    frame: 12,
  });
  expect(JSON.parse(String(fetch.mock.calls[3]![1]?.body))).toEqual({
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
  const api = new HttpPreviewApi({ baseUrl: "http://127.0.0.1:90", fetch });

  await expect(
    api.output({
      compositionId: "scene",
      expectedSourceVersion: "source",
      frame: -1,
    }),
  ).rejects.toThrow("frame must be a nonnegative safe integer");
  expect(fetch).not.toHaveBeenCalled();
  await expect(api.refresh("source")).rejects.toThrow(
    "preview.api_http_409: source version is stale",
  );
});

it("rejects session responses without immutable source identity", async () => {
  const api = new HttpPreviewApi({
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

it("preserves structured server codes so a stale preview can resynchronize", async () => {
  const api = new HttpPreviewApi({
    fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "snapshot.version_mismatch",
          message: "Another preview committed a source",
        }),
        { status: 409 },
      ),
    ),
  });
  await expect(api.refresh("old-source")).rejects.toThrow(
    "snapshot.version_mismatch",
  );
});

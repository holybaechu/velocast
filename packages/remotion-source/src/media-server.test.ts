// @vitest-environment node
import { expect, it, vi } from "vitest";
import { createReadStream, type ReadStream } from "node:fs";
import { get, type ClientRequest, type IncomingMessage } from "node:http";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMediaSession } from "velocast/source-media";
import { serveRemotionBundle } from "./media-server.js";
vi.mock("velocast/source-media", () => ({ createMediaSession: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, createReadStream: vi.fn(original.createReadStream) };
});
it("serves contained byte ranges and refuses escaped symlinks and unrelated browser origins", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "velocast-remotion-server-test-"),
  );
  let server: Awaited<ReturnType<typeof serveRemotionBundle>> | undefined;
  try {
    const root = join(directory, "bundle"),
      outside = join(directory, "outside");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(root, "index.html"), "bundle");
    await writeFile(join(outside, "private.txt"), "outside");
    await symlink(outside, join(root, "escape"), "junction");
    server = await serveRemotionBundle(
      root,
      directory,
      new AbortController().signal,
    );
    const range = await fetch(server.url + "/index.html", {
      headers: { Range: "bytes=1-3" },
    });
    expect(range.status).toBe(206);
    expect(await range.text()).toBe("und");
    expect((await fetch(server.url + "/escape/private.txt")).status).toBe(422);
    await expect(
      server.freeze(server.url + "/escape/private.txt"),
    ).rejects.toThrow("asset_path_escape");
    const denied = await fetch(
      server.url + "/proxy?src=https://example.com/movie.mp4&time=0",
      { headers: { Origin: "https://unrelated.example" } },
    );
    expect(denied.status).toBe(403);
    expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const allowed = await fetch(server.url + "/index.html", {
      headers: { Origin: server.url },
    });
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(server.url);
  } finally {
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
it("streams bounded media downloads and accounts for source count and aggregate bytes", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "velocast-remotion-budget-test-"),
  );
  let server: Awaited<ReturnType<typeof serveRemotionBundle>> | undefined;
  try {
    const root = join(directory, "bundle");
    await mkdir(root);
    await writeFile(join(root, "audio.wav"), "four");
    server = await serveRemotionBundle(
      root,
      directory,
      new AbortController().signal,
      { maxSources: 3, maxSourceBytes: 8, maxTotalBytes: 8 },
    );
    const downloaded = await server.freeze(
      "data:application/octet-stream;base64,AQIDBA==",
    );
    expect(await readFile(downloaded)).toEqual(Buffer.from([1, 2, 3, 4]));
    await server.freeze(server.url + "/audio.wav");
    await expect(
      server.freeze("data:application/octet-stream;base64,BQY="),
    ).rejects.toThrow("asset_limit");
    expect(await readdir(join(directory, "media"))).toHaveLength(1);
    await expect(
      server.freeze("data:application/octet-stream;base64,Bw=="),
    ).rejects.toThrow("source_count_limit");
  } finally {
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
it.each(["startup", "shutdown"])(
  "closes the HTTP listener when the media session fails during %s",
  async (phase) => {
    const directory = await mkdtemp(
      join(tmpdir(), "velocast-remotion-close-test-"),
    );
    let server: Awaited<ReturnType<typeof serveRemotionBundle>> | undefined;
    const failure = new Error(`media ${phase} failed`);
    const close = vi.fn().mockRejectedValue(failure);
    if (phase === "startup")
      vi.mocked(createMediaSession).mockRejectedValueOnce(failure);
    else
      vi.mocked(createMediaSession).mockResolvedValueOnce({
        run: vi.fn().mockRejectedValue(new Error("frame failed")),
        close,
      });
    try {
      const root = join(directory, "bundle");
      await mkdir(root);
      await writeFile(join(root, "index.html"), "bundle");
      server = await serveRemotionBundle(
        root,
        directory,
        new AbortController().signal,
      );
      const response = await fetch(
        `${server.url}/proxy?src=/index.html&time=0`,
      );
      expect(response.status).toBe(422);
      await response.text();
      await expect(server.close()).rejects.toBe(failure);
      await expect(fetch(server.url)).rejects.toThrow();
      await expect(server.close()).rejects.toBe(failure);
      if (phase === "shutdown") expect(close).toHaveBeenCalledOnce();
    } finally {
      await server?.close().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.each(["owner", "parent", "failed-cleanup"])(
  "joins cancelled session startup during %s shutdown",
  async (phase) => {
    const directory = await mkdtemp(
      join(tmpdir(), "velocast-remotion-startup-close-test-"),
    );
    let server: Awaited<ReturnType<typeof serveRemotionBundle>> | undefined;
    let request: Promise<unknown> | undefined;
    let releaseStartup: (() => void) | undefined;
    let startupError: unknown;
    const owner = new AbortController();
    let started!: (signal: AbortSignal) => void;
    const starting = new Promise<AbortSignal>((resolve) => (started = resolve));
    vi.mocked(createMediaSession).mockImplementationOnce(async (options) => {
      const signal = options!.signal!;
      started(signal);
      return new Promise((_, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            startupError =
              phase === "failed-cleanup"
                ? new AggregateError(
                    [signal.reason, new Error("cleanup failed")],
                    "media startup cleanup failed",
                    { cause: signal.reason },
                  )
                : signal.reason;
            releaseStartup = () => reject(startupError);
          },
          { once: true },
        );
      });
    });
    try {
      const root = join(directory, "bundle");
      await mkdir(root);
      await writeFile(join(root, "index.html"), "bundle");
      server = await serveRemotionBundle(root, directory, owner.signal);
      request = fetch(`${server.url}/proxy?src=/index.html&time=0`)
        .then((response) => response.text())
        .catch(() => undefined);
      const signal = await starting;
      let settled = false;
      if (phase === "parent") owner.abort(new Error("source closed"));
      const closing = server.close();
      void closing.then(
        () => (settled = true),
        () => (settled = true),
      );
      const result =
        phase === "failed-cleanup"
          ? expect(closing).rejects.toBe(startupError)
          : expect(closing).resolves.toBeUndefined();
      expect(signal.aborted).toBe(true);
      await expect(fetch(server.url)).rejects.toThrow();
      expect(settled).toBe(false);
      releaseStartup!();
      await result;
      await request;
      expect(server.close()).toBe(closing);
    } finally {
      releaseStartup?.();
      await server?.close().catch(() => {});
      await request;
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("cancels and joins owned downloads before closing", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "velocast-remotion-download-close-test-"),
  );
  let server: Awaited<ReturnType<typeof serveRemotionBundle>> | undefined;
  let cancelled = false;
  const fetchMedia = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
        },
        cancel() {
          cancelled = true;
        },
      }),
    ),
  );
  try {
    const root = join(directory, "bundle");
    await mkdir(root);
    server = await serveRemotionBundle(
      root,
      directory,
      new AbortController().signal,
    );
    const download = expect(
      server.freeze("https://media.example/video.mp4"),
    ).rejects.toThrow();
    await server.close();
    await download;
    expect(cancelled).toBe(true);
    expect(await readdir(join(directory, "media"))).toEqual([]);
    await expect(server.freeze("/new.wav")).rejects.toThrow();
  } finally {
    fetchMedia.mockRestore();
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
it("closes a static file stream before shutdown completes with a paused client", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "velocast-remotion-static-close-test-"),
  );
  let server: Awaited<ReturnType<typeof serveRemotionBundle>> | undefined;
  let request: ClientRequest | undefined;
  let response: IncomingMessage | undefined;
  let source: ReadStream | undefined;
  try {
    const root = join(directory, "bundle");
    await mkdir(root);
    const file = await open(join(root, "large.mp4"), "w");
    try {
      await file.truncate(16 * 1024 * 1024);
    } finally {
      await file.close();
    }
    server = await serveRemotionBundle(
      root,
      directory,
      new AbortController().signal,
    );
    response = await new Promise<IncomingMessage>((resolve, reject) => {
      request = get(`${server!.url}/large.mp4`, resolve);
      request.on("error", reject);
    });
    response.on("error", () => {});
    response.pause();
    source = vi.mocked(createReadStream).mock.results.at(-1)!.value;
    expect(source!.closed).toBe(false);

    await server.close();

    expect(source!.closed).toBe(true);
    expect(source!.readableEnded).toBe(false);
  } finally {
    response?.destroy();
    request?.destroy();
    source?.destroy();
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

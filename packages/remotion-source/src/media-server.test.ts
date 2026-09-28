// @vitest-environment node
import { expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveRemotionBundle } from "./media-server.js";
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

import {
  access,
  mkdtemp,
  mkdir,
  open,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createInputSnapshot,
  MAX_SNAPSHOT_BYTES,
  MAX_SNAPSHOT_FILES,
} from "./input-snapshot.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "velocast-snapshot-test-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "dist");
  await mkdir(root);
  await writeFile(
    join(root, "index.html"),
    "<script src='/asset.js'></script>",
  );
  await writeFile(join(root, "asset.js"), "window.version = 1;");
  const props = join(directory, "props.json");
  await writeFile(props, '{"title":"original"}');
  return { directory, root, props };
}

it("instruments only preview responses while preserving authored identity and isolating parent access", async () => {
  const { root, props } = await fixture();
  const plain = await createInputSnapshot({
    root,
    entryPath: "index.html",
    inputPropsPath: props,
  });
  cleanups.push(plain.close);
  const script = Buffer.from("window.previewReady = true;");
  const parentOrigin = "http://127.0.0.1:43123";
  const preview = await createInputSnapshot({
    root,
    entryPath: "index.html",
    inputPropsPath: props,
    preview: {
      parentOrigin,
      entryScript: "bridge.js",
      assets: { "bridge.js": script },
    },
  });
  cleanups.push(preview.close);
  script.fill(0);
  expect(preview.session.sourceVersion).toBe(plain.session.sourceVersion);
  const normal = await fetch(plain.url);
  expect(normal.headers.get("content-security-policy")).toContain(
    "frame-ancestors 'none'",
  );
  expect(await normal.text()).not.toContain("__velocast-preview");
  const response = await fetch(preview.url, {
    headers: { Origin: parentOrigin },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-security-policy")).toContain(
    `frame-ancestors ${parentOrigin}`,
  );
  expect(response.headers.get("access-control-allow-origin")).toBe(
    parentOrigin,
  );
  const html = await response.text();
  expect(html).toContain('src="/__velocast-preview/bridge.js"');
  expect(response.headers.get("x-velocast-content-sha256")).toBe(
    createHash("sha256").update(html).digest("hex"),
  );
  expect(
    await (
      await fetch(new URL("/__velocast-preview/bridge.js", preview.url))
    ).text(),
  ).toBe("window.previewReady = true;");
  expect(
    (
      await fetch(preview.url, {
        headers: { Origin: "http://127.0.0.1:43124" },
      })
    ).status,
  ).toBe(403);
  expect(
    (await fetch(plain.url, { headers: { Origin: parentOrigin } })).status,
  ).toBe(403);
  expect(await readFile(join(root, "index.html"), "utf8")).toBe(
    "<script src='/asset.js'></script>",
  );
});

it("rejects unsafe preview origins, paths and authored namespace collisions", async () => {
  const { root } = await fixture();
  const preview = {
    parentOrigin: "http://127.0.0.1:43123",
    entryScript: "bridge.js",
    assets: { "bridge.js": Buffer.from("export {};") },
  };
  for (const parentOrigin of [
    "https://example.com",
    "http://user@127.0.0.1:43123",
    "http://127.0.0.1:43123/path",
    "invalid",
  ])
    await expect(
      createInputSnapshot({
        root,
        entryPath: "index.html",
        preview: { ...preview, parentOrigin },
      }),
    ).rejects.toThrow("snapshot.invalid_preview");
  await expect(
    createInputSnapshot({
      root,
      entryPath: "index.html",
      preview: {
        ...preview,
        entryScript: "../bridge.js",
        assets: { "../bridge.js": Buffer.from("export {};") },
      },
    }),
  ).rejects.toThrow("snapshot.invalid_preview");
  await mkdir(join(root, "__velocast-preview"));
  await expect(
    createInputSnapshot({ root, entryPath: "index.html", preview }),
  ).rejects.toThrow("snapshot.invalid_preview");
});

it("dispatches only the reserved media endpoint after origin admission with the frozen identity", async () => {
  const { root } = await fixture();
  const calls: unknown[] = [];
  const snapshot = await createInputSnapshot({
    root,
    entryPath: "index.html",
    async handleMediaRequest(_request, response, identity) {
      calls.push(identity);
      response.end("frame bytes");
    },
  });
  cleanups.push(snapshot.close);
  const endpoint = new URL("/__velocast-media/frame?seconds=0", snapshot.url);
  expect(await (await fetch(endpoint)).text()).toBe("frame bytes");
  expect(calls).toEqual([{ url: snapshot.url, session: snapshot.session }]);
  expect(
    (await fetch(endpoint, { headers: { Origin: "http://127.0.0.1:9" } }))
      .status,
  ).toBe(403);
  expect(
    (await fetch(new URL("/__velocast-media/other", snapshot.url))).status,
  ).toBe(404);
  expect(calls).toHaveLength(1);
});

it("freezes entry, assets and props for concurrent workers after source edits", async () => {
  const { root, props } = await fixture();
  const snapshot = await createInputSnapshot({
    root,
    entryPath: "index.html",
    inputPropsPath: props,
  });
  cleanups.push(snapshot.close);
  await writeFile(join(root, "index.html"), "changed entry");
  await writeFile(join(root, "asset.js"), "window.version = 2;");
  await writeFile(props, '{"title":"changed"}');
  const workers = await Promise.all(
    [0, 1].map(async () => ({
      html: await (await fetch(snapshot.url)).text(),
      asset: await (await fetch(new URL("/asset.js", snapshot.url))).text(),
      props: await readFile(snapshot.inputPropsPath!, "utf8"),
    })),
  );
  expect(workers).toEqual(
    Array(2).fill({
      html: "<script src='/asset.js'></script>",
      asset: "window.version = 1;",
      props: '{"title":"original"}',
    }),
  );
  expect(snapshot.session.sourceVersion).toMatch(/^[a-f0-9]{64}$/);
  expect(snapshot.session.sessionId).toMatch(/^[a-f0-9-]{36}$/);
  await rm(join(root, "asset.js"));
  await writeFile(join(root, "added.js"), "new file");
  expect(await (await fetch(new URL("/asset.js", snapshot.url))).text()).toBe(
    "window.version = 1;",
  );
  expect((await fetch(new URL("/added.js", snapshot.url))).status).toBe(404);
});

it("binds successful media responses to the source version and full frozen content digest", async () => {
  const { root } = await fixture();
  const original = Buffer.from([0, 1, 2, 3, 4, 255]);
  await writeFile(join(root, "song.m4a"), original);
  const snapshot = await createInputSnapshot({ root, entryPath: "index.html" });
  cleanups.push(snapshot.close);
  await writeFile(join(root, "song.m4a"), "changed after capture");
  const url = new URL("/song.m4a", snapshot.url);
  const digest = createHash("sha256").update(original).digest("hex");
  for (const init of [
    {},
    { method: "HEAD" },
    { headers: { Range: "bytes=1-3" } },
  ]) {
    const response = await fetch(url, init);
    expect(response.headers.get("x-velocast-source-version")).toBe(
      snapshot.session.sourceVersion,
    );
    expect(response.headers.get("x-velocast-content-sha256")).toBe(digest);
    expect(response.headers.get("content-type")).toBe("audio/mp4");
    if (init.method !== "HEAD") {
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(bytes).toEqual(
        "headers" in init ? original.subarray(1, 4) : original,
      );
    }
  }
  const missing = await fetch(new URL("/missing.m4a", snapshot.url));
  expect(missing.status).toBe(404);
  expect(missing.headers.get("x-velocast-content-sha256")).toBeNull();
});

it("hashes exact sorted content, entry selection and props but not source location or session", async () => {
  const first = await fixture();
  const second = await fixture();
  const snapshot = async (
    root: string,
    inputPropsPath?: string,
    entryPath = "index.html",
  ) => {
    const value = await createInputSnapshot({
      root,
      entryPath,
      inputPropsPath,
    });
    cleanups.push(value.close);
    return value;
  };
  const one = await snapshot(first.root, first.props);
  const two = await snapshot(second.root, second.props);
  expect(two.session.sourceVersion).toBe(one.session.sourceVersion);
  expect(two.session.sessionId).not.toBe(one.session.sessionId);
  const noProps = await snapshot(first.root);
  expect(noProps.session.sourceVersion).not.toBe(one.session.sourceVersion);
  expect(noProps.inputPropsPath).toBeUndefined();
  await writeFile(second.props, '{"title":"modified"}');
  expect(
    (await snapshot(second.root, second.props)).session.sourceVersion,
  ).not.toBe(one.session.sourceVersion);
  await writeFile(second.props, '{"title":"original"}');
  await writeFile(join(second.root, "asset.js"), "window.version = 2;");
  expect(
    (await snapshot(second.root, second.props)).session.sourceVersion,
  ).not.toBe(one.session.sourceVersion);
  expect(
    (await snapshot(first.root, first.props, "asset.js")).session.sourceVersion,
  ).not.toBe(one.session.sourceVersion);
});

it("keeps nested paths and useful MIME and supports bounded, open-ended and suffix media ranges", async () => {
  const { root } = await fixture();
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "clip.webm"), "0123456789");
  await writeFile(join(root, "nested", "entry.html"), "nested");
  const value = await createInputSnapshot({
    root,
    entryPath: join(root, "nested", "entry.html"),
  });
  cleanups.push(value.close);
  expect(await (await fetch(value.url)).text()).toBe("nested");
  const url = new URL("clip.webm", value.url);
  for (const [range, expected, contentRange] of [
    ["bytes=2-5", "2345", "bytes 2-5/10"],
    ["bytes=8-", "89", "bytes 8-9/10"],
    ["bytes=-3", "789", "bytes 7-9/10"],
  ]) {
    const response = await fetch(url, { headers: { Range: range! } });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-type")).toBe("video/webm");
    expect(response.headers.get("content-range")).toBe(contentRange);
    expect(await response.text()).toBe(expected);
  }
  for (const range of [
    "bytes=20-",
    "bytes=4-2",
    "bytes=0-1,3-4",
    "bytes=-0",
    "bytes=9007199254740993-",
  ]) {
    const response = await fetch(url, { headers: { Range: range } });
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */10");
  }
  const head = await fetch(url, { method: "HEAD" });
  expect(head.headers.get("content-length")).toBe("10");
  expect(await head.text()).toBe("");
});

it("constrains dependencies to frozen loopback resources and closes owned props/server idempotently", async () => {
  const { root, props } = await fixture();
  const value = await createInputSnapshot({
    root,
    entryPath: "index.html",
    inputPropsPath: props,
  });
  cleanups.push(value.close);
  const url = new URL(value.url);
  expect(url.hostname).toBe("127.0.0.1");
  expect(Number(url.port)).toBeGreaterThanOrEqual(49152);
  const response = await fetch(value.url);
  expect(response.headers.get("content-security-policy")).toContain(
    "connect-src 'self' data: blob:",
  );
  expect(response.headers.get("content-security-policy")).toContain(
    "script-src 'self' 'unsafe-inline' data: blob:",
  );
  expect(response.headers.get("content-security-policy")).toContain(
    "object-src 'none'",
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(
    (await fetch(value.url, { headers: { Origin: "https://example.invalid" } }))
      .status,
  ).toBe(403);
  expect((await fetch(value.url, { method: "POST" })).status).toBe(405);
  expect((await fetch(new URL("/%2e%2e%2fprops.json", value.url))).status).toBe(
    400,
  );
  await Promise.all([value.close(), value.close()]);
  await expect(fetch(value.url)).rejects.toThrow();
  await expect(access(value.inputPropsPath!)).rejects.toThrow();
  expect(await readFile(props, "utf8")).toBe('{"title":"original"}');
});

it("rejects root escapes, missing/directory entries, and non-file props", async () => {
  const { root, props } = await fixture();
  await mkdir(join(root, "folder"));
  for (const entryPath of [
    props,
    "../props.json",
    "missing.html",
    "folder",
    root,
  ])
    await expect(createInputSnapshot({ root, entryPath })).rejects.toThrow(
      "snapshot.invalid_entry",
    );
  await expect(
    createInputSnapshot({ root: props, entryPath: "index.html" }),
  ).rejects.toThrow("snapshot.invalid_root");
  await expect(
    createInputSnapshot({
      root,
      entryPath: "index.html",
      inputPropsPath: root,
    }),
  ).rejects.toThrow("snapshot.invalid_props");
});

it("rejects symlink/junction roots and descendants instead of reading outside the selected tree", async () => {
  const { root, directory } = await fixture();
  const external = join(directory, "external");
  await mkdir(external);
  await writeFile(join(external, "secret.txt"), "not a static input");
  const link = join(root, "linked");
  await symlink(
    external,
    link,
    process.platform === "win32" ? "junction" : "dir",
  );
  await expect(
    createInputSnapshot({ root, entryPath: "index.html" }),
  ).rejects.toThrow("snapshot.symlink");
  await expect(
    createInputSnapshot({ root: link, entryPath: "secret.txt" }),
  ).rejects.toThrow("snapshot.symlink");
});

it("rejects oversized individual and aggregate inputs before allocating their bytes", async () => {
  const { root, props } = await fixture();
  const handle = await open(join(root, "large.bin"), "w");
  try {
    await handle.truncate(MAX_SNAPSHOT_BYTES + 1);
  } finally {
    await handle.close();
  }
  await expect(
    createInputSnapshot({ root, entryPath: "index.html" }),
  ).rejects.toThrow("snapshot.limit");
  await rm(join(root, "large.bin"));
  const propsHandle = await open(props, "w");
  try {
    await propsHandle.truncate(MAX_SNAPSHOT_BYTES);
  } finally {
    await propsHandle.close();
  }
  await expect(
    createInputSnapshot({
      root,
      entryPath: "index.html",
      inputPropsPath: props,
    }),
  ).rejects.toThrow("snapshot.limit");
});

it("rejects too many files without silently omitting assets", async () => {
  const { root } = await fixture();
  for (let offset = 0; offset < MAX_SNAPSHOT_FILES; offset += 64)
    await Promise.all(
      Array.from(
        { length: Math.min(64, MAX_SNAPSHOT_FILES - offset) },
        (_, index) => writeFile(join(root, `file-${index + offset}.txt`), ""),
      ),
    );
  await expect(
    createInputSnapshot({ root, entryPath: "index.html" }),
  ).rejects.toThrow("snapshot.limit");
}, 30_000);

it("fails rather than publishing an asset observed changing during capture", async () => {
  const { root } = await fixture();
  const handle = await open(join(root, "changing.bin"), "w+");
  await handle.truncate(64 * 1024 * 1024);
  let stop = false,
    writes = 0;
  const writer = (async () => {
    while (!stop) {
      await handle.write(Buffer.from([writes++ % 256]), 0, 1, 0);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  })();
  try {
    await expect(
      createInputSnapshot({ root, entryPath: "index.html" }),
    ).rejects.toThrow("snapshot.changed");
    expect(writes).toBeGreaterThan(1);
  } finally {
    stop = true;
    await writer;
    await handle.close();
  }
});

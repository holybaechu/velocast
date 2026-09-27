import { createHash, randomInt, randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import {
  lstat,
  mkdtemp,
  open,
  opendir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import {
  extname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

export const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
export const MAX_SNAPSHOT_FILES = 4096;
const MAX_SNAPSHOT_ENTRIES = 8192;

export interface InputSnapshotOptions {
  /** Explicit built/static directory, never an arbitrary live HTTP server. */
  root: string;
  /** Absolute path or path relative to root. Must be a regular file in root. */
  entryPath: string;
  /** Explicit props file. Outside-root props are not exposed over HTTP. */
  inputPropsPath?: string;
  /** Internal preview instrumentation. Authored bytes/version remain independent of the host UI. */
  preview?: PreviewSnapshotOptions;
  /** Internal bounded media endpoint; ordinary static files are never delegated. */
  handleMediaRequest?(
    request: IncomingMessage,
    response: ServerResponse,
    snapshot: {
      url: string;
      session: { sessionId: string; sourceVersion: string };
    },
  ): Promise<void>;
}

export interface PreviewSnapshotOptions {
  readonly parentOrigin: string;
  /** Platform modules under the reserved /__velocast-preview/ namespace. */
  readonly assets: Readonly<Record<string, Uint8Array>>;
  readonly entryScript: string;
}

const PREVIEW_PREFIX = "__velocast-preview/";

function previewOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw failure(
      "invalid_preview",
      "Preview parent must be an explicit loopback HTTP origin",
    );
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw failure(
      "invalid_preview",
      "Preview parent must be an explicit loopback HTTP origin",
    );
  return url.origin;
}

export interface InputSnapshot {
  url: string;
  session: { sessionId: string; sourceVersion: string };
  inputPropsPath?: string;
  /** Caller keeps this alive for all workers and calls close in finally. */
  close(): Promise<void>;
}

interface Entry {
  path: string;
  name: string;
  fingerprint: string;
  file: boolean;
  size: number;
}

const CSP = [
  "default-src 'self' data: blob:",
  "script-src 'self' 'unsafe-inline' data: blob:",
  "style-src 'self' 'unsafe-inline' data: blob:",
  "connect-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
};

function fingerprint(stat: BigIntStats): string {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(":");
}

function failure(code: string, detail: string): Error {
  return new Error(`snapshot.${code}: ${detail}`);
}

async function rejectSymlinkAncestors(path: string): Promise<void> {
  const absolute = resolve(path);
  const prefix = parse(absolute).root;
  let current = prefix;
  for (const part of absolute.slice(prefix.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink())
      throw failure(
        "symlink",
        `Symbolic links are not snapshot inputs: ${current}`,
      );
  }
}

async function inspect(path: string, name: string): Promise<Entry> {
  const stat = await lstat(path, { bigint: true });
  if (stat.isSymbolicLink()) throw failure("symlink", path);
  if (!stat.isFile() && !stat.isDirectory())
    throw failure("non_regular_file", path);
  if (stat.isFile() && stat.size > BigInt(MAX_SNAPSHOT_BYTES))
    throw failure("limit", `${path} exceeds ${MAX_SNAPSHOT_BYTES} bytes`);
  return {
    path,
    name,
    fingerprint: fingerprint(stat),
    file: stat.isFile(),
    size: Number(stat.size),
  };
}

async function inventory(root: string): Promise<Entry[]> {
  const entries: Entry[] = [];
  const pending = [{ path: root, name: "" }];
  let files = 0,
    bytes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    const entry = await inspect(item.path, item.name);
    entries.push(entry);
    if (entries.length > MAX_SNAPSHOT_ENTRIES)
      throw failure(
        "limit",
        `More than ${MAX_SNAPSHOT_ENTRIES} filesystem entries`,
      );
    if (entry.file) {
      files++;
      bytes += entry.size;
      if (files > MAX_SNAPSHOT_FILES || bytes > MAX_SNAPSHOT_BYTES)
        throw failure(
          "limit",
          `Limit is ${MAX_SNAPSHOT_FILES} files / ${MAX_SNAPSHOT_BYTES} bytes`,
        );
    } else {
      for await (const { name } of await opendir(entry.path)) {
        pending.push({
          path: join(entry.path, name),
          name: entry.name ? `${entry.name}/${name}` : name,
        });
        if (entries.length + pending.length > MAX_SNAPSHOT_ENTRIES)
          throw failure(
            "limit",
            `More than ${MAX_SNAPSHOT_ENTRIES} filesystem entries`,
          );
      }
    }
  }
  return entries.sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
}

async function readStable(entry: Entry): Promise<Buffer> {
  const handle = await open(entry.path, "r");
  try {
    if (fingerprint(await handle.stat({ bigint: true })) !== entry.fingerprint)
      throw failure("changed", entry.path);
    // Allocate only the size already checked against the aggregate limit.
    // A growing source cannot make readFile allocate an unbounded buffer.
    const bytes = Buffer.alloc(entry.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!read.bytesRead) throw failure("changed", entry.path);
      offset += read.bytesRead;
    }
    if (
      fingerprint(await handle.stat({ bigint: true })) !== entry.fingerprint ||
      (await inspect(entry.path, entry.name)).fingerprint !== entry.fingerprint
    )
      throw failure("changed", entry.path);
    return bytes;
  } finally {
    await handle.close();
  }
}

function addHashField(
  hash: ReturnType<typeof createHash>,
  name: string,
  bytes: Buffer,
): void {
  const key = Buffer.from(name);
  const length = Buffer.alloc(12);
  length.writeUInt32BE(key.length, 0);
  length.writeBigUInt64BE(BigInt(bytes.length), 4);
  hash.update(length).update(key).update(bytes);
}

function parseRange(
  header: string,
  length: number,
): [number, number] | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || !length || (!match[1] && !match[2])) return;
  const first = match[1] ? Number(match[1]) : undefined;
  const last = match[2] ? Number(match[2]) : undefined;
  if (
    (first !== undefined && !Number.isSafeInteger(first)) ||
    (last !== undefined && !Number.isSafeInteger(last))
  )
    return;
  if (first === undefined) {
    if (!last) return;
    return [Math.max(0, length - last), length - 1];
  }
  if (first >= length || (last !== undefined && last < first)) return;
  return [first, Math.min(last ?? length - 1, length - 1)];
}

async function listen(server: Server): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await new Promise<void>((done, reject) => {
        const failed = (error: Error) => {
          server.removeListener("listening", ready);
          reject(error);
        };
        const ready = () => {
          server.removeListener("error", failed);
          done();
        };
        server.once("error", failed).once("listening", ready);
        server.listen(randomInt(49152, 65536), "127.0.0.1");
      });
      const address = server.address();
      if (!address || typeof address === "string")
        throw failure("listen", "No loopback address");
      return address.port;
    } catch (error) {
      // Windows can reserve otherwise-unused ephemeral ranges (WSL/Hyper-V).
      // Try another high loopback port; never change system/network policy.
      if (
        !["EADDRINUSE", "EACCES"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
    }
  }
  throw failure("listen", "No high loopback port available after 20 attempts");
}

/** Freeze a trusted, explicitly selected static build before starting any worker.
 * CSP constrains dependencies; this is not a sandbox for hostile composition JS.
 */
export async function createInputSnapshot(
  options: InputSnapshotOptions,
): Promise<InputSnapshot> {
  const selectedRoot = resolve(options.root);
  const selectedEntry = resolve(selectedRoot, options.entryPath);
  const relativeEntry = relative(selectedRoot, selectedEntry);
  if (
    !relativeEntry ||
    isAbsolute(relativeEntry) ||
    relativeEntry === ".." ||
    relativeEntry.startsWith(`..${sep}`)
  )
    throw failure(
      "invalid_entry",
      "Entry must be a regular file inside snapshot root",
    );
  await rejectSymlinkAncestors(selectedRoot);
  if (!(await lstat(selectedRoot)).isDirectory())
    throw failure("invalid_root", selectedRoot);
  const root = await realpath(selectedRoot);
  const entryName = relativeEntry.split(sep).join("/");
  const before = await inventory(root);
  if (!before.some((entry) => entry.file && entry.name === entryName))
    throw failure("invalid_entry", entryName);

  let propsEntry: Entry | undefined;
  if (options.inputPropsPath !== undefined) {
    const path = resolve(options.inputPropsPath);
    await rejectSymlinkAncestors(path);
    propsEntry = await inspect(path, "inputProps");
    if (!propsEntry.file)
      throw failure("invalid_props", "Props must be a regular file");
  }
  const files = before.filter((entry) => entry.file);
  const totalBytes = files.reduce(
    (sum, entry) => sum + entry.size,
    propsEntry?.size ?? 0,
  );
  if (
    totalBytes > MAX_SNAPSHOT_BYTES ||
    files.length + (propsEntry ? 1 : 0) > MAX_SNAPSHOT_FILES
  )
    throw failure(
      "limit",
      `Limit includes props: ${MAX_SNAPSHOT_FILES} files / ${MAX_SNAPSHOT_BYTES} bytes`,
    );

  const frozen = new Map<string, Buffer>();
  for (const entry of files) frozen.set(entry.name, await readStable(entry));
  const props = propsEntry ? await readStable(propsEntry) : undefined;
  // A second full metadata and byte pass detects changes during capture rather
  // than quietly combining different source revisions. No live reads follow.
  const after = await inventory(root);
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw failure("changed", root);
  for (const entry of files)
    if (!(await readStable(entry)).equals(frozen.get(entry.name)!))
      throw failure("changed", entry.path);
  if (propsEntry && !(await readStable(propsEntry)).equals(props!))
    throw failure("changed", propsEntry.path);

  const hash = createHash("sha256").update("velocast-static-snapshot-v1\0");
  addHashField(hash, "entry", Buffer.from(entryName));
  for (const entry of files)
    addHashField(hash, `file:${entry.name}`, frozen.get(entry.name)!);
  addHashField(
    hash,
    props === undefined ? "props:absent" : "props:present",
    props ?? Buffer.alloc(0),
  );
  const session = Object.freeze({
    sessionId: randomUUID(),
    sourceVersion: hash.digest("hex"),
  });
  let parentOrigin: string | undefined;
  if (options.preview) {
    const preview = options.preview;
    parentOrigin = previewOrigin(preview.parentOrigin);
    if (![".html", ".htm"].includes(extname(entryName).toLowerCase()))
      throw failure("invalid_preview", "Preview requires an HTML entry");
    if (
      before.some(
        (entry) =>
          entry.name === PREVIEW_PREFIX.slice(0, -1) ||
          entry.name.startsWith(PREVIEW_PREFIX),
      )
    )
      throw failure(
        "invalid_preview",
        "Authored input uses the reserved preview namespace",
      );
    let extraBytes = 0;
    const entries = Object.entries(preview.assets);
    if (
      !entries.some(([name]) => name === preview.entryScript) ||
      !/\.m?js$/.test(preview.entryScript)
    )
      throw failure(
        "invalid_preview",
        "Preview entry script must be a provided JavaScript module",
      );
    for (const [name, bytes] of entries) {
      if (
        !/^[a-zA-Z0-9_./-]+$/.test(name) ||
        name.startsWith("/") ||
        name
          .split("/")
          .some((part) => !part || part === "." || part === "..") ||
        !ArrayBuffer.isView(bytes) ||
        bytes.BYTES_PER_ELEMENT !== 1
      )
        throw failure(
          "invalid_preview",
          "Platform assets must use safe relative names and byte views",
        );
      extraBytes += bytes.byteLength;
      if (
        totalBytes + extraBytes > MAX_SNAPSHOT_BYTES ||
        frozen.size + 1 + (propsEntry ? 1 : 0) > MAX_SNAPSHOT_FILES
      )
        throw failure(
          "limit",
          "Preview instrumentation exceeds snapshot limits",
        );
      frozen.set(PREVIEW_PREFIX + name, Buffer.from(bytes));
    }
    const scriptPath =
      "/" +
      PREVIEW_PREFIX +
      preview.entryScript.split("/").map(encodeURIComponent).join("/");
    const addition = Buffer.from(
      `\n<script type="module" src="${scriptPath}"></script>\n`,
    );
    if (totalBytes + extraBytes + addition.length > MAX_SNAPSHOT_BYTES)
      throw failure(
        "limit",
        "Preview entry instrumentation exceeds snapshot limits",
      );
    // Like native browser injection, this is platform code, not an authored-source edit.
    // The content digest below still identifies the exact bytes actually served.
    frozen.set(entryName, Buffer.concat([frozen.get(entryName)!, addition]));
  }
  // Precompute once: media range requests must not repeatedly hash large files.
  const contentHashes = new Map(
    [...frozen].map(([name, bytes]) => [
      name,
      createHash("sha256").update(bytes).digest("hex"),
    ]),
  );
  let temporary: string | undefined,
    inputPropsPath: string | undefined,
    origin = "";
  const server = createServer((request, response) => {
    response.setHeader(
      "Content-Security-Policy",
      parentOrigin
        ? CSP.replace(
            "frame-ancestors 'none'",
            `frame-ancestors ${parentOrigin}`,
          )
        : CSP,
    );
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    if (
      request.headers.host !== new URL(origin).host ||
      (request.headers.origin &&
        request.headers.origin !== origin &&
        request.headers.origin !== parentOrigin)
    ) {
      response.writeHead(403).end();
      return;
    }
    if (parentOrigin && request.headers.origin === parentOrigin) {
      response.setHeader("Access-Control-Allow-Origin", parentOrigin);
      response.setHeader(
        "Access-Control-Expose-Headers",
        "X-Velocast-Source-Version, X-Velocast-Content-SHA256",
      );
      response.setHeader("Vary", "Origin");
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    let requestUrl: URL;
    try {
      requestUrl = new URL(request.url ?? "/", origin);
      if (requestUrl.origin !== origin) throw new Error("Foreign origin");
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (requestUrl.pathname === "/__velocast-media/frame") {
      if (!options.handleMediaRequest) {
        response.writeHead(404).end();
        return;
      }
      void options
        .handleMediaRequest(request, response, {
          url: `${origin}/${entryName.split("/").map(encodeURIComponent).join("/")}`,
          session,
        })
        .catch((error) => {
          if (!response.headersSent) {
            response.setHeader("Content-Type", "application/json");
            response
              .writeHead(500)
              .end(
                JSON.stringify({
                  error: {
                    code: "video.request_failed",
                    message:
                      error instanceof Error ? error.message : String(error),
                  },
                }),
              );
          } else response.destroy();
        });
      return;
    }
    let name: string;
    try {
      const url = new URL(request.url ?? "/", origin);
      if (url.origin !== origin) throw new Error("Foreign origin");
      name = decodeURIComponent(url.pathname).slice(1);
      if (
        name.includes("\\") ||
        name.includes("\0") ||
        name.split("/").includes("..")
      )
        throw new Error("Invalid path");
      if (!name || name.endsWith("/")) name += "index.html";
    } catch {
      response.writeHead(400).end();
      return;
    }
    const bytes = frozen.get(name);
    if (!bytes) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader(
      "Content-Type",
      MIME[extname(name).toLowerCase()] ?? "application/octet-stream",
    );
    response.setHeader("Accept-Ranges", "bytes");
    let body = bytes;
    if (request.headers.range) {
      const range = parseRange(request.headers.range, bytes.length);
      if (!range) {
        response
          .writeHead(416, { "Content-Range": `bytes */${bytes.length}` })
          .end();
        return;
      }
      response.statusCode = 206;
      response.setHeader(
        "Content-Range",
        `bytes ${range[0]}-${range[1]}/${bytes.length}`,
      );
      body = bytes.subarray(range[0], range[1] + 1);
    }
    response.setHeader("Content-Length", body.length);
    response.setHeader("X-Velocast-Source-Version", session.sourceVersion);
    // This identifies the full frozen object, including on HEAD/206 responses.
    response.setHeader("X-Velocast-Content-SHA256", contentHashes.get(name)!);
    response.end(request.method === "HEAD" ? undefined : body);
  });
  let closed: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closed ??= (async () => {
      if (server.listening)
        await new Promise<void>((done) => {
          server.close(() => done());
          server.closeAllConnections();
        });
      frozen.clear();
      contentHashes.clear();
      if (temporary) await rm(temporary, { recursive: true, force: true });
    })());
  try {
    if (props !== undefined) {
      temporary = await mkdtemp(join(tmpdir(), "velocast-input-snapshot-"));
      inputPropsPath = join(temporary, "input-props.json");
      await writeFile(inputPropsPath, props, { flag: "wx", mode: 0o400 });
    }
    origin = `http://127.0.0.1:${await listen(server)}`;
    return {
      url: `${origin}/${entryName.split("/").map(encodeURIComponent).join("/")}`,
      session,
      ...(inputPropsPath === undefined ? {} : { inputPropsPath }),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

import { createServer } from "node:http";
import { createReadStream, createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { mkdir, readFile, realpath, stat, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { extname, join, resolve, sep } from "node:path";
import { createMediaSession, type MediaSession } from "velocast/source-media";

export async function serveRemotionBundle(
  root: string,
  workspace: string,
  signal: AbortSignal,
  limits: {
    maxSources?: number;
    maxSourceBytes?: number;
    maxTotalBytes?: number;
  } = {},
) {
  const cache = new Map<string, Promise<string>>();
  const rootPath = await realpath(root);
  const maxSources = limits.maxSources ?? 64,
    maxSourceBytes = limits.maxSourceBytes ?? 512 * 1024 * 1024,
    maxTotalBytes = limits.maxTotalBytes ?? 1024 * 1024 * 1024;
  for (const value of [maxSources, maxSourceBytes, maxTotalBytes])
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error("remotion.invalid_media_limit");
  let totalBytes = 0,
    proxyRequests = 0;

  let session: Promise<MediaSession> | undefined;
  let origin = "";
  const assets = join(workspace, "media");
  await mkdir(assets);
  const local = async (pathname: string): Promise<string> => {
    const file = resolve(rootPath, `.${decodeURIComponent(pathname)}`);
    if (file !== rootPath && !file.startsWith(rootPath + sep))
      throw new Error("remotion.asset_path_escape");
    const canonical = await realpath(file);
    if (canonical !== rootPath && !canonical.startsWith(rootPath + sep))
      throw new Error("remotion.asset_path_escape: symlink leaves the bundle");
    return canonical;
  };
  const freeze = (source: string): Promise<string> => {
    const url = new URL(source, origin);
    if (!["http:", "https:", "data:"].includes(url.protocol))
      return Promise.reject(
        new Error(
          "remotion.asset_protocol: media must be HTTP(S) or data URLs",
        ),
      );
    let pending = cache.get(url.href);
    if (!pending) {
      if (cache.size >= maxSources)
        return Promise.reject(new Error("remotion.source_count_limit"));
      pending = (async () => {
        signal.throwIfAborted();
        if (url.origin === origin) {
          const file = await local(url.pathname),
            details = await stat(file);
          if (
            !details.isFile() ||
            details.size > maxSourceBytes ||
            totalBytes + details.size > maxTotalBytes
          )
            throw new Error(
              "remotion.asset_limit: source or total byte budget exceeded",
            );
          totalBytes += details.size;
          return file;
        }
        const file = join(
          assets,
          createHash("sha256").update(url.href).digest("hex"),
        );
        let bytes = 0;
        try {
          const response = await fetch(url, { signal });
          if (!response.ok || !response.body)
            throw new Error(`remotion.asset_fetch: ${response.status}`);
          const budget = new Transform({
            transform(chunk: Buffer, _encoding, next) {
              if (
                bytes + chunk.length > maxSourceBytes ||
                totalBytes + chunk.length > maxTotalBytes
              ) {
                next(
                  new Error(
                    "remotion.asset_limit: source or total byte budget exceeded",
                  ),
                );
                return;
              }
              bytes += chunk.length;
              totalBytes += chunk.length;
              next(null, chunk);
            },
          });
          await pipeline(
            Readable.fromWeb(
              response.body as Parameters<typeof Readable.fromWeb>[0],
            ),
            budget,
            createWriteStream(file, { flags: "wx", mode: 0o600 }),
            { signal },
          );
          return file;
        } catch (error) {
          totalBytes -= bytes;
          await rm(file, { force: true });
          throw error;
        }
      })();
      cache.set(url.href, pending);
    }
    return pending;
  };
  const active = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    const work = (async () => {
      const url = new URL(request.url ?? "/", origin);
      const authority = new URL(origin).host;
      if (
        request.headers.host !== authority &&
        request.headers.host !== authority.replace("127.0.0.1", "localhost")
      ) {
        response.writeHead(403);
        response.end("remotion.host_mismatch");
        return;
      }
      const requestOrigin = request.headers.origin;
      const sameSourceOrigin =
        requestOrigin === origin ||
        requestOrigin === origin.replace("127.0.0.1", "localhost");
      if (
        (requestOrigin && !sameSourceOrigin) ||
        (!requestOrigin && request.headers["sec-fetch-site"] === "cross-site")
      ) {
        response.writeHead(403);
        response.end("remotion.origin_mismatch");
        return;
      }
      if (sameSourceOrigin) {
        response.setHeader("Access-Control-Allow-Origin", requestOrigin);
        response.setHeader("Vary", "Origin");
      }

      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }
      if (url.pathname === "/proxy") {
        if (proxyRequests >= 16) {
          response.writeHead(429);
          response.end("remotion.proxy_queue_limit");
          return;
        }
        proxyRequests++;
        try {
          const source = url.searchParams.get("src"),
            timestamp = Number(url.searchParams.get("time"));
          if (!source || !Number.isFinite(timestamp))
            throw new Error("remotion.invalid_video_request");
          const file = await freeze(source);
          const outputPath = join(assets, `${randomUUID()}.png`);
          session ??= createMediaSession({ signal });
          try {
            await (
              await session
            ).run(
              { kind: "frame", path: file, timestamp, outputPath },
              { signal },
            );
            const bytes = await readFile(outputPath);
            response.writeHead(200, {
              "Content-Type": "image/png",
              "Cache-Control": "no-store",
            });
            response.end(bytes);
          } finally {
            await rm(outputPath, { force: true });
          }
          return;
        } finally {
          proxyRequests--;
        }
      }
      const file = await local(
          url.pathname === "/" ? "/index.html" : url.pathname,
        ),
        details = await stat(file);
      if (!details.isFile()) throw new Error("remotion.asset_not_file");
      const mime: Record<string, string> = {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".wav": "audio/wav",
        ".mp3": "audio/mpeg",
        ".mp4": "video/mp4",
        ".webm": "video/webm",
      };
      let start = 0,
        end = details.size - 1,
        status = 200;
      const range = request.headers.range;
      if (range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(range);
        if (!match) {
          response.writeHead(416);
          response.end();
          return;
        }
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : end;
        if (start > end || end >= details.size) {
          response.writeHead(416);
          response.end();
          return;
        }
        status = 206;
        response.setHeader(
          "Content-Range",
          `bytes ${start}-${end}/${details.size}`,
        );
      }
      response.writeHead(status, {
        "Content-Type": mime[extname(file)] ?? "application/octet-stream",
        "Content-Length": Math.max(0, end - start + 1),
        "Accept-Ranges": "bytes",
      });
      if (request.method === "HEAD" || !details.size) response.end();
      else
        createReadStream(file, { start, end })
          .on("error", () => response.destroy())
          .pipe(response);
    })().catch((error) => {
      if (!response.headersSent)
        response.writeHead(422, { "Content-Type": "text/plain" });
      response.end(error instanceof Error ? error.message : String(error));
    });
    active.add(work);
    void work.finally(() => active.delete(work));
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => done());
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("remotion.server_address");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    url: origin,
    port: address.port,
    freeze,
    async close() {
      await (await session)?.close();
      server.closeAllConnections();
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
      await Promise.allSettled(active);
    },
  };
}

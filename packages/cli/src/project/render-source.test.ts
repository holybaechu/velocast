import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  normalizeConfigEntryFromConfigDir,
  resolveCompositionRenderSource,
  resolveEntryUrl,
} from "./render-source.js";

const tempDirs: string[] = [];

function mkTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "velocast-render-source-"));
  tempDirs.push(dir);
  return dir;
}

function writeEntry(dir: string, name = "index.html"): string {
  const path = join(dir, name);
  writeFileSync(path, "<!doctype html><title>entry</title>");
  return path;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveCompositionRenderSource", () => {
  it("resolves explicit snapshot roots from invocation context while leaving unmanaged inputs unversioned", () => {
    const dir = mkTempDir();
    const root = join(dir, "dist");
    mkdirSync(root);
    const entry = writeEntry(root);
    expect(
      resolveCompositionRenderSource(
        { entry: "dist/index.html", renderer: { snapshotRoot: "dist" } },
        { cwd: root, env: { INIT_CWD: dir } },
      ),
    ).toEqual({
      kind: "entry",
      url: pathToFileURL(entry).href,
      snapshotRoot: root,
    });
    expect(
      resolveCompositionRenderSource({ entry }, { cwd: dir, env: {} }),
    ).toEqual({ kind: "entry", url: pathToFileURL(entry).href });
  });

  it("normalizes snapshot root independently of optional entry against the config directory", () => {
    const dir = mkTempDir();
    expect(
      normalizeConfigEntryFromConfigDir(
        { renderer: { snapshotRoot: "dist", codec: "h264" } },
        dir,
      ),
    ).toEqual({ renderer: { snapshotRoot: join(dir, "dist"), codec: "h264" } });
    expect(
      normalizeConfigEntryFromConfigDir(
        { entry: "dist/index.html", renderer: { snapshotRoot: "dist" } },
        dir,
      ),
    ).toEqual({
      entry: join(dir, "dist/index.html"),
      renderer: { snapshotRoot: join(dir, "dist") },
    });
    expect(
      normalizeConfigEntryFromConfigDir(
        {
          entry: "file:///tmp/index.html",
          renderer: { snapshotRoot: pathToFileURL(dir).href },
        },
        dir,
      ),
    ).toEqual({
      entry: "file:///tmp/index.html",
      renderer: { snapshotRoot: dir },
    });
  });

  it("rejects blank/HTTP snapshot roots, missing local entries and ambiguous live server input", () => {
    expect(() =>
      resolveCompositionRenderSource({ renderer: { snapshotRoot: " " } }),
    ).toThrow("renderer.snapshotRoot must be a non-empty local directory path");
    expect(() =>
      resolveCompositionRenderSource({
        renderer: { snapshotRoot: "https://example.invalid/dist" },
      }),
    ).toThrow("renderer.snapshotRoot must be a local directory path");
    expect(() =>
      resolveCompositionRenderSource({ renderer: { snapshotRoot: "dist" } }),
    ).toThrow("snapshot.requires_local_entry");
    expect(() =>
      resolveCompositionRenderSource({
        entry: "index.html",
        serve: { url: "http://localhost:3000" },
        renderer: { snapshotRoot: "dist" },
      }),
    ).toThrow("snapshot.requires_local_entry");
    expect(() =>
      resolveCompositionRenderSource({
        entry: "https://example.invalid/index.html",
        renderer: { snapshotRoot: "dist" },
      }),
    ).toThrow("config entry URLs must use the file:// scheme");
  });

  it("uses serve.url before entry", () => {
    const source = resolveCompositionRenderSource({
      entry: "missing.html",
      serve: {
        url: " http://127.0.0.1:4545 ",
        command: "pnpm --filter playground dev",
      },
    });

    expect(source).toEqual({
      kind: "serve",
      url: "http://127.0.0.1:4545",
    });
  });

  it("requires serve.url or entry", () => {
    expect(() => resolveCompositionRenderSource({})).toThrow(
      "config serve.url or entry is required for render",
    );
  });

  it("resolves local entry paths against invocation cwd", () => {
    const dir = mkTempDir();
    const entry = writeEntry(dir);

    const source = resolveCompositionRenderSource(
      { entry: "index.html" },
      { cwd: dir, env: {} },
    );

    expect(source).toEqual({
      kind: "entry",
      url: pathToFileURL(entry).href,
    });
  });

  it("preserves valid file URL entries", () => {
    const dir = mkTempDir();
    const entry = writeEntry(dir);

    expect(resolveEntryUrl(pathToFileURL(entry).href)).toBe(
      pathToFileURL(entry).href,
    );
  });

  it("rejects blank and missing entries clearly", () => {
    expect(() => resolveEntryUrl(" ")).toThrow(
      "config entry must be a non-empty string",
    );

    const dir = mkTempDir();
    expect(() =>
      resolveCompositionRenderSource(
        { entry: "missing.html" },
        { cwd: dir, env: {} },
      ),
    ).toThrow(`config entry was not found: ${join(dir, "missing.html")}`);
  });

  it("rejects directory entries clearly", () => {
    const dir = mkTempDir();
    const entryDir = join(dir, "entry-dir");
    mkdirSync(entryDir);

    expect(() =>
      resolveCompositionRenderSource(
        { entry: "entry-dir" },
        { cwd: dir, env: {} },
      ),
    ).toThrow(`config entry must be a file: ${entryDir}`);

    expect(() => resolveEntryUrl(pathToFileURL(entryDir).href)).toThrow(
      `config entry must be a file: ${entryDir}`,
    );
  });

  it("rejects non-file entry URLs", () => {
    expect(() => resolveEntryUrl("https://example.com/index.html")).toThrow(
      "config entry URLs must use the file:// scheme",
    );
  });

  it("normalizes config-loaded relative entries against the config directory", () => {
    const dir = mkTempDir();
    const configDir = join(dir, "apps", "demo");
    mkdirSync(configDir, { recursive: true });

    expect(
      normalizeConfigEntryFromConfigDir({ entry: "index.html" }, configDir),
    ).toEqual({ entry: join(configDir, "index.html") });

    expect(
      normalizeConfigEntryFromConfigDir(
        { entry: "file:///tmp/index.html" },
        configDir,
      ),
    ).toEqual({ entry: "file:///tmp/index.html" });
  });
});

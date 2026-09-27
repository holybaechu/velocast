import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupRenderOutputOnFailure } from "./render-output-cleanup.js";

const tempDirs: string[] = [];

afterEach(() => {
  cleanupTempDirs();
});

describe("cleanupRenderOutputOnFailure", () => {
  it("removes partial render output when renderer fails", async () => {
    const output = join(mkTempDir("velocast-render-"), "out.mp4");

    await expect(
      cleanupRenderOutputOnFailure(output, async () => {
        writeFileSync(output, "partial");
        throw new Error("frame 0 timed out waiting for accelerated paint");
      }),
    ).rejects.toThrow("frame 0 timed out waiting for accelerated paint");
    expect(existsSync(output)).toBe(false);
  });

  it("preserves an existing output when renderer fails before touching it", async () => {
    const output = join(mkTempDir("velocast-render-"), "out.mp4");
    writeFileSync(output, "existing");

    await expect(
      cleanupRenderOutputOnFailure(output, async () => {
        throw new Error("frame 0 timed out waiting for accelerated paint");
      }),
    ).rejects.toThrow("frame 0 timed out waiting for accelerated paint");
    expect(readFileSync(output, "utf8")).toBe("existing");
  });

  it("removes touched output even when size and mtime match the previous file", async () => {
    const output = join(mkTempDir("velocast-render-"), "out.mp4");
    writeFileSync(output, "existing");

    await expect(
      cleanupRenderOutputOnFailure(output, async () => {
        const before = statSync(output);
        writeFileSync(output, "partial!");
        utimesSync(output, before.atime, before.mtime);
        throw new Error("renderer failed after rewriting output");
      }),
    ).rejects.toThrow("renderer failed after rewriting output");

    expect(existsSync(output)).toBe(false);
  });

  it("preserves the renderer failure when best-effort cleanup fails", async () => {
    const output = join(mkTempDir("velocast-render-"), "out.mp4");
    const rendererError = new Error("renderer failed before closing output");
    const failingRmSync: typeof rmSync = () => {
      throw new Error("cleanup failed");
    };

    await expect(
      cleanupRenderOutputOnFailure(
        output,
        async () => {
          writeFileSync(output, "partial");
          throw rendererError;
        },
        { fs: { rmSync: failingRmSync, statSync } },
      ),
    ).rejects.toBe(rendererError);

    expect(readFileSync(output, "utf8")).toBe("partial");
  });
});

function mkTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function cleanupTempDirs(): void {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

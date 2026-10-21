import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getInvocationCwd,
  resolveCliInputPropsPath,
  resolveCliOutputPath,
  resolveCliReportPath,
  resolvePathFrom,
} from "./paths.js";

const tempDirs: string[] = [];

afterEach(() => {
  cleanupTempDirs();
});

describe("getInvocationCwd", () => {
  it("uses INIT_CWD before the process cwd fallback", () => {
    expect(
      getInvocationCwd({
        cwd: "/workspace/package",
        env: { INIT_CWD: "/workspace/app" },
      }),
    ).toBe("/workspace/app");
  });

  it("ignores blank INIT_CWD values", () => {
    expect(
      getInvocationCwd({
        cwd: "/workspace/package",
        env: { INIT_CWD: "" },
      }),
    ).toBe("/workspace/package");

    expect(
      getInvocationCwd({
        cwd: "/workspace/package",
        env: { INIT_CWD: "   " },
      }),
    ).toBe("/workspace/package");
  });

  it("ignores blank cwd values", () => {
    expect(
      getInvocationCwd({
        cwd: "",
        env: {},
      }),
    ).toBe(process.cwd());

    expect(
      getInvocationCwd({
        cwd: "   ",
        env: {},
      }),
    ).toBe(process.cwd());
  });
});

describe("resolvePathFrom", () => {
  it("resolves POSIX relative paths from the provided base directory", () => {
    expect(resolvePathFrom("/workspace/app", "renders/out.mp4")).toBe(
      "/workspace/app/renders/out.mp4",
    );
  });

  it("resolves Windows relative paths from the provided base directory", () => {
    expect(resolvePathFrom("C:\\workspace\\app", "renders/out.mp4")).toBe(
      "C:\\workspace\\app\\renders\\out.mp4",
    );
  });

  it("preserves absolute paths", () => {
    expect(resolvePathFrom("/workspace/app", "/tmp/out.mp4")).toBe(
      "/tmp/out.mp4",
    );
    expect(resolvePathFrom("C:\\workspace\\app", "D:\\renders\\out.mp4")).toBe(
      "D:\\renders\\out.mp4",
    );
  });
});

describe("resolveCliOutputPath", () => {
  it("resolves relative output paths from the original pnpm invocation directory", () => {
    expect(
      resolveCliOutputPath("renders/product-hero.mp4", {
        env: { INIT_CWD: "C:\\workspace\\velocast" },
      }),
    ).toBe("C:\\workspace\\velocast\\renders\\product-hero.mp4");
  });

  it("rejects an empty output path", () => {
    expect(() => resolveCliOutputPath("  ")).toThrow(
      "--output must be a non-empty string",
    );
  });

  it("rejects non-string output paths from CLI parser edge cases", () => {
    expect(() => resolveCliOutputPath(true as unknown as string)).toThrow(
      "--output must be a non-empty string",
    );
  });
});

describe("resolveCliReportPath", () => {
  it("resolves relative report paths from the original pnpm invocation directory", () => {
    expect(
      resolveCliReportPath("renders/report.json", {
        env: { INIT_CWD: "C:\\workspace\\velocast" },
      }),
    ).toBe("C:\\workspace\\velocast\\renders\\report.json");
  });

  it("rejects an empty report path", () => {
    expect(() => resolveCliReportPath("  ")).toThrow(
      "renderer.reportPath must be a non-empty string",
    );
  });

  it("uses a caller-specific error message for empty report paths", () => {
    expect(() =>
      resolveCliReportPath(
        "  ",
        {},
        "--report must be a non-empty string",
      ),
    ).toThrow("--report must be a non-empty string");
  });

  it("rejects non-string report paths from CLI parser edge cases", () => {
    expect(() =>
      resolveCliReportPath(true as unknown as string),
    ).toThrow("renderer.reportPath must be a non-empty string");
  });
});

describe("resolveCliInputPropsPath", () => {
  it("resolves and validates an input props JSON file", () => {
    const directory = mkTempDir("velocast-input-props-");
    const inputProps = join(directory, "input-props.json");
    writeFileSync(inputProps, JSON.stringify({ song: { id: "123" } }));

    expect(resolveCliInputPropsPath(inputProps)).toBe(inputProps);
  });

  it("rejects an input props file that is not valid JSON", () => {
    const directory = mkTempDir("velocast-input-props-");
    const inputProps = join(directory, "input-props.json");
    writeFileSync(inputProps, "{ nope");

    expect(() => resolveCliInputPropsPath(inputProps)).toThrow(
      "--input-props-file must contain valid JSON",
    );
  });

  it("rejects non-string input props paths from CLI parser edge cases", () => {
    expect(() =>
      resolveCliInputPropsPath(true as unknown as string),
    ).toThrow("--input-props-file must be a non-empty string");
  });

  it("accepts a UTF-8 BOM in the input props JSON file", () => {
    const directory = mkTempDir("velocast-input-props-");
    const inputProps = join(directory, "input-props.json");
    writeFileSync(inputProps, '\uFEFF{"song":{"id":"123"}}');

    expect(resolveCliInputPropsPath(inputProps)).toBe(inputProps);
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

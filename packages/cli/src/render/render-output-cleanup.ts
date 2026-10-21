import { rmSync, statSync, type Stats } from "node:fs";

/**
 * Legacy opt-in cleanup for adapters writing partial data to the final path.
 * Native render jobs own publication and rollback; do not wrap them with this.
 * @deprecated Use the native transactional publication path for new adapters.
 */
export async function cleanupRenderOutputOnFailure(
  output: string,
  render: () => Promise<void>,
  options: CleanupRenderOutputOptions = {},
): Promise<void> {
  const fs = options.fs ?? defaultCleanupFs;
  const before = statOutput(output, fs);

  try {
    await render();
  } catch (error) {
    const after = statOutput(output, fs);
    if (
      after &&
      (!before ||
        before.ctimeMs !== after.ctimeMs ||
        before.mtimeMs !== after.mtimeMs ||
        before.size !== after.size)
    ) {
      removeTouchedOutput(output, fs);
    }
    throw error;
  }
}

function removeTouchedOutput(output: string, fs: CleanupRenderOutputFs): void {
  try {
    fs.rmSync(output, { force: true });
  } catch {
    // Preserve the renderer failure; cleanup is best-effort once the render failed.
  }
}

function statOutput(
  output: string,
  fs: CleanupRenderOutputFs,
): OutputSnapshot | undefined {
  try {
    const stat = fs.statSync(output);
    return stat.isFile()
      ? { ctimeMs: stat.ctimeMs, mtimeMs: stat.mtimeMs, size: stat.size }
      : undefined;
  } catch {
    return undefined;
  }
}

const defaultCleanupFs: CleanupRenderOutputFs = {
  rmSync,
  statSync,
};

export interface CleanupRenderOutputOptions {
  fs?: CleanupRenderOutputFs;
}

export interface CleanupRenderOutputFs {
  rmSync: typeof rmSync;
  statSync(
    path: string,
  ): Pick<Stats, "ctimeMs" | "mtimeMs" | "size" | "isFile">;
}

interface OutputSnapshot {
  ctimeMs: number;
  mtimeMs: number;
  size: number;
}

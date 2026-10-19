import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
export async function mediaWorkspace(): Promise<{
  path: string;
  close(): Promise<void>;
}> {
  const parent = await realpath(tmpdir());
  const path = await mkdtemp(join(parent, "velocast-media-"));
  return {
    path,
    async close() {
      // Remove our directory entry without following a replaced root symlink.
      await rm(path, { recursive: true, force: true });
    },
  };
}

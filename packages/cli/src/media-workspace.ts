import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
export async function mediaWorkspace(): Promise<{
  path: string;
  close(): Promise<void>;
}> {
  const parent = await realpath(tmpdir());
  const path = await mkdtemp(join(parent, "velocast-media-"));
  return {
    path,
    async close() {
      const target = await realpath(path);
      if (
        dirname(target) !== resolve(parent) ||
        !basename(target).startsWith("velocast-media-")
      )
        throw new Error("Refusing cleanup outside owned media workspace");
      await rm(target, { recursive: true, force: true });
    },
  };
}

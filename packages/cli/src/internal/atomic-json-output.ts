import { randomUUID } from "node:crypto";
import { link, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Publish generated JSON without exposing partial bytes to a build watcher. */
export async function writeJsonOutput(
  path: string,
  contents: string,
  overwrite: boolean,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${basename(path)}.velocast-${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, contents, { flag: "wx" });
    if (overwrite) await rename(temporary, path);
    else await link(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

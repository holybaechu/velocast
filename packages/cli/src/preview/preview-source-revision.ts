import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

/** A cheap change hint; the immutable snapshot remains the content authority. */
export async function previewSourceRevision(
  root: string,
  propsPath?: string,
): Promise<string> {
  const hash = createHash("sha256");
  let count = 0;
  const visit = async (path: string, name: string): Promise<void> => {
    if (++count > 20_000)
      throw new Error(
        "preview.source_limit: source tree exceeds 20000 entries",
      );
    const info = await lstat(path, { bigint: true });
    if (info.isSymbolicLink())
      throw new Error(
        "preview.source_link: rebuild without linked source files",
      );
    hash.update(
      JSON.stringify([
        name,
        String(info.size),
        String(info.mtimeNs),
        String(info.ctimeNs),
      ]),
    );
    if (info.isDirectory()) {
      const names = (await readdir(path)).sort();
      for (const child of names)
        await visit(join(path, child), name + "/" + child);
    } else if (!info.isFile()) {
      throw new Error("preview.source_type: source must contain regular files");
    }
  };
  await visit(root, ".");
  if (propsPath) await visit(propsPath, "@input-props");
  return hash.digest("hex");
}

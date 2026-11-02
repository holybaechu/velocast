import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  MAX_SOURCE_RECEIPT_BYTES,
  MAX_SOURCE_RECEIPT_ENTRIES,
  SOURCE_RECEIPT_FILE,
  validReceiptId,
} from "./studio/source-receipt.js";

interface BuildContext {
  getModuleIds(): IterableIterator<string>;
}
interface OutputFile {
  type: string;
  modules?: Record<string, unknown>;
}
interface OutputOptions {
  dir?: string;
  file?: string;
  plugins?: ReadonlyArray<OutputPlugin>;
}
interface OutputPlugin {
  name: string;
  writeBundle?: unknown;
}

const moduleKey = (id: string) => {
  const path = id.replaceAll("\\", "/");
  return process.platform === "win32" ? path.toLowerCase() : path;
};

/** Records the exact configured module bytes consumed by each successful Vite build. */
export function studioSourcePlugin(sources: Record<string, string>) {
  if (!sources || typeof sources !== "object" || Array.isArray(sources))
    throw new Error(
      "studio.source_config: sources must map composition IDs to source files",
    );
  const entries = Object.entries(sources);
  if (
    !entries.length ||
    entries.length > MAX_SOURCE_RECEIPT_ENTRIES ||
    entries.some(
      ([id, path]) =>
        !validReceiptId(id) || typeof path !== "string" || !path.trim(),
    )
  )
    throw new Error(
      "studio.source_config: provide 1–512 composition IDs mapped to source files",
    );
  const files = new Map<string, { id: string; path: string }>();
  // Watch builds may reuse compiled modules without calling load again.
  const revisions = new Map<string, string>();
  const candidates = new Map<string, string>();
  let root = "";
  let outputDirectory = "";
  const destination = (options: OutputOptions) =>
    options.dir
      ? resolve(root, options.dir)
      : options.file
        ? dirname(resolve(root, options.file))
        : outputDirectory;
  const checkOutputHooks = (
    plugins: ReadonlyArray<OutputPlugin> = [],
  ): void => {
    for (const other of plugins) {
      const hook = other.writeBundle;
      if (
        other !== plugin &&
        hook &&
        typeof hook === "object" &&
        "order" in hook &&
        hook.order === "post"
      )
        throw new Error(
          `studio.source_hook_order: ${other.name} must use a regular writeBundle hook instead of order: 'post'; Studio source receipts must publish after all other output hooks succeed`,
        );
    }
  };
  const plugin = {
    name: "velocast-studio-sources",
    enforce: "pre" as const,
    apply: "build" as const,
    configResolved(config: {
      root: string;
      build?: { outDir?: string };
      plugins?: ReadonlyArray<OutputPlugin>;
    }): void {
      checkOutputHooks(config.plugins);
      root = config.root;
      outputDirectory = resolve(root, config.build?.outDir ?? "dist");
      files.clear();
      revisions.clear();
      for (const [id, relativePath] of entries) {
        let path: string;
        try {
          path = realpathSync(resolve(config.root, relativePath));
          if (!lstatSync(path).isFile())
            throw new Error("expected a regular source file");
        } catch (error) {
          throw new Error(
            `studio.source_file: ${id}: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
        const key = moduleKey(path);
        if (files.has(key))
          throw new Error(
            "studio.source_config: each composition needs its own source file",
          );
        files.set(key, { id, path });
      }
    },
    async load(
      this: { addWatchFile(path: string): void },
      id: string,
    ): Promise<string | null> {
      const key = moduleKey(id);
      const file = files.get(key);
      if (!file) return null;
      this.addWatchFile(file.path);
      const bytes = await readFile(file.path);
      let source: string;
      try {
        source = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes);
      } catch {
        throw new Error(`studio.source_encoding: ${file.id} must use UTF-8`);
      }
      revisions.set(key, createHash("sha256").update(bytes).digest("hex"));
      return source;
    },
    generateBundle(
      this: BuildContext,
      options: OutputOptions,
      bundle: Record<string, OutputFile>,
    ) {
      const directory = destination(options);
      candidates.delete(directory);
      checkOutputHooks(options.plugins);
      const graph = new Set([...this.getModuleIds()].map(moduleKey));
      const included = new Set(
        Object.values(bundle).flatMap((file) =>
          file.type === "chunk"
            ? Object.keys(file.modules ?? {}).map(moduleKey)
            : [],
        ),
      );
      const compiled: Record<string, string> = Object.create(null);
      for (const [key, file] of files) {
        const revision = revisions.get(key);
        if (!graph.has(key) || !included.has(key) || !revision)
          throw new Error(
            `studio.source_not_built: ${file.id} was not loaded into this build; import its composition from the project entry and place studioSourcePlugin before other source loaders`,
          );
        compiled[file.id] = revision;
      }
      const receipt =
        JSON.stringify({ version: 1, revisions: compiled }) + "\n";
      if (Buffer.byteLength(receipt) > MAX_SOURCE_RECEIPT_BYTES)
        throw new Error(
          "studio.source_receipt_limit: source receipt exceeds 128 KiB; reduce composition IDs or their length",
        );
      candidates.set(directory, receipt);
    },
    writeBundle: {
      order: "post" as const,
      sequential: true,
      async handler(options: OutputOptions) {
        const directory = destination(options);
        const receipt = candidates.get(directory);
        if (!receipt)
          throw new Error(
            "studio.source_receipt: this output has no completed source receipt",
          );
        const temporary = join(
          directory,
          `.velocast-sources-${randomUUID()}.tmp`,
        );
        try {
          await writeFile(temporary, receipt, { flag: "wx" });
          await rename(temporary, join(directory, SOURCE_RECEIPT_FILE));
        } finally {
          candidates.delete(directory);
          await rm(temporary, { force: true });
        }
      },
    },
  };
  return plugin;
}

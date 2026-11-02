import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CodeEdit, CodeElement, CodeSource } from "@velocast/core";
import { checkCodePath, StudioCodeError } from "./studio-code-config.js";
import { editCodeSource, inspectCodeSource } from "./studio-code-parser.js";

export const MAX_STUDIO_CODE_BYTES = 1024 * 1024;
interface SourceFile {
  path: string;
  revision?: string;
  parsed?: { revision: string; elements: CodeElement[] };
  undo: Buffer[];
  redo: Buffer[];
}
interface SourceBytes {
  bytes: Buffer;
  text: string;
  revision: string;
}

/** Guards one source-byte history per configured file. It never evaluates project code. */
export class StudioCodeStore {
  private readonly files = new Map<string, SourceFile>();
  private operation: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly root: string,
    sources: Record<string, string>,
    private readonly signal: AbortSignal,
  ) {
    for (const [id, path] of Object.entries(sources))
      this.files.set(id, { path, undo: [], redo: [] });
  }

  compositions(): string[] {
    return [...this.files.keys()];
  }

  read(compositionId: string): Promise<CodeSource> {
    return this.serialize(async () => {
      const file = this.files.get(compositionId);
      if (!file)
        return {
          enabled: false,
          compositionId,
          elements: [],
          canUndo: false,
          canRedo: false,
        };
      return this.describe(compositionId, file, await this.current(file));
    });
  }

  edit(
    compositionId: string,
    expectedRevision: unknown,
    edits: CodeEdit[],
  ): Promise<CodeSource> {
    return this.serialize(async () => {
      const file = this.requireFile(compositionId);
      const before = await this.current(file);
      this.checkRevision(before, expectedRevision);
      const text = editCodeSource(file.path, before.text, edits);
      return this.publish(
        compositionId,
        file,
        before,
        Buffer.from(text),
        "edit",
      );
    });
  }

  history(
    compositionId: string,
    expectedRevision: unknown,
    action: unknown,
  ): Promise<CodeSource> {
    return this.serialize(async () => {
      const file = this.requireFile(compositionId);
      const before = await this.current(file);
      this.checkRevision(before, expectedRevision);
      if (action !== "undo" && action !== "redo")
        throw new StudioCodeError(
          400,
          "studio.code_history",
          "Choose undo or redo",
        );
      const target = (action === "undo" ? file.undo : file.redo).at(-1);
      if (!target)
        throw new StudioCodeError(
          409,
          "studio.code_history_empty",
          `Nothing to ${action}; direct file edits clear source history`,
        );
      return this.publish(compositionId, file, before, target, action);
    });
  }

  private requireFile(id: string): SourceFile {
    const file = this.files.get(id);
    if (!file)
      throw new StudioCodeError(
        400,
        "studio.code_disabled",
        `No editable source configured for ${id}`,
      );
    return file;
  }

  private async current(file: SourceFile): Promise<SourceBytes> {
    checkCodePath(this.root, file.path);
    if ((await stat(file.path)).size > MAX_STUDIO_CODE_BYTES)
      throw new StudioCodeError(
        413,
        "studio.code_limit",
        "Editable source exceeds 1 MiB",
      );
    const bytes = await readFile(file.path);
    if (bytes.length > MAX_STUDIO_CODE_BYTES)
      throw new StudioCodeError(
        413,
        "studio.code_limit",
        "Editable source exceeds 1 MiB",
      );
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes,
      );
    } catch {
      throw new StudioCodeError(
        400,
        "studio.code_encoding",
        "Editable source must use UTF-8",
      );
    }
    const revision = createHash("sha256").update(bytes).digest("hex");
    if (file.revision !== undefined && revision !== file.revision) {
      file.undo.length = 0;
      file.redo.length = 0;
    }
    file.revision = revision;
    return { bytes, text, revision };
  }

  private describe(
    compositionId: string,
    file: SourceFile,
    source: SourceBytes,
  ): CodeSource {
    if (file.parsed?.revision !== source.revision)
      file.parsed = {
        revision: source.revision,
        elements: inspectCodeSource(file.path, source.text),
      };
    return {
      enabled: true,
      compositionId,
      path: file.path,
      revision: source.revision,
      elements: file.parsed.elements,
      canUndo: file.undo.length > 0,
      canRedo: file.redo.length > 0,
    };
  }

  private checkRevision(source: SourceBytes, expected: unknown) {
    if (source.revision !== expected)
      throw new StudioCodeError(
        409,
        "studio.code_conflict",
        "Source changed; reload it before saving edits",
      );
  }

  private async publish(
    id: string,
    file: SourceFile,
    before: SourceBytes,
    bytes: Buffer,
    action: "edit" | "undo" | "redo",
  ): Promise<CodeSource> {
    if (bytes.length > MAX_STUDIO_CODE_BYTES)
      throw new StudioCodeError(
        413,
        "studio.code_limit",
        "Editable source exceeds 1 MiB",
      );
    if (bytes.equals(before.bytes)) return this.describe(id, file, before);
    const text = bytes.toString("utf8");
    inspectCodeSource(file.path, text);
    const temporary = join(
      dirname(file.path),
      `.velocast-code-${randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporary, bytes, { flag: "wx" });
      this.checkRevision(await this.current(file), before.revision);
      this.signal.throwIfAborted();
      await rename(temporary, file.path);
      file.revision = createHash("sha256").update(bytes).digest("hex");
      if (action === "edit") {
        file.undo.push(before.bytes);
        if (file.undo.length > 50) file.undo.shift();
        file.redo.length = 0;
      } else if (action === "undo") {
        file.undo.pop();
        file.redo.push(before.bytes);
      } else {
        file.redo.pop();
        file.undo.push(before.bytes);
      }
      return this.describe(id, file, { bytes, text, revision: file.revision });
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

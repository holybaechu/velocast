import { createHash, randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, relative } from "node:path";
import type { CodeEdit, CodeElement, CodeSource } from "@velocast/core";
import {
  checkCodePath,
  sourceHistoryDirectory,
  StudioCodeError,
} from "./studio-code-config.js";
import { editCodeSource, inspectCodeSource } from "./studio-code-parser.js";

export const MAX_STUDIO_CODE_BYTES = 1024 * 1024;
interface SourceFile {
  path: string;
  directory: string;
  revision?: string;
  current?: Buffer;
  historyStamp?: string;
  parsed?: { revision: string; elements: CodeElement[]; syntaxError?: string };
  undo: Buffer[];
  redo: Buffer[];
}
interface SourceBytes {
  bytes: Buffer;
  text: string;
  revision: string;
}
type HistoryAction = "edit" | "undo" | "redo";
interface PendingEdit {
  version: 1;
  source: string;
  transaction: string;
  beforeRevision: string;
  after: string;
  action: HistoryAction;
}
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const historyStamp = (info: BigIntStats) =>
  `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
const exists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};
function decodeSnapshot(value: unknown): Buffer {
  if (typeof value !== "string") throw new Error("invalid source snapshot");
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.length > MAX_STUDIO_CODE_BYTES ||
    bytes.toString("base64") !== value
  )
    throw new Error("invalid source snapshot");
  return bytes;
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
      this.files.set(id, {
        path,
        directory: sourceHistoryDirectory(root, path),
        undo: [],
        redo: [],
      });
  }

  compositions(): string[] {
    return [...this.files.keys()];
  }

  read(compositionId: string): Promise<CodeSource> {
    const file = this.files.get(compositionId);
    if (!file)
      return Promise.resolve({
        enabled: false,
        compositionId,
        elements: [],
        canUndo: false,
        canRedo: false,
      });
    return this.withFile(compositionId, async (current) =>
      this.describe(compositionId, current, await this.current(current)),
    ).catch((error) => {
      if (
        error instanceof StudioCodeError &&
        error.code === "studio.code_recovery_required"
      )
        return this.recoveryDescriptor(compositionId, file);
      throw error;
    });
  }

  readSource(compositionId: string): Promise<CodeSource & { source?: string }> {
    return this.withFile(compositionId, async (file) => {
      const current = await this.current(file);
      return {
        ...this.describe(compositionId, file, current),
        source: current.text,
      };
    });
  }

  replace(
    compositionId: string,
    expectedRevision: unknown,
    source: string,
  ): Promise<CodeSource> {
    return this.withFile(compositionId, async (file) => {
      if (typeof source !== "string")
        throw new StudioCodeError(
          400,
          "studio.code_source",
          "Source must be UTF-8 text",
        );
      const before = await this.current(file);
      this.checkRevision(before, expectedRevision);
      return this.publish(
        compositionId,
        file,
        before,
        Buffer.from(source),
        "edit",
      );
    });
  }

  recover(
    compositionId: string,
  ): Promise<CodeSource & { recoveryAction: string }> {
    return this.serialize(async () => {
      const file = this.requireFile(compositionId);
      await this.ensureDirectory(file);
      const releaseRecovery = await this.claimLock(file, "recovery.lock");
      try {
        const owner = await this.ownerState(join(file.directory, "lock.json"));
        if (owner === "alive" || owner === "unknown")
          throw new StudioCodeError(
            409,
            "studio.code_busy",
            "A live or unidentified Studio writer still owns this source; stop it before recovery",
          );
        if (owner === "dead") await rm(join(file.directory, "lock.json"));
        const release = await this.acquire(file, true);
        try {
          await this.loadHistory(file);
          const recoveryAction = await this.finishRecovery(file);
          const current = await this.current(file);
          return {
            ...this.describe(compositionId, file, current),
            recoveryAction,
            recoveryRequired: false,
          };
        } finally {
          await release();
        }
      } finally {
        await releaseRecovery();
      }
    });
  }

  edit(
    compositionId: string,
    expectedRevision: unknown,
    edits: CodeEdit[],
  ): Promise<CodeSource> {
    return this.withFile(compositionId, async (file) => {
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
    return this.withFile(compositionId, async (file) => {
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
          `Nothing to ${action}`,
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
    await this.loadHistory(file);
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
      file.undo.push(file.current!);
      if (file.undo.length > 50) file.undo.shift();
      file.redo.length = 0;
    }
    const changed = revision !== file.revision;
    file.revision = revision;
    file.current = bytes;
    if (changed) await this.saveHistory(file);
    return { bytes, text, revision };
  }

  private async ensureDirectory(file: SourceFile): Promise<void> {
    checkCodePath(this.root, file.path, true);
    let directory = this.root;
    for (const part of relative(this.root, file.directory).split(/[\\/]/)) {
      directory = join(directory, part);
      await mkdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new StudioCodeError(
          400,
          "studio.code_history_path",
          "Source history must use regular project directories",
        );
    }
  }

  private async loadHistory(file: SourceFile): Promise<void> {
    try {
      const path = join(file.directory, "history.json");
      const info = await lstat(path, { bigint: true });
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size > BigInt(72 * 1024 * 1024)
      )
        throw new Error("invalid history file");
      const stamp = historyStamp(info);
      if (file.historyStamp === stamp) return;
      const text = await readFile(path, "utf8");
      if (Buffer.byteLength(text) > 72 * 1024 * 1024)
        throw new Error("history exceeds its size limit");
      const value = JSON.parse(text);
      if (
        value.version !== 1 ||
        value.source !== relative(this.root, file.path) ||
        !Array.isArray(value.undo) ||
        !Array.isArray(value.redo) ||
        value.undo.length + value.redo.length > 50
      )
        throw new Error("invalid history metadata");
      const bytes = decodeSnapshot(value.current);
      const revision = createHash("sha256").update(bytes).digest("hex");
      if (value.revision !== revision)
        throw new Error("history checksum mismatch");
      file.current = bytes;
      file.revision = revision;
      file.undo = value.undo.map(decodeSnapshot);
      file.redo = value.redo.map(decodeSnapshot);
      file.historyStamp = stamp;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        file.current = undefined;
        file.historyStamp = undefined;
        file.revision = undefined;
        file.undo = [];
        file.redo = [];
        return;
      }
      throw new StudioCodeError(
        409,
        "studio.code_history_invalid",
        `Cannot read source history at ${file.directory}; preserve it before repairing: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async saveHistory(file: SourceFile): Promise<void> {
    file.historyStamp = undefined;
    const temporary = join(file.directory, `${randomUUID()}.tmp`);
    try {
      await writeFile(
        temporary,
        JSON.stringify({
          version: 1,
          source: relative(this.root, file.path),
          revision: file.revision,
          current: file.current!.toString("base64"),
          undo: file.undo.map((bytes) => bytes.toString("base64")),
          redo: file.redo.map((bytes) => bytes.toString("base64")),
        }),
        { flag: "wx" },
      );
      await rename(temporary, join(file.directory, "history.json"));
      file.historyStamp = historyStamp(
        await lstat(join(file.directory, "history.json"), { bigint: true }),
      );
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private describe(
    compositionId: string,
    file: SourceFile,
    source: SourceBytes,
  ): CodeSource {
    if (file.parsed?.revision !== source.revision) {
      try {
        file.parsed = {
          revision: source.revision,
          elements: inspectCodeSource(file.path, source.text),
        };
      } catch (error) {
        if (
          !(error instanceof StudioCodeError) ||
          error.code !== "studio.code_syntax"
        )
          throw error;
        file.parsed = {
          revision: source.revision,
          elements: [],
          syntaxError: error.message,
        };
      }
    }
    return {
      enabled: true,
      compositionId,
      path: file.path,
      revision: source.revision,
      elements: file.parsed.elements,
      ...(file.parsed.syntaxError
        ? { syntaxError: file.parsed.syntaxError }
        : {}),
      canUndo: file.undo.length > 0,
      canRedo: file.redo.length > 0,
      recoveryPath: file.directory,
      recoveryRequired: false,
    };
  }

  private recoveryDescriptor(
    compositionId: string,
    file: SourceFile,
  ): CodeSource {
    return {
      enabled: true,
      compositionId,
      path: file.path,
      elements: [],
      canUndo: false,
      canRedo: false,
      recoveryPath: file.directory,
      recoveryRequired: true,
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
    action: HistoryAction,
  ): Promise<CodeSource> {
    if (bytes.length > MAX_STUDIO_CODE_BYTES)
      throw new StudioCodeError(
        413,
        "studio.code_limit",
        "Editable source exceeds 1 MiB",
      );
    if (bytes.equals(before.bytes)) return this.describe(id, file, before);
    const text = bytes.toString("utf8");
    if (action === "edit") inspectCodeSource(file.path, text);
    const transaction = randomUUID();
    const temporary = join(file.directory, `${transaction}.candidate`);
    const captured = join(file.directory, `${transaction}.source`);
    let moved = false;
    try {
      await writeFile(temporary, bytes, { flag: "wx" });
      this.checkRevision(await this.current(file), before.revision);
      this.signal.throwIfAborted();
      const pending: PendingEdit = {
        version: 1,
        source: relative(this.root, file.path),
        transaction,
        beforeRevision: before.revision,
        after: bytes.toString("base64"),
        action,
      };
      const journal = join(file.directory, `${transaction}.journal`);
      try {
        await writeFile(journal, JSON.stringify(pending), { flag: "wx" });
        await link(journal, join(file.directory, "pending.json"));
      } finally {
        await rm(journal, { force: true });
      }
      await rename(file.path, captured);
      moved = true;
      const info = await lstat(captured);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size > MAX_STUDIO_CODE_BYTES ||
        createHash("sha256")
          .update(await readFile(captured))
          .digest("hex") !== before.revision
      )
        throw new StudioCodeError(
          409,
          "studio.code_conflict",
          `Source changed during publication; captured bytes are preserved at ${captured}`,
        );
      this.signal.throwIfAborted();
      try {
        // Unlike rename(), link() never replaces a file created by another writer.
        await link(temporary, file.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new StudioCodeError(
            409,
            "studio.code_conflict",
            `Another editor saved during publication; its source is unchanged. Earlier bytes are at ${captured}`,
          );
        throw error;
      }
      this.applyHistory(file, before.bytes, bytes, action);
      await this.saveHistory(file);
      await rm(join(file.directory, "pending.json"));
      await this.pruneRecovery(file);
      return this.describe(id, file, { bytes, text, revision: digest(bytes) });
    } catch (error) {
      if (moved) {
        await link(captured, file.path).catch(
          (restoreError: NodeJS.ErrnoException) => {
            if (restoreError.code !== "EEXIST")
              throw new StudioCodeError(
                409,
                "studio.code_recovery_required",
                `Restore the retained source at ${captured}; ${restoreError.message}`,
              );
          },
        );
      }
      // If restoration succeeded, retain observed external bytes in history too.
      if (await exists(join(file.directory, "pending.json")))
        await this.finishRecovery(file);
      throw error;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private applyHistory(
    file: SourceFile,
    before: Buffer,
    after: Buffer,
    action: HistoryAction,
  ) {
    if (action === "edit") {
      file.undo.push(before);
      if (file.undo.length > 50) file.undo.shift();
      file.redo.length = 0;
    } else if (action === "undo") {
      file.undo.pop();
      file.redo.push(before);
    } else {
      file.redo.pop();
      file.undo.push(before);
    }
    file.current = after;
    file.revision = digest(after);
  }

  private async pending(file: SourceFile): Promise<PendingEdit | undefined> {
    const path = join(file.directory, "pending.json");
    try {
      const info = await lstat(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size > 2 * 1024 * 1024
      )
        throw new Error("invalid pending edit file");
      const value = JSON.parse(await readFile(path, "utf8"));
      if (
        value.version !== 1 ||
        value.source !== relative(this.root, file.path) ||
        typeof value.transaction !== "string" ||
        !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/.test(value.transaction) ||
        typeof value.beforeRevision !== "string" ||
        !/^[\da-f]{64}$/.test(value.beforeRevision) ||
        !["edit", "undo", "redo"].includes(value.action)
      )
        throw new Error("invalid pending edit metadata");
      decodeSnapshot(value.after);
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new StudioCodeError(
        409,
        "studio.code_history_invalid",
        `Cannot recover the pending edit at ${file.directory}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async finishRecovery(file: SourceFile): Promise<string> {
    const pending = await this.pending(file);
    if (!pending) return "none";
    const captured = join(file.directory, `${pending.transaction}.source`);
    let result = "kept-current-source";
    if (!(await exists(file.path))) {
      const info = await lstat(captured);
      if (!info.isFile() || info.isSymbolicLink())
        throw new StudioCodeError(
          409,
          "studio.code_recovery_required",
          `A regular retained source is required at ${captured}`,
        );
      try {
        await link(captured, file.path);
        result = "restored-source";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    checkCodePath(this.root, file.path);
    if ((await stat(file.path)).size > MAX_STUDIO_CODE_BYTES)
      throw new StudioCodeError(
        413,
        "studio.code_limit",
        "Recovered source exceeds 1 MiB; retained files were kept",
      );
    const current = await readFile(file.path);
    const after = decodeSnapshot(pending.after);
    await this.loadHistory(file);
    if (
      digest(current) === digest(after) &&
      file.revision === pending.beforeRevision
    ) {
      this.applyHistory(file, file.current!, after, pending.action);
      await this.saveHistory(file);
      result = "completed-edit";
    } else await this.current(file);
    await rm(join(file.directory, "pending.json"));
    await rm(join(file.directory, `${pending.transaction}.candidate`), {
      force: true,
    });
    await this.pruneRecovery(file);
    return result;
  }

  private async pruneRecovery(file: SourceFile) {
    const retained = await Promise.all(
      (await readdir(file.directory))
        .filter((name) => /^[\da-f-]{36}\.source$/.test(name))
        .map(async (name) => ({
          path: join(file.directory, name),
          time: (await lstat(join(file.directory, name))).mtimeMs,
        })),
    );
    retained.sort((a, b) => b.time - a.time);
    for (const item of retained.slice(50)) await rm(item.path);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private withFile<T>(
    id: string,
    operation: (file: SourceFile) => Promise<T>,
  ): Promise<T> {
    return this.serialize(async () => {
      const file = this.requireFile(id);
      await this.ensureDirectory(file);
      const release = await this.acquire(file);
      try {
        this.signal.throwIfAborted();
        if (await exists(join(file.directory, "pending.json")))
          throw new StudioCodeError(
            409,
            "studio.code_recovery_required",
            `A source edit was interrupted; recover it before continuing (${file.directory})`,
          );
        return await operation(file);
      } finally {
        await release();
      }
    });
  }

  private async acquire(
    file: SourceFile,
    recovering = false,
  ): Promise<() => Promise<void>> {
    if (!recovering && (await exists(join(file.directory, "recovery.lock"))))
      throw new StudioCodeError(
        409,
        "studio.code_busy",
        `Source recovery is in progress; if its owner stopped, preserve ${file.directory} before removing recovery.lock`,
      );
    const release = await this.claimLock(file, "lock.json");
    if (!recovering && (await exists(join(file.directory, "recovery.lock")))) {
      await release();
      throw new StudioCodeError(
        409,
        "studio.code_busy",
        "Source recovery started; retry after it finishes",
      );
    }
    return release;
  }

  private async ownerState(
    path: string,
  ): Promise<"alive" | "dead" | "absent" | "unknown"> {
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4096)
        return "unknown";
      const owner = JSON.parse(await readFile(path, "utf8"));
      if (
        !Number.isSafeInteger(owner.pid) ||
        owner.pid <= 0 ||
        typeof owner.token !== "string"
      )
        return "unknown";
      try {
        process.kill(owner.pid, 0);
        return "alive";
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH"
          ? "dead"
          : "unknown";
      }
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "absent"
        : "unknown";
    }
  }

  private async claimLock(
    file: SourceFile,
    name: string,
  ): Promise<() => Promise<void>> {
    const path = join(file.directory, name);
    const token = randomUUID();
    let handle;
    try {
      handle = await open(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (name === "lock.json" && (await this.ownerState(path)) === "dead")
        throw new StudioCodeError(
          409,
          "studio.code_recovery_required",
          `A stopped Studio writer left a lock; recover this source (${file.directory})`,
        );
      throw new StudioCodeError(
        409,
        "studio.code_busy",
        `Another Studio operation owns this source; retry after it finishes (${path})`,
      );
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
    } catch (error) {
      await handle.close();
      await rm(path, { force: true });
      throw error;
    }
    await handle.close();
    return async () => {
      const value = JSON.parse(await readFile(path, "utf8"));
      if (value.token !== token)
        throw new StudioCodeError(
          409,
          "studio.code_lock_changed",
          `Source lock changed; preserve recovery files at ${file.directory}`,
        );
      await rm(path);
    };
  }
}

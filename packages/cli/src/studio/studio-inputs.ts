import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isVideoProject, parseVideoProject } from "@velocast/core";
import { isObjectRecord } from "../internal/validation.js";

export const MAX_STUDIO_INPUT_BYTES = 1024 * 1024;

export class StudioInputsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface SavedStudioInputs {
  enabled: true;
  path: string;
  revision: string;
  inputProps: Record<string, unknown>;
}

const revision = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** One saved source and shared session history; external writers invalidate undo. */
export class StudioInputsStore {
  private currentRevision?: string;
  private operation: Promise<unknown> = Promise.resolve();
  private readonly undo: Record<string, unknown>[] = [];
  private readonly redo: Record<string, unknown>[] = [];

  constructor(
    readonly path: string | undefined,
    private readonly signal: AbortSignal,
  ) {}

  read(): Promise<SavedStudioInputs | { enabled: false }> {
    return this.serialize(() => this.readCurrent());
  }

  private async readCurrent(): Promise<SavedStudioInputs | { enabled: false }> {
    if (!this.path) return { enabled: false };
    const file = await lstat(this.path);
    if (!file.isFile())
      throw new StudioInputsError(
        400,
        "studio.invalid_inputs",
        "Saved inputs must remain a regular file",
      );
    if (file.size > MAX_STUDIO_INPUT_BYTES)
      throw new StudioInputsError(
        413,
        "studio.inputs_limit",
        "Saved inputs exceed 1 MiB",
      );
    const bytes = await readFile(this.path);
    if (bytes.length > MAX_STUDIO_INPUT_BYTES)
      throw new StudioInputsError(
        413,
        "studio.inputs_limit",
        "Saved inputs exceed 1 MiB",
      );
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
    } catch {
      throw new StudioInputsError(
        400,
        "studio.invalid_inputs",
        "Saved inputs must contain a JSON object",
      );
    }
    if (!isObjectRecord(value))
      throw new StudioInputsError(
        400,
        "studio.invalid_inputs",
        "Saved inputs must contain a JSON object",
      );
    this.validate(value);
    const hash = revision(bytes);
    if (this.currentRevision !== undefined && hash !== this.currentRevision) {
      this.undo.length = 0;
      this.redo.length = 0;
    }
    this.currentRevision = hash;
    return {
      enabled: true,
      path: this.path,
      revision: hash,
      inputProps: value,
    };
  }

  history(): Promise<{ canUndo: boolean; canRedo: boolean }> {
    return this.serialize(async () => {
      await this.readCurrent();
      return { canUndo: this.undo.length > 0, canRedo: this.redo.length > 0 };
    });
  }

  save(
    expectedRevision: unknown,
    value: unknown,
    signal = this.signal,
  ): Promise<SavedStudioInputs> {
    return this.serialize(() =>
      this.saveCurrent(expectedRevision, value, "edit", signal),
    );
  }

  private async saveCurrent(
    expectedRevision: unknown,
    value: unknown,
    action: "edit" | "undo" | "redo",
    signal = this.signal,
  ): Promise<SavedStudioInputs> {
    signal.throwIfAborted();
    const before = await this.readCurrent();
    if (!before.enabled || !this.path)
      throw new StudioInputsError(
        400,
        "studio.inputs_disabled",
        "Configure inputPropsFile to enable saved editing",
      );
    if (before.revision !== expectedRevision)
      throw new StudioInputsError(
        409,
        "studio.inputs_conflict",
        "Saved inputs changed; reload before editing again",
      );
    if (!isObjectRecord(value))
      throw new StudioInputsError(
        400,
        "studio.invalid_inputs",
        "Saved inputs must be a JSON object",
      );
    this.validate(
      value,
      action === "edit" && isVideoProject(before.inputProps),
    );
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n");
    if (bytes.length > MAX_STUDIO_INPUT_BYTES)
      throw new StudioInputsError(
        413,
        "studio.inputs_limit",
        "Saved inputs exceed 1 MiB",
      );
    if (JSON.stringify(before.inputProps) === JSON.stringify(value))
      return before;
    const temporary = join(
      dirname(this.path),
      `.velocast-inputs-${randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporary, bytes, { flag: "wx" });
      const current = await this.readCurrent();
      if (!current.enabled || current.revision !== before.revision)
        throw new StudioInputsError(
          409,
          "studio.inputs_conflict",
          "Saved inputs changed while saving; reload before editing again",
        );
      signal.throwIfAborted();
      await rename(temporary, this.path);
      this.currentRevision = revision(bytes);
      if (action === "edit") {
        this.undo.push(before.inputProps);
        if (this.undo.length > 50) this.undo.shift();
        this.redo.length = 0;
      } else if (action === "undo") {
        this.undo.pop();
        this.redo.push(before.inputProps);
      } else {
        this.redo.pop();
        this.undo.push(before.inputProps);
      }
      return {
        enabled: true,
        path: this.path,
        revision: this.currentRevision,
        inputProps: value,
      };
    } finally {
      await rm(temporary, { force: true });
    }
  }

  changeHistory(
    expectedRevision: unknown,
    action: unknown,
  ): Promise<SavedStudioInputs> {
    return this.serialize(async () => {
      const before = await this.readCurrent();
      if (!before.enabled || before.revision !== expectedRevision)
        throw new StudioInputsError(
          409,
          "studio.inputs_conflict",
          "Saved inputs changed; reload before editing again",
        );
      if (action !== "undo" && action !== "redo")
        throw new StudioInputsError(
          400,
          "studio.history_action",
          "Choose undo or redo",
        );
      const target = (action === "undo" ? this.undo : this.redo).at(-1);
      if (!target)
        throw new StudioInputsError(
          409,
          "studio.history_empty",
          `Nothing to ${action}; external edits reset session history`,
        );
      return this.saveCurrent(expectedRevision, target, action);
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private validate(value: unknown, project = false): void {
    if (!project && !isVideoProject(value)) return;
    try {
      parseVideoProject(value);
    } catch (error) {
      throw new StudioInputsError(
        400,
        "studio.invalid_project",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

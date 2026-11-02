import type {
  CodeEdit,
  CodeElement,
  CodeSource,
  CompositionManifest,
} from "@velocast/core";
import {
  Film,
  Image,
  Layers,
  Music2,
  Redo2,
  RotateCcw,
  Save,
  Type,
  Undo2,
  type IconNode,
} from "lucide";
import { icon } from "./studio-icons.js";

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface CodeEditorOptions {
  inspector: HTMLElement;
  timeline: HTMLElement;
  canvas: HTMLElement;
  media: HTMLElement;
  actions: HTMLElement;
  save(edits: CodeEdit[], revision: string): void;
  seek(frame: number): void;
  history(action: "undo" | "redo"): void;
  draft(): void;
  select(): void;
  inspect?(id: string, signal: AbortSignal): Promise<Bounds>;
}
const groups = [
  ["Content", ["name", "text", "image.src", "src"]],
  ["Timing", ["from", "durationFrames", "trimBeforeFrames"]],
  ["Transform", ["x", "y", "width", "height", "rotation", "opacity"]],
  [
    "Appearance",
    [
      "style.color",
      "style.backgroundColor",
      "style.fontSize",
      "style.borderRadius",
    ],
  ],
  ["Audio", ["gain", "muted", "fadeInFrames", "fadeOutFrames"]],
] as const;
const labels: Record<string, string> = {
  name: "Name",
  text: "Text",
  "image.src": "Image file",
  src: "Media file",
  from: "Start (frames)",
  durationFrames: "Duration (frames)",
  trimBeforeFrames: "Trim start (frames)",
  x: "X",
  y: "Y",
  width: "Width",
  height: "Height",
  rotation: "Rotation (°)",
  opacity: "Opacity",
  "style.color": "Text color",
  "style.backgroundColor": "Background",
  "style.fontSize": "Font size",
  "style.borderRadius": "Corner radius",
  gain: "Volume (×)",
  muted: "Muted",
  fadeInFrames: "Fade in (frames)",
  fadeOutFrames: "Fade out (frames)",
};
const textFields = new Set([
  "name",
  "text",
  "image.src",
  "src",
  "style.color",
  "style.backgroundColor",
]);
const lengthFields = new Set(["style.fontSize", "style.borderRadius"]);

/** Supported literal edits to an authoritative source file; arbitrary expressions remain code-owned. */
export class CodeEditor {
  private source?: CodeSource;
  private external?: CodeSource;
  private composition?: CompositionManifest;
  private selectedId?: string;
  private frame = 0;
  private busy = false;
  private displayKey = "";
  private scale = 1;
  private readonly drafts = new Map<
    string,
    { id: string; field: string; raw: string | boolean }
  >();
  private inspection?: AbortController;
  private inspectKey = "";
  private drag?: AbortController;
  private disposed = false;

  constructor(private readonly options: CodeEditorOptions) {}

  get hasDraft(): boolean {
    return this.drafts.size > 0;
  }
  get conflicted(): boolean {
    return !!this.external;
  }
  canChangeHistory(action: "undo" | "redo"): boolean {
    return (
      !this.busy &&
      !this.hasDraft &&
      !this.external &&
      !!(action === "undo" ? this.source?.canUndo : this.source?.canRedo)
    );
  }

  update(
    source: CodeSource,
    composition: CompositionManifest,
    frame: number,
    busy: boolean,
    displayKey: string,
  ): void {
    const changedComposition =
      this.source?.compositionId !== source.compositionId;
    const changed =
      this.source?.revision !== source.revision || changedComposition;
    if (changed || this.displayKey !== displayKey || this.frame !== frame)
      this.drag?.abort();
    this.composition = composition;
    this.frame = frame;
    this.busy = busy;
    this.displayKey = displayKey;
    if (changed && this.hasDraft && !changedComposition) this.external = source;
    else if (changed) this.accept(source);
    else this.source = source;
    this.renderStatus();
    this.disable();
    for (const head of this.options.timeline.querySelectorAll<HTMLElement>(
      ".track-playhead",
    ))
      head.style.left = `${(100 * frame) / composition.durationFrames}%`;
    void this.inspectCanvas();
  }

  accept(source: CodeSource): void {
    this.source = source;
    this.external = undefined;
    this.drafts.clear();
    if (!source.elements.some((element) => element.id === this.selectedId))
      this.selectedId =
        source.elements.find((element) => element.kind === "layer")?.id ??
        source.elements[0]?.id;
    this.render();
  }

  fit(
    width: number,
    height: number,
    scale: number,
    left: number,
    top: number,
  ): void {
    this.scale = scale;
    Object.assign(this.options.canvas.style, {
      width: `${width}px`,
      height: `${height}px`,
      left: `${left}px`,
      top: `${top}px`,
      transform: `scale(${scale})`,
      transformOrigin: "top left",
    });
  }

  dispose(): void {
    this.disposed = true;
    this.inspection?.abort();
    this.drag?.abort();
  }

  private node<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className = "",
    text?: string,
  ): HTMLElementTagNameMap[K] {
    const node = this.options.inspector.ownerDocument.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  private button(
    label: string,
    glyph: IconNode,
    action: () => void,
    compact = false,
  ): HTMLButtonElement {
    const button = this.node("button");
    button.type = "button";
    button.innerHTML = icon(glyph);
    button.title = label;
    button.setAttribute("aria-label", label);
    if (!compact) button.append(this.node("span", "", label));
    button.addEventListener("click", action);
    return button;
  }
  private select(id: string, seek = false): void {
    this.selectedId = id;
    this.options.select();
    if (seek) {
      const timing = this.timing(
        this.source!.elements.find((element) => element.id === id)!,
      );
      if (timing)
        this.options.seek(
          Math.max(
            0,
            Math.min(this.composition!.durationFrames - 1, timing.start),
          ),
        );
    }
    this.renderInspector();
    this.renderTimeline();
    this.inspectKey = "";
    void this.inspectCanvas();
    this.disable();
  }

  private render(): void {
    const undo = this.button(
      "Undo source edit",
      Undo2,
      () => this.options.history("undo"),
      true,
    );
    const redo = this.button(
      "Redo source edit",
      Redo2,
      () => this.options.history("redo"),
      true,
    );
    undo.dataset.codeHistory = "undo";
    redo.dataset.codeHistory = "redo";
    this.options.actions.replaceChildren(undo, redo);
    this.options.media.replaceChildren(
      this.node("div", "panel-heading", "Source"),
      this.sourceLocation("code-source-path"),
      this.node(
        "p",
        "help-text code-source-help",
        "Keep media in public/assets. Select an image, video, or audio layer to change its file path. Add layers and custom animation in your source editor.",
      ),
    );
    this.renderInspector();
    this.renderTimeline();
    this.inspectKey = "";
  }

  private sourceLocation(
    className: string,
    line?: number,
  ): HTMLParagraphElement {
    const path = this.source?.path ?? "";
    const suffix = line === undefined ? "" : `:${line}`;
    const label = this.node(
      "p",
      className,
      `${path.split(/[\\/]/).pop()}${suffix}`,
    );
    label.title = `${path}${suffix}`;
    return label;
  }

  private renderInspector(): void {
    const element = this.source?.elements.find(
      (item) => item.id === this.selectedId,
    );
    this.options.inspector.replaceChildren();
    const toolbar = this.node("div", "code-edit-actions");
    const save = this.button("Save changes", Save, () => this.save());
    save.className = "primary";
    save.dataset.codeSave = "";
    const discard = this.button("Discard", RotateCcw, () => {
      this.accept(this.external ?? this.source!);
      this.options.draft();
      this.disable();
    });
    discard.dataset.codeDiscard = "";
    toolbar.append(save, discard);
    const status = this.node("p", "inputs-status");
    status.dataset.codeDraftStatus = "";
    status.setAttribute("role", "status");
    this.options.inspector.append(
      this.node("h2", "", element?.name ?? "Source composition"),
      this.sourceLocation("code-source-location", element?.line),
      toolbar,
      status,
    );
    if (!element)
      this.options.inspector.append(
        this.node(
          "p",
          "help-text",
          "No editable layers found. Add a Layer with a stable id in this composition's source file.",
        ),
      );
    else
      for (const [heading, fields] of groups) {
        const visible = fields.filter((field) => element.fields[field]);
        if (!visible.length) continue;
        this.options.inspector.append(
          this.node("h3", "property-section", heading),
        );
        for (const field of visible) this.field(element, field);
      }
    this.renderStatus();
  }

  private field(element: CodeElement, name: string): void {
    const field = element.fields[name]!;
    const label = this.node("label", "project-field code-field");
    label.append(this.node("span", "", labels[name] ?? name));
    if (!field.editable) {
      label.append(
        this.node(
          "span",
          "code-readonly",
          field.value === undefined ? "Code" : String(field.value),
        ),
      );
      const reason = this.node(
        "small",
        "code-field-reason",
        field.reason ?? "This value is controlled by source code.",
      );
      label.append(reason);
    } else {
      const input =
        name === "text" ? this.node("textarea") : this.node("input");
      const draft = this.drafts.get(`${element.id}:${name}`);
      input.dataset.codeField = name;
      if (input.tagName === "INPUT") {
        const control = input as HTMLInputElement;
        control.type =
          name === "muted"
            ? "checkbox"
            : textFields.has(name) || lengthFields.has(name)
              ? "text"
              : "number";
        control.step = [
          "from",
          "durationFrames",
          "trimBeforeFrames",
          "fadeInFrames",
          "fadeOutFrames",
        ].includes(name)
          ? "1"
          : "any";
        if (name === "muted")
          control.checked = Boolean(draft?.raw ?? field.value ?? false);
      }
      input.value = String(draft?.raw ?? field.value ?? "");
      input.placeholder =
        field.value === undefined
          ? name === "durationFrames"
            ? "Remaining duration"
            : "Auto"
          : "";
      input.addEventListener("input", () => {
        const raw =
          name === "muted" ? (input as HTMLInputElement).checked : input.value;
        const initial =
          name === "muted"
            ? Boolean(field.value ?? false)
            : String(field.value ?? "");
        if (raw === initial) this.drafts.delete(`${element.id}:${name}`);
        else
          this.drafts.set(`${element.id}:${name}`, {
            id: element.id,
            field: name,
            raw,
          });
        this.renderStatus();
        this.disable();
        this.options.draft();
      });
      label.append(input);
    }
    this.options.inspector.append(label);
  }

  private save(): void {
    if (!this.source?.revision || !this.hasDraft || this.busy || this.external)
      return;
    const edits: CodeEdit[] = [];
    for (const draft of this.drafts.values()) {
      const value =
        typeof draft.raw === "boolean" || textFields.has(draft.field)
          ? draft.raw
          : lengthFields.has(draft.field) &&
              !/^\d+(?:\.\d+)?$/.test(draft.raw.trim())
            ? draft.raw
            : draft.raw.trim()
              ? Number(draft.raw)
              : NaN;
      if (typeof value === "number" && !Number.isFinite(value)) {
        const status = this.options.inspector.querySelector<HTMLElement>(
          "[data-code-draft-status]",
        )!;
        status.textContent = `Enter a valid number for ${labels[draft.field] ?? draft.field}.`;
        status.setAttribute("role", "alert");
        return;
      }
      edits.push({ id: draft.id, field: draft.field, value });
    }
    this.options.save(edits, this.source.revision);
  }

  private renderStatus(): void {
    const status = this.options.inspector.querySelector<HTMLElement>(
      "[data-code-draft-status]",
    );
    if (status) {
      status.textContent = this.external
        ? "Source changed in another editor. Your draft is kept; reload the saved source to continue."
        : this.hasDraft
          ? "Unsaved changes"
          : "Select a layer to edit supported values.";
      status.setAttribute("role", "status");
    }
    const discard = this.options.inspector.querySelector<HTMLButtonElement>(
      "[data-code-discard]",
    );
    if (discard) {
      discard.innerHTML = `${icon(RotateCcw)} ${this.external ? "Reload saved" : "Discard"}`;
      discard.hidden = !this.hasDraft && !this.external;
    }
    const save =
      this.options.inspector.querySelector<HTMLButtonElement>(
        "[data-code-save]",
      );
    if (save) save.hidden = !this.hasDraft;
  }

  private timing(
    element: CodeElement,
  ): { start: number; duration: number } | undefined {
    const start = element.fields.from?.value;
    const duration = element.fields.durationFrames?.value;
    if (
      typeof start !== "number" ||
      (duration !== undefined && typeof duration !== "number") ||
      !element.fields.from?.editable ||
      (element.fields.durationFrames && !element.fields.durationFrames.editable)
    )
      return undefined;
    return {
      start,
      duration:
        typeof duration === "number"
          ? duration
          : Math.max(0, this.composition!.durationFrames - start),
    };
  }

  private renderTimeline(): void {
    const tracks = this.node("div", "project-tracks");
    const toolbar = this.node("div", "project-toolbar");
    toolbar.append(
      this.node("span", "", "Layers"),
      this.node("span", "timeline-hint", "Timing is edited in Properties"),
    );
    for (const element of this.source?.elements ?? []) {
      const glyph =
        element.kind === "audio"
          ? Music2
          : element.kind === "video"
            ? Film
            : element.fields["image.src"]
              ? Image
              : typeof element.fields.text?.value === "string"
                ? Type
                : Layers;
      const row = this.node("div", "project-track layer-track");
      const label = this.button(element.name, glyph, () =>
        this.select(element.id, true),
      );
      label.className = "track-label";
      label.dataset.codeId = element.id;
      label.setAttribute(
        "aria-pressed",
        String(this.selectedId === element.id),
      );
      const lane = this.node("div", "track-lane");
      const timing = this.timing(element);
      if (timing) {
        const clip = this.button(element.name, glyph, () =>
          this.select(element.id, true),
        );
        clip.className = "track-clip";
        clip.setAttribute(
          "aria-pressed",
          String(this.selectedId === element.id),
        );
        const start = Math.max(0, timing.start),
          end = Math.min(
            this.composition!.durationFrames,
            timing.start + timing.duration,
          );
        clip.style.left = `${(100 * start) / this.composition!.durationFrames}%`;
        clip.style.width = `${(100 * Math.max(0, end - start)) / this.composition!.durationFrames}%`;
        clip.title = `${element.name}: frames ${timing.start}–${timing.start + timing.duration - 1}`;
        lane.append(clip);
      } else
        lane.append(
          this.node("span", "code-timing-note", "Timing controlled by code"),
        );
      const head = this.node("div", "track-playhead");
      head.style.left = `${(100 * this.frame) / this.composition!.durationFrames}%`;
      lane.append(head);
      row.append(label, lane);
      tracks.append(row);
    }
    this.options.timeline.replaceChildren(toolbar, tracks);
  }

  private disable(): void {
    for (const container of [
      this.options.inspector,
      this.options.actions,
      this.options.timeline,
    ])
      for (const control of container.querySelectorAll<
        HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement
      >("input,button,textarea")) {
        const history = control.dataset.codeHistory;
        control.disabled =
          this.busy ||
          (history
            ? !this.canChangeHistory(history as "undo" | "redo")
            : control.hasAttribute("data-code-save")
              ? !!this.external || !this.hasDraft
              : false);
      }
  }

  private async inspectCanvas(): Promise<void> {
    if (!this.options.inspect || !this.source || !this.composition) return;
    const key = `${this.displayKey}:${this.frame}:${this.selectedId}:${this.busy}:${this.source.revision}`;
    if (key === this.inspectKey) return;
    this.inspectKey = key;
    this.inspection?.abort();
    this.options.canvas.replaceChildren();
    if (this.busy || this.disposed) return;
    const operation = new AbortController();
    this.inspection = operation;
    const layers = this.source.elements.filter(
      (element) => element.kind === "layer",
    );
    const results = await Promise.allSettled(
      layers.map((element) =>
        this.options.inspect!(element.id, operation.signal),
      ),
    );
    if (operation.signal.aborted || this.disposed || key !== this.inspectKey)
      return;
    for (const [index, result] of results.entries()) {
      if (
        result.status !== "fulfilled" ||
        result.value.width <= 0 ||
        result.value.height <= 0
      )
        continue;
      const element = layers[index]!,
        bounds = result.value;
      const button = this.node("button", "canvas-layer");
      button.type = "button";
      button.dataset.codeId = element.id;
      button.setAttribute("aria-label", `Select ${element.name}`);
      button.setAttribute(
        "aria-pressed",
        String(element.id === this.selectedId),
      );
      Object.assign(button.style, {
        left: `${bounds.x}px`,
        top: `${bounds.y}px`,
        width: `${bounds.width}px`,
        height: `${bounds.height}px`,
      });
      const movable =
        element.fields.x?.editable &&
        element.fields.y?.editable &&
        typeof element.fields.x.value === "number" &&
        typeof element.fields.y.value === "number";
      button.style.cursor = movable ? "move" : "pointer";
      button.addEventListener("click", () => this.select(element.id));
      if (movable)
        button.addEventListener("pointerdown", (event) =>
          this.move(event, button, element, bounds),
        );
      this.options.canvas.append(button);
    }
  }

  private move(
    event: PointerEvent,
    hit: HTMLElement,
    element: CodeElement,
    bounds: Bounds,
  ): void {
    if (this.busy || this.external || event.button !== 0) return;
    event.preventDefault();
    this.drag?.abort();
    const operation = new AbortController();
    this.drag = operation;
    const startX = event.clientX,
      startY = event.clientY;
    let dx = 0,
      dy = 0;
    const view = hit.ownerDocument.defaultView!;
    view.addEventListener(
      "pointermove",
      (next) => {
        dx = Math.round((next.clientX - startX) / this.scale);
        dy = Math.round((next.clientY - startY) / this.scale);
        hit.style.left = `${bounds.x + dx}px`;
        hit.style.top = `${bounds.y + dy}px`;
      },
      { signal: operation.signal },
    );
    view.addEventListener(
      "pointerup",
      () => {
        operation.abort();
        if (dx || dy) {
          for (const [field, delta] of [
            ["x", dx],
            ["y", dy],
          ] as const)
            this.drafts.set(`${element.id}:${field}`, {
              id: element.id,
              field,
              raw: String(Number(element.fields[field]!.value) + delta),
            });
          this.options.draft();
        }
        this.select(element.id);
      },
      { once: true, signal: operation.signal },
    );
    view.addEventListener(
      "pointercancel",
      () => {
        operation.abort();
        this.inspectKey = "";
        void this.inspectCanvas();
      },
      { once: true, signal: operation.signal },
    );
  }
}

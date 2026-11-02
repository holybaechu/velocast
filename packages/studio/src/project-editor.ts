import {
  getProjectLayerRange,
  parseVideoProject,
  type ProjectComposition,
  type ProjectAsset,
  type ProjectLayer,
  type ProjectScene,
  type VideoProject,
} from "@velocast/core";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Film,
  Image,
  Music2,
  Plus,
  Redo2,
  Square,
  Trash2,
  Type,
  Undo2,
  Upload,
  type IconNode,
} from "lucide";
import { icon } from "./studio-icons.js";

interface ProjectEditorOptions {
  inspector: HTMLElement;
  timeline: HTMLElement;
  canvas: HTMLElement;
  media: HTMLElement;
  actions: HTMLElement;
  change(project: VideoProject): void;
  seek(frame: number): void;
  history(action: "undo" | "redo"): void;
  importAsset(file: File): void;
  select?(): void;
  draft?(): void;
}

type Selection = { kind: "composition" | "scene" | "layer"; id: string };

/** An editor for the persisted project document. Selection and playhead are session state. */
export class ProjectEditor {
  private project?: VideoProject;
  private composition?: ProjectComposition;
  private selection: Selection = { kind: "composition", id: "" };
  private frame = 0;
  private busy = false;
  private fingerprint = "";
  private canvasFingerprint = "";
  private scale = 1;
  private history = { canUndo: false, canRedo: false };
  private drag?: AbortController;
  private readonly fieldDrafts = new Map<
    HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    string
  >();

  constructor(private readonly options: ProjectEditorOptions) {}

  update(
    project: VideoProject,
    compositionId: string,
    frame: number,
    busy: boolean,
  ): void {
    const fingerprint =
      project === this.project ? this.fingerprint : JSON.stringify(project);
    const compositionChanged = compositionId !== this.composition?.id;
    const changed = fingerprint !== this.fingerprint || compositionChanged;
    const busyChanged = busy !== this.busy;
    if (changed) {
      this.drag?.abort();
      this.drag = undefined;
      this.canvasFingerprint = "";
    }
    this.project = project;
    this.composition = project.compositions.find(
      (item) => item.id === compositionId,
    );
    this.frame = frame;
    this.busy = busy;
    this.fingerprint = fingerprint;
    if (changed) {
      if (compositionChanged || !this.selected())
        this.selection = { kind: "composition", id: compositionId };
      this.render();
    }
    this.renderCanvas();
    this.renderPlayhead();
    if (changed || busyChanged) this.disableControls();
  }

  setHistory(history: { canUndo: boolean; canRedo: boolean }): void {
    this.history = history;
    this.disableControls();
  }

  get hasDraft(): boolean {
    return [...this.fieldDrafts].some(
      ([field, original]) => field.value !== original,
    );
  }

  discardDraft(): void {
    this.fingerprint = "";
    this.fieldDrafts.clear();
  }

  canChangeHistory(action: "undo" | "redo"): boolean {
    return (
      !this.busy &&
      (action === "undo" ? this.history.canUndo : this.history.canRedo)
    );
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
    this.drag?.abort();
  }

  private element<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className = "",
    text?: string,
  ): HTMLElementTagNameMap[K] {
    const element = this.options.inspector.ownerDocument.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  private button(
    label: string,
    glyph: IconNode,
    action: () => void,
    compact = false,
  ): HTMLButtonElement {
    const button = this.element("button");
    button.type = "button";
    button.innerHTML = icon(glyph);
    button.title = label;
    button.setAttribute("aria-label", label);
    if (!compact) button.append(this.element("span", "", label));
    button.addEventListener("click", action);
    return button;
  }

  private selected():
    ProjectComposition | ProjectScene | ProjectLayer | undefined {
    return this.selection.kind === "layer"
      ? this.composition?.layers.find((layer) => layer.id === this.selection.id)
      : this.selection.kind === "scene"
        ? this.composition?.scenes.find(
            (scene) => scene.id === this.selection.id,
          )
        : this.composition;
  }

  private render(): void {
    this.renderActions();
    this.renderTimeline();
    this.renderMedia();
    this.renderInspector();
    this.renderCanvas();
  }

  private select(selection: Selection, seek?: number): void {
    this.selection = selection;
    this.options.select?.();
    if (seek !== undefined) this.options.seek(seek);
    this.renderInspector();
    this.renderTimeline();
    this.renderCanvas();
    this.disableControls();
  }

  private renderActions(): void {
    const undo = this.button(
      "Undo",
      Undo2,
      () => this.options.history("undo"),
      true,
    );
    const redo = this.button(
      "Redo",
      Redo2,
      () => this.options.history("redo"),
      true,
    );
    undo.dataset.history = "undo";
    redo.dataset.history = "redo";
    this.options.actions.replaceChildren(undo, redo);
  }

  private renderTimeline(): void {
    this.options.timeline.replaceChildren();
    const composition = this.composition;
    if (!composition) return;
    const toolbar = this.element("div", "project-toolbar");
    toolbar.append(
      this.button("Scene", Plus, () => this.addScene()),
      this.button("Text", Type, () => this.addLayer("text")),
      this.button("Shape", Square, () => this.addLayer("shape")),
    );
    const hint = this.element(
      "span",
      "timeline-hint",
      "Drag to move · edges to trim",
    );
    toolbar.append(hint);
    const tracks = this.element("div", "project-tracks");
    const rulerRow = this.element("div", "project-track ruler-row");
    rulerRow.append(
      this.button("Composition", Film, () =>
        this.select({ kind: "composition", id: composition.id }),
      ),
    );
    const ruler = this.element("div", "track-ruler");
    for (let index = 0; index <= 5; index++) {
      const tick = this.element(
        "span",
        "",
        `${(((composition.durationFrames / composition.fps) * index) / 5).toFixed(1)}s`,
      );
      tick.style.left = `${index * 20}%`;
      ruler.append(tick);
    }
    ruler.addEventListener("click", (event) => {
      const bounds = ruler.getBoundingClientRect();
      if (bounds.width)
        this.options.seek(
          Math.min(
            composition.durationFrames - 1,
            Math.max(
              0,
              Math.floor(
                ((event.clientX - bounds.left) / bounds.width) *
                  composition.durationFrames,
              ),
            ),
          ),
        );
    });
    rulerRow.append(ruler);
    tracks.append(rulerRow);
    for (const scene of composition.scenes)
      this.appendTrack(
        tracks,
        scene,
        "scene",
        scene.from,
        scene.durationFrames,
        Film,
      );
    for (const layer of composition.layers) {
      const range = getProjectLayerRange(composition, layer);
      this.appendTrack(
        tracks,
        layer,
        "layer",
        range.start,
        layer.durationFrames,
        this.layerIcon(layer.kind),
      );
    }
    if (!composition.scenes.length && !composition.layers.length)
      tracks.append(
        this.element(
          "p",
          "help-text timeline-empty",
          "Add a scene, text, shape, or media to begin.",
        ),
      );
    this.options.timeline.append(toolbar, tracks);
    this.renderPlayhead();
  }

  private appendTrack(
    container: HTMLElement,
    item: ProjectScene | ProjectLayer,
    kind: "scene" | "layer",
    start: number,
    duration: number,
    glyph: IconNode,
  ): void {
    const row = this.element("div", `project-track ${kind}-track`);
    const select = () => this.select({ kind, id: item.id }, start);
    const label = this.button(item.name, glyph, select);
    label.className = "track-label";
    label.dataset[kind === "layer" ? "layerId" : "sceneId"] = item.id;
    label.setAttribute(
      "aria-pressed",
      String(this.selection.kind === kind && this.selection.id === item.id),
    );
    const lane = this.element("div", "track-lane");
    const clip = this.button(
      `${item.name}: frames ${start}–${start + duration - 1}`,
      glyph,
      select,
    );
    clip.className = "track-clip";
    clip.style.left = `${(100 * start) / this.composition!.durationFrames}%`;
    clip.style.width = `${(100 * duration) / this.composition!.durationFrames}%`;
    clip.setAttribute("aria-pressed", label.getAttribute("aria-pressed")!);
    const caption = clip.querySelector("span");
    if (caption) caption.textContent = item.name;
    for (const edge of ["start", "end"] as const) {
      const handle = this.element("span", `trim-handle trim-${edge}`);
      handle.setAttribute("aria-hidden", "true");
      handle.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
        this.dragTiming(event, lane, item, kind, edge);
      });
      clip.append(handle);
    }
    clip.addEventListener("pointerdown", (event) =>
      this.dragTiming(event, lane, item, kind, "move"),
    );
    lane.append(clip, this.element("div", "track-playhead"));
    row.append(label, lane);
    container.append(row);
  }

  private renderPlayhead(): void {
    const percent =
      (100 * this.frame) / (this.composition?.durationFrames ?? 1);
    for (const head of this.options.timeline.querySelectorAll<HTMLElement>(
      ".track-playhead",
    ))
      head.style.left = `${percent}%`;
  }

  private renderMedia(): void {
    const heading = this.element("div", "panel-heading", "Media");
    const input = this.element("input");
    input.type = "file";
    input.accept =
      "image/png,image/jpeg,image/webp,image/gif,image/svg+xml,video/mp4,video/webm,video/quicktime,audio/wav,audio/mpeg,audio/mp4,audio/ogg,audio/flac";
    input.hidden = true;
    input.dataset.importMedia = "";
    input.setAttribute("aria-label", "Import media");
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file) this.options.importAsset(file);
      input.value = "";
    });
    heading.append(
      this.button("Import media", Upload, () => input.click(), true),
    );
    const list = this.element("div", "media-list");
    for (const asset of this.project?.assets ?? []) {
      const button = this.button(asset.name, this.layerIcon(asset.kind), () =>
        this.addLayer(asset.kind, asset),
      );
      button.className = "media-item";
      button.title = `Add ${asset.name} to composition`;
      button.dataset.assetId = asset.id;
      list.append(button);
    }
    if (!this.project?.assets.length)
      list.append(
        this.element(
          "p",
          "help-text",
          "Import images, video, or audio. Select media to add it to the composition.",
        ),
      );
    this.options.media.replaceChildren(heading, input, list);
  }

  private renderInspector(): void {
    this.options.inspector.replaceChildren();
    this.fieldDrafts.clear();
    const selected = this.selected();
    if (!selected) return;
    const title = this.element("div", "selection-heading");
    title.append(
      this.element(
        "h2",
        "",
        this.selection.kind === "composition"
          ? "Composition"
          : this.selection.kind === "scene"
            ? "Scene"
            : "Layer",
      ),
    );
    if (this.selection.kind !== "composition") {
      title.append(
        this.button("Duplicate", Copy, () => this.duplicate(), true),
        this.button("Delete", Trash2, () => this.remove(), true),
      );
    }
    this.options.inspector.append(title);
    this.field("Name", "name", selected.name);
    if (this.selection.kind === "composition") {
      const composition = selected as ProjectComposition;
      this.section("Format");
      this.field("Width", "width", composition.width, "number", 1);
      this.field("Height", "height", composition.height, "number", 1);
      this.field("Frames per second", "fps", composition.fps, "number", 1);
      this.field(
        "Duration (frames)",
        "durationFrames",
        composition.durationFrames,
        "number",
        1,
      );
      this.field("Background", "background", composition.background, "color");
    } else {
      this.section("Timing");
      if (this.selection.kind === "layer") {
        const layer = selected as ProjectLayer;
        this.selectField("Scene", "sceneId", layer.sceneId ?? "", [
          { value: "", label: "Whole composition" },
          ...this.composition!.scenes.map((scene) => ({
            value: scene.id,
            label: scene.name,
          })),
        ]);
      }
      this.field(
        "Start (frames)",
        "from",
        (selected as ProjectLayer).from,
        "number",
        0,
      );
      this.field(
        "Duration (frames)",
        "durationFrames",
        selected.durationFrames,
        "number",
        1,
      );
      if (this.selection.kind === "scene")
        this.field(
          "Background",
          "background",
          (selected as ProjectScene).background,
          "color",
        );
      else this.layerFields(selected as ProjectLayer);
    }
    const error = this.element("p", "project-field-error");
    error.setAttribute("role", "alert");
    error.hidden = true;
    this.options.inspector.append(error);
  }

  private layerFields(layer: ProjectLayer): void {
    if (layer.kind === "text") {
      this.section("Text");
      this.field("Content", "text", layer.text ?? "", "textarea");
      this.field("Font", "fontFamily", layer.fontFamily ?? "sans-serif");
      this.field("Font size", "fontSize", layer.fontSize ?? 48, "number", 1);
      this.field("Color", "color", layer.color ?? "#ffffff", "color");
    }
    if (layer.kind === "shape")
      this.field("Fill", "color", layer.color ?? "#ffffff", "color");
    if (["image", "video", "audio"].includes(layer.kind)) {
      this.section("Media");
      this.selectField(
        "File",
        "assetId",
        layer.assetId ?? "",
        this.project!.assets.filter((asset) => asset.kind === layer.kind).map(
          (asset) => ({ value: asset.id, label: asset.name }),
        ),
      );
      if (layer.kind !== "audio")
        this.selectField("Fit", "fit", layer.fit ?? "contain", [
          { value: "contain", label: "Contain" },
          { value: "cover", label: "Cover" },
        ]);
    }
    if (layer.kind !== "audio") {
      this.section("Transform");
      for (const [label, key] of [
        ["X", "x"],
        ["Y", "y"],
        ["Width", "width"],
        ["Height", "height"],
        ["Rotation (°)", "rotation"],
        ["Opacity", "opacity"],
      ] as const)
        this.field(
          label,
          key,
          layer[key],
          "number",
          key === "opacity"
            ? 0
            : key === "width" || key === "height"
              ? 1
              : undefined,
          key === "opacity" ? 1 : undefined,
          key === "opacity" ? "0.05" : "any",
        );
      const order = this.element("div", "layer-order");
      order.append(
        this.button("Backward", ArrowDown, () => this.reorder(-1)),
        this.button("Forward", ArrowUp, () => this.reorder(1)),
      );
      this.options.inspector.append(order);
    }
    if (layer.kind === "audio" || layer.kind === "video") {
      const hasAudio =
        layer.kind === "audio" ||
        this.project!.assets.find((asset) => asset.id === layer.assetId)
          ?.hasAudio === true;
      this.section(hasAudio ? "Audio & trim" : "Trim");
      if (hasAudio)
        this.field(
          "Volume (×)",
          "gain",
          layer.gain ?? 1,
          "number",
          0,
          undefined,
          "0.05",
        );
      this.field(
        "Trim start (frames)",
        "trimBeforeFrames",
        layer.trimBeforeFrames ?? 0,
        "number",
        0,
      );
    }
    this.section("Fades");
    this.field(
      "Fade in (frames)",
      "fadeInFrames",
      layer.fadeInFrames ?? 0,
      "number",
      0,
    );
    this.field(
      "Fade out (frames)",
      "fadeOutFrames",
      layer.fadeOutFrames ?? 0,
      "number",
      0,
    );
  }

  private section(title: string): void {
    this.options.inspector.append(
      this.element("h3", "property-section", title),
    );
  }

  private field(
    label: string,
    key: string,
    value: string | number,
    type = "text",
    min?: number,
    max?: number,
    step = "1",
  ): void {
    const wrapper = this.element("label", "project-field");
    wrapper.append(this.element("span", "", label));
    const input =
      type === "textarea" ? this.element("textarea") : this.element("input");
    input.dataset.field = key;
    input.value = String(value);
    this.fieldDrafts.set(input, input.value);
    if (input.tagName === "INPUT") {
      const field = input as HTMLInputElement;
      // Text preserves valid CSS colors which cannot be represented by a native color input.
      field.type =
        type === "color" && !/^#[\da-f]{6}$/i.test(String(value))
          ? "text"
          : type;
      if (min !== undefined) field.min = String(min);
      if (max !== undefined) field.max = String(max);
      field.step = step;
    }
    input.addEventListener("change", () =>
      this.editProperty(
        key,
        type === "number"
          ? input.value.trim()
            ? Number(input.value)
            : NaN
          : input.value,
        input,
      ),
    );
    input.addEventListener("input", () => this.options.draft?.());
    wrapper.append(input);
    this.options.inspector.append(wrapper);
  }

  private selectField(
    label: string,
    key: string,
    value: string,
    items: { value: string; label: string }[],
  ): void {
    const wrapper = this.element("label", "project-field");
    wrapper.append(this.element("span", "", label));
    const select = this.element("select");
    select.dataset.field = key;
    for (const item of items) {
      const option = this.element("option", "", item.label);
      option.value = item.value;
      select.append(option);
    }
    select.value = value;
    this.fieldDrafts.set(select, select.value);
    select.addEventListener("change", () =>
      this.editProperty(key, select.value, select),
    );
    wrapper.append(select);
    this.options.inspector.append(wrapper);
  }

  private editProperty(key: string, value: unknown, input: HTMLElement): void {
    const success = this.commit((composition) => {
      const selected =
        this.selection.kind === "layer"
          ? composition.layers.find((layer) => layer.id === this.selection.id)!
          : this.selection.kind === "scene"
            ? composition.scenes.find(
                (scene) => scene.id === this.selection.id,
              )!
            : composition;
      const target = selected as unknown as Record<string, unknown>;
      if (key === "sceneId" && !value) delete target[key];
      else target[key] = value;
    });
    input.setAttribute("aria-invalid", String(!success));
  }

  private commit(
    edit: (composition: ProjectComposition, project: VideoProject) => void,
  ): boolean {
    if (this.busy || !this.project || !this.composition) return false;
    try {
      const next = structuredClone(this.project);
      edit(
        next.compositions.find((item) => item.id === this.composition!.id)!,
        next,
      );
      const validated = parseVideoProject(next);
      this.options.change(validated);
      return true;
    } catch (error) {
      const message =
        this.options.inspector.querySelector<HTMLElement>('[role="alert"]');
      if (message) {
        message.hidden = false;
        message.textContent =
          error instanceof Error ? error.message : String(error);
      }
      return false;
    }
  }

  private renderCanvas(): void {
    const composition = this.composition;
    if (!composition) {
      this.options.canvas.replaceChildren();
      return;
    }
    const layers = composition.layers.filter((layer) => {
      const range = getProjectLayerRange(composition, layer);
      return (
        layer.kind !== "audio" &&
        range.start <= this.frame &&
        this.frame < range.end
      );
    });
    const fingerprint = JSON.stringify([layers, this.selection, this.busy]);
    if (fingerprint === this.canvasFingerprint) return;
    this.canvasFingerprint = fingerprint;
    this.options.canvas.replaceChildren();
    for (const layer of layers) {
      const hit = this.element("button", "canvas-layer");
      hit.type = "button";
      hit.dataset.layerId = layer.id;
      hit.setAttribute("aria-label", `Select ${layer.name}`);
      hit.setAttribute(
        "aria-pressed",
        String(
          this.selection.kind === "layer" && this.selection.id === layer.id,
        ),
      );
      hit.disabled = this.busy;
      Object.assign(hit.style, {
        left: `${layer.x}px`,
        top: `${layer.y}px`,
        width: `${layer.width}px`,
        height: `${layer.height}px`,
        transform: `rotate(${layer.rotation}deg)`,
      });
      hit.addEventListener("click", () =>
        this.select({ kind: "layer", id: layer.id }),
      );
      hit.addEventListener("pointerdown", (event) =>
        this.dragLayer(event, hit, layer),
      );
      this.options.canvas.append(hit);
    }
  }

  private pointerGesture(
    event: PointerEvent,
    move: (event: PointerEvent) => void,
    finish: () => void,
  ): void {
    if (this.busy || event.button !== 0) return;
    event.preventDefault();
    this.drag?.abort();
    const abort = new AbortController();
    this.drag = abort;
    const view = this.options.canvas.ownerDocument.defaultView!;
    view.addEventListener("pointermove", move, { signal: abort.signal });
    view.addEventListener(
      "pointerup",
      () => {
        abort.abort();
        finish();
      },
      { once: true, signal: abort.signal },
    );
    view.addEventListener(
      "pointercancel",
      () => {
        abort.abort();
        this.canvasFingerprint = "";
        this.renderCanvas();
        this.renderTimeline();
      },
      { once: true, signal: abort.signal },
    );
  }

  private dragLayer(
    event: PointerEvent,
    hit: HTMLElement,
    layer: ProjectLayer,
  ): void {
    if (this.busy) return;
    const startX = event.clientX,
      startY = event.clientY;
    let x = layer.x,
      y = layer.y,
      moved = false;
    this.selection = { kind: "layer", id: layer.id };
    this.options.select?.();
    this.renderInspector();
    hit.setAttribute("aria-pressed", "true");
    this.pointerGesture(
      event,
      (next) => {
        moved =
          moved ||
          Math.abs(next.clientX - startX) + Math.abs(next.clientY - startY) > 2;
        x = Math.round(layer.x + (next.clientX - startX) / this.scale);
        y = Math.round(layer.y + (next.clientY - startY) / this.scale);
        hit.style.left = `${x}px`;
        hit.style.top = `${y}px`;
      },
      () => {
        if (moved)
          this.commit((composition) =>
            Object.assign(
              composition.layers.find((item) => item.id === layer.id)!,
              { x, y },
            ),
          );
        this.canvasFingerprint = "";
        this.renderCanvas();
        this.renderTimeline();
      },
    );
  }

  private dragTiming(
    event: PointerEvent,
    lane: HTMLElement,
    item: ProjectLayer | ProjectScene,
    kind: "layer" | "scene",
    edge: "move" | "start" | "end",
  ): void {
    if (this.busy) return;
    const width = lane.getBoundingClientRect().width;
    if (!width) return;
    const composition = this.composition!;
    const parent =
      kind === "layer"
        ? composition.scenes.find(
            (scene) => scene.id === (item as ProjectLayer).sceneId,
          )
        : undefined;
    const limit = parent?.durationFrames ?? composition.durationFrames;
    const offset = parent?.from ?? 0;
    const startX = event.clientX;
    const media =
      kind === "layer" &&
      ((item as ProjectLayer).kind === "audio" ||
        (item as ProjectLayer).kind === "video")
        ? (item as ProjectLayer)
        : undefined;
    let from = item.from,
      durationFrames = item.durationFrames,
      moved = false;
    this.selection = { kind, id: item.id };
    this.options.select?.();
    this.options.seek(offset + item.from);
    this.renderInspector();
    const clip = lane.querySelector<HTMLElement>(".track-clip")!;
    this.pointerGesture(
      event,
      (next) => {
        const delta = Math.round(
          ((next.clientX - startX) / width) * composition.durationFrames,
        );
        moved = moved || Math.abs(next.clientX - startX) > 2;
        if (edge === "move")
          from = Math.max(
            0,
            Math.min(limit - item.durationFrames, item.from + delta),
          );
        else if (edge === "start") {
          from = Math.max(
            media ? Math.max(0, item.from - (media.trimBeforeFrames ?? 0)) : 0,
            Math.min(item.from + item.durationFrames - 1, item.from + delta),
          );
          durationFrames = item.from + item.durationFrames - from;
        } else
          durationFrames = Math.max(
            1,
            Math.min(limit - item.from, item.durationFrames + delta),
          );
        clip.style.left = `${(100 * (offset + from)) / composition.durationFrames}%`;
        clip.style.width = `${(100 * durationFrames) / composition.durationFrames}%`;
      },
      () => {
        if (moved)
          this.commit((composition) => {
            const target =
              kind === "layer"
                ? composition.layers.find((layer) => layer.id === item.id)!
                : composition.scenes.find((scene) => scene.id === item.id)!;
            target.from = from;
            target.durationFrames = durationFrames;
            if (media && edge === "start")
              (target as ProjectLayer).trimBeforeFrames =
                (media.trimBeforeFrames ?? 0) + from - item.from;
          });
        this.renderTimeline();
      },
    );
  }

  private addScene(): void {
    const id = this.id("scene");
    if (
      this.commit((composition) => {
        const from = Math.max(
          0,
          ...composition.scenes.map(
            (scene) => scene.from + scene.durationFrames,
          ),
        );
        const durationFrames = Math.round(5 * composition.fps);
        composition.durationFrames = Math.max(
          composition.durationFrames,
          from + durationFrames,
        );
        composition.scenes.push({
          id,
          name: "New scene",
          from,
          durationFrames,
          background: composition.background,
        });
      })
    )
      this.select({ kind: "scene", id });
  }

  private addLayer(kind: ProjectLayer["kind"], asset?: ProjectAsset): void {
    const id = this.id(kind);
    if (
      this.commit((composition) => {
        const explicitScene =
          this.selection.kind === "scene"
            ? this.selection.id
            : this.selection.kind === "layer"
              ? composition.layers.find(
                  (layer) => layer.id === this.selection.id,
                )?.sceneId
              : undefined;
        const scene =
          kind === "audio"
            ? undefined
            : (composition.scenes.find((scene) => scene.id === explicitScene) ??
              composition.scenes.find(
                (scene) =>
                  scene.from <= this.frame &&
                  this.frame < scene.from + scene.durationFrames,
              ));
        const parentDuration =
          scene?.durationFrames ?? composition.durationFrames;
        const from = scene ? 0 : Math.min(this.frame, parentDuration - 1);
        const durationFrames = Math.min(
          parentDuration - from,
          asset?.durationSeconds
            ? Math.max(1, Math.floor(asset.durationSeconds * composition.fps))
            : parentDuration,
        );
        composition.layers.push({
          id,
          name: asset?.name ?? (kind === "text" ? "Text" : "Shape"),
          kind,
          ...(scene ? { sceneId: scene.id } : {}),
          from,
          durationFrames,
          x: Math.round(composition.width * 0.1),
          y: Math.round(composition.height * 0.1),
          width: Math.round(composition.width * 0.8),
          height:
            kind === "text"
              ? Math.round(composition.height * 0.2)
              : Math.round(composition.height * 0.8),
          rotation: 0,
          opacity: 1,
          ...(kind === "text"
            ? {
                text: "Your text",
                fontSize: Math.round(composition.height * 0.08),
                color: "#ffffff",
              }
            : kind === "shape"
              ? { color: "#5891dc" }
              : {
                  assetId: asset!.id,
                  ...(kind === "audio"
                    ? { gain: 1 }
                    : { fit: "contain" as const }),
                }),
        });
      })
    )
      this.select({ kind: "layer", id });
  }

  private duplicate(): void {
    const selection = this.selection;
    const id = this.id(selection.kind);
    if (
      this.commit((composition) => {
        if (selection.kind === "layer") {
          const layer = structuredClone(
            composition.layers.find((item) => item.id === selection.id)!,
          );
          composition.layers.push({
            ...layer,
            id,
            name: `${layer.name} copy`,
            x: layer.x + 20,
            y: layer.y + 20,
          });
        } else if (selection.kind === "scene") {
          const scene = composition.scenes.find(
            (item) => item.id === selection.id,
          )!;
          const from = Math.max(
            ...composition.scenes.map(
              (item) => item.from + item.durationFrames,
            ),
          );
          composition.scenes.push({
            ...scene,
            id,
            name: `${scene.name} copy`,
            from,
          });
          composition.durationFrames = Math.max(
            composition.durationFrames,
            from + scene.durationFrames,
          );
          composition.layers.push(
            ...composition.layers
              .filter((layer) => layer.sceneId === scene.id)
              .map((layer) => ({
                ...layer,
                id: this.id(layer.kind),
                sceneId: id,
              })),
          );
        }
      })
    )
      this.select({ kind: selection.kind, id });
  }

  private remove(): void {
    const selection = this.selection;
    if (
      this.commit((composition) => {
        if (selection.kind === "scene")
          composition.scenes = composition.scenes.filter(
            (scene) => scene.id !== selection.id,
          );
        composition.layers = composition.layers.filter((layer) =>
          selection.kind === "scene"
            ? layer.sceneId !== selection.id
            : layer.id !== selection.id,
        );
      })
    )
      this.select({ kind: "composition", id: this.composition!.id });
  }

  private reorder(direction: number): void {
    this.commit((composition) => {
      const index = composition.layers.findIndex(
        (layer) => layer.id === this.selection.id,
      );
      const next = Math.max(
        0,
        Math.min(composition.layers.length - 1, index + direction),
      );
      const [layer] = composition.layers.splice(index, 1);
      composition.layers.splice(next, 0, layer!);
    });
  }

  private id(prefix: string): string {
    return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  }
  private layerIcon(kind: ProjectLayer["kind"]): IconNode {
    return kind === "audio"
      ? Music2
      : kind === "video"
        ? Film
        : kind === "image"
          ? Image
          : kind === "text"
            ? Type
            : Square;
  }

  private disableControls(): void {
    for (const container of [
      this.options.inspector,
      this.options.timeline,
      this.options.media,
      this.options.actions,
    ])
      for (const element of container.querySelectorAll<
        | HTMLInputElement
        | HTMLButtonElement
        | HTMLSelectElement
        | HTMLTextAreaElement
      >("input,button,select,textarea")) {
        const action = element.dataset.history;
        element.disabled =
          this.busy ||
          (action === "undo"
            ? !this.history.canUndo
            : action === "redo"
              ? !this.history.canRedo
              : false);
      }
  }
}

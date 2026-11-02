// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import type { VideoProject } from "@velocast/core";
import { ProjectEditor } from "./project-editor.js";

function project(): VideoProject {
  return {
    format: "velocast-project",
    version: 1,
    name: "Demo",
    assets: [],
    compositions: [
      {
        id: "demo",
        name: "Demo",
        width: 960,
        height: 540,
        fps: 30,
        durationFrames: 900,
        background: "#101010",
        scenes: [
          {
            id: "intro",
            name: "Introduction",
            from: 0,
            durationFrames: 300,
            background: "#101010",
          },
        ],
        layers: [
          {
            id: "title",
            name: "Title",
            kind: "text",
            sceneId: "intro",
            from: 30,
            durationFrames: 120,
            x: 50,
            y: 80,
            width: 700,
            height: 100,
            rotation: 0,
            opacity: 1,
            text: "Hello",
            fontSize: 64,
            color: "#ffffff",
          },
        ],
      },
    ],
  };
}

function editor(input = project()) {
  const inspector = document.createElement("div");
  const timeline = document.createElement("div");
  const canvas = document.createElement("div");
  const media = document.createElement("div");
  const actions = document.createElement("div");
  document.body.replaceChildren(inspector, timeline, canvas, media, actions);
  const change = vi.fn();
  const seek = vi.fn();
  const draft = vi.fn();
  const app = new ProjectEditor({
    inspector,
    timeline,
    canvas,
    media,
    actions,
    change,
    seek,
    draft,
    history: vi.fn(),
    importAsset: vi.fn(),
  });
  app.update(input, "demo", 60, false);
  return { app, inspector, timeline, canvas, media, change, seek, draft };
}

it.each([false, true])(
  "shows volume only for video containing audio (hasAudio=%s)",
  (hasAudio) => {
    const input = project();
    input.assets.push({
      id: "clip",
      name: "Clip",
      kind: "video",
      src: "assets/clip.mp4",
      hasAudio,
    });
    Object.assign(input.compositions[0]!.layers[0]!, {
      kind: "video",
      assetId: "clip",
    });
    const f = editor(input);
    f.timeline.querySelector<HTMLElement>('[data-layer-id="title"]')!.click();
    expect(!!f.inspector.querySelector('[data-field="gain"]')).toBe(hasAudio);
    expect(
      f.inspector.querySelector('[data-field="trimBeforeFrames"]'),
    ).not.toBeNull();
    expect(
      f.inspector.querySelector('[data-field="fadeInFrames"]'),
    ).not.toBeNull();
    f.app.dispose();
  },
);

it.each(["audio", "video"] as const)(
  "preserves source position when trimming or extending the start of %s",
  (kind) => {
    for (const [delta, from, durationFrames, trimBeforeFrames] of [
      [30, 120, 90, 50],
      [-50, 70, 140, 0],
    ]) {
      const input = project();
      input.assets.push({
        id: "clip",
        name: "Clip",
        kind,
        src: `assets/clip.${kind === "video" ? "mp4" : "wav"}`,
        ...(kind === "video" ? { hasAudio: false } : {}),
      });
      Object.assign(input.compositions[0]!.layers[0]!, {
        kind,
        assetId: "clip",
        from: 90,
        durationFrames: 120,
        trimBeforeFrames: 20,
      });
      const f = editor(input);
      const lane = f.timeline.querySelector<HTMLElement>(
        ".layer-track .track-lane",
      )!;
      vi.spyOn(lane, "getBoundingClientRect").mockReturnValue(
        new DOMRect(0, 0, 900, 31),
      );
      lane
        .querySelector<HTMLElement>(".trim-start")!
        .dispatchEvent(
          new MouseEvent("pointerdown", {
            button: 0,
            clientX: 90,
            bubbles: true,
          }),
        );
      window.dispatchEvent(
        new MouseEvent("pointermove", { clientX: 90 + delta! }),
      );
      window.dispatchEvent(new MouseEvent("pointerup"));
      expect(f.change).toHaveBeenCalledOnce();
      expect(
        f.change.mock.calls[0]![0].compositions[0].layers[0],
      ).toMatchObject({ from, durationFrames, trimBeforeFrames });
      f.app.dispose();
    }
  },
);

it("discards an active drag when a newer project replaces its source", () => {
  const f = editor();
  const hit = f.canvas.querySelector<HTMLElement>('[data-layer-id="title"]')!;
  hit.dispatchEvent(
    new MouseEvent("pointerdown", { button: 0, clientX: 100, clientY: 100 }),
  );
  window.dispatchEvent(
    new MouseEvent("pointermove", { clientX: 140, clientY: 120 }),
  );
  const changed = project();
  changed.compositions[0]!.layers[0]!.x = 400;
  f.app.update(changed, "demo", 60, false);
  window.dispatchEvent(new MouseEvent("pointerup"));
  expect(f.change).not.toHaveBeenCalled();
  expect(
    f.canvas.querySelector<HTMLElement>('[data-layer-id="title"]')!.style.left,
  ).toBe("400px");
  f.app.dispose();
});

it("reports uncommitted text drafts before saving the field", () => {
  const f = editor();
  f.timeline.querySelector<HTMLElement>('[data-layer-id="title"]')!.click();
  const input = f.inspector.querySelector<HTMLTextAreaElement>(
    '[data-field="text"]',
  )!;
  input.value = "Still typing";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(f.draft).toHaveBeenCalledOnce();
  expect(f.app.hasDraft).toBe(true);
  expect(f.change).not.toHaveBeenCalled();
  input.value = "Hello";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(f.app.hasDraft).toBe(false);
});

it("connects timeline selection to contextual properties and saves only the selected layer", () => {
  const f = editor();
  f.timeline.querySelector<HTMLElement>('[data-layer-id="title"]')!.click();
  const text = f.inspector.querySelector<HTMLTextAreaElement>(
    '[data-field="text"]',
  )!;
  expect(text.value).toBe("Hello");
  text.value = "Edited title";
  text.dispatchEvent(new Event("change", { bubbles: true }));
  expect(f.change).toHaveBeenCalledOnce();
  const changed = f.change.mock.calls[0]![0] as VideoProject;
  expect(changed.compositions[0]!.layers[0]!.text).toBe("Edited title");
  expect(changed.compositions[0]!.scenes).toEqual(
    project().compositions[0]!.scenes,
  );
  expect(f.seek).toHaveBeenCalledWith(30);
});

it("keeps invalid timing local and retains selection when another editor changes the document", () => {
  const f = editor();
  f.timeline.querySelector<HTMLElement>('[data-layer-id="title"]')!.click();
  const start = f.inspector.querySelector<HTMLInputElement>(
    '[data-field="from"]',
  )!;
  start.value = "290";
  start.dispatchEvent(new Event("change", { bubbles: true }));
  expect(f.change).not.toHaveBeenCalled();
  expect(f.app.hasDraft).toBe(true);
  expect(f.inspector.querySelector('[role="alert"]')?.textContent).toContain(
    "outside parent intro",
  );
  const updated = project();
  updated.compositions[0]!.layers[0]!.text = "External edit";
  f.app.update(updated, "demo", 60, false);
  expect(
    f.inspector.querySelector<HTMLTextAreaElement>('[data-field="text"]')!
      .value,
  ).toBe("External edit");
  expect(
    f.canvas
      .querySelector('[data-layer-id="title"]')
      ?.getAttribute("aria-pressed"),
  ).toBe("true");
});

it("moves canvas layers in composition pixels and trims timeline layers in exact frames", () => {
  const f = editor();
  f.app.fit(960, 540, 2, 0, 0);
  const hit = f.canvas.querySelector<HTMLElement>('[data-layer-id="title"]')!;
  hit.dispatchEvent(
    new MouseEvent("pointerdown", { button: 0, clientX: 100, clientY: 100 }),
  );
  window.dispatchEvent(
    new MouseEvent("pointermove", { clientX: 140, clientY: 120 }),
  );
  window.dispatchEvent(new MouseEvent("pointerup"));
  expect(f.change.mock.calls[0]![0].compositions[0].layers[0]).toMatchObject({
    id: "title",
    x: 70,
    y: 90,
    from: 30,
    durationFrames: 120,
  });

  const lane = f.timeline.querySelector<HTMLElement>(
    ".layer-track .track-lane",
  )!;
  vi.spyOn(lane, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 900, 31),
  );
  lane
    .querySelector<HTMLElement>(".trim-end")!
    .dispatchEvent(
      new MouseEvent("pointerdown", { button: 0, clientX: 150, bubbles: true }),
    );
  window.dispatchEvent(new MouseEvent("pointermove", { clientX: 200 }));
  window.dispatchEvent(new MouseEvent("pointerup"));
  expect(f.change.mock.calls[1]![0].compositions[0].layers[0]).toMatchObject({
    id: "title",
    from: 30,
    durationFrames: 170,
  });
  expect(f.seek).toHaveBeenCalledWith(30);
  f.app.dispose();
});

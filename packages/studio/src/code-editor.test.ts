// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import type { CodeSource } from "@velocast/core";
import { CodeEditor } from "./code-editor.js";

const source: CodeSource = {
  enabled: true,
  compositionId: "demo",
  path: "src/Demo.tsx",
  revision: "file-1",
  canUndo: false,
  canRedo: false,
  elements: [
    {
      id: "title",
      name: "Title",
      kind: "layer",
      line: 14,
      fields: {
        text: { value: "Hello", editable: true },
        from: { value: 0, editable: true },
        durationFrames: { value: 60, editable: true },
        x: { value: 50, editable: true },
        y: { value: 80, editable: true },
        width: { value: 400, editable: true },
        height: { value: 100, editable: true },
        opacity: {
          editable: false,
          reason: "Opacity is calculated by the animation.",
        },
        "style.fontSize": { value: "2rem", editable: true },
      },
    },
  ],
};

function editor(initialSource = source) {
  const [inspector, timeline, canvas, media, actions] = Array.from(
    { length: 5 },
    () => document.createElement("div"),
  );
  document.body.replaceChildren(
    inspector!,
    timeline!,
    canvas!,
    media!,
    actions!,
  );
  const save = vi.fn(),
    seek = vi.fn();
  const recover = vi.fn();
  const app = new CodeEditor({
    inspector: inspector!,
    timeline: timeline!,
    canvas: canvas!,
    media: media!,
    actions: actions!,
    save,
    seek,
    recover,
    history: vi.fn(),
    draft: vi.fn(),
    select: vi.fn(),
    inspect: async () => ({ x: 50, y: 80, width: 400, height: 100 }),
  });
  const composition = {
    id: "demo",
    width: 960,
    height: 540,
    fps: 30,
    durationFrames: 90,
    target: "#root",
  };
  app.update(initialSource, composition, 20, false, "source-1");
  return {
    app,
    inspector: inspector!,
    timeline: timeline!,
    canvas: canvas!,
    composition,
    save,
    seek,
    recover,
    actions: actions!,
    media: media!,
  };
}

it("blocks ordinary edits during interrupted publication and exposes explicit recovery with retained bytes", () => {
  const f = editor({
    ...source,
    canUndo: true,
    recoveryRequired: true,
    recoveryPath: ".velocast/source-history/demo/retained.jsx",
  });
  expect(
    f.inspector.querySelector<HTMLInputElement>('[data-code-field="x"]')!
      .disabled,
  ).toBe(true);
  expect(f.app.canChangeHistory("undo")).toBe(false);
  expect(f.media.textContent).toContain("retained.jsx");
  f.actions.querySelector<HTMLButtonElement>("[data-code-recover]")!.click();
  expect(f.recover).toHaveBeenCalledOnce();
  f.app.update(source, f.composition, 20, false, "source-1");
  expect(f.actions.querySelector("[data-code-recover]")).toBeNull();
  expect(
    f.inspector.querySelector<HTMLInputElement>('[data-code-field="x"]')!
      .disabled,
  ).toBe(false);
  f.app.dispose();
});

it("retains a local draft when another writer needs recovery and requires explicit discard", () => {
  const f = editor();
  const field = f.inspector.querySelector<HTMLInputElement>(
    '[data-code-field="x"]',
  )!;
  field.value = "87";
  field.dispatchEvent(new Event("input"));
  f.app.update(
    { ...source, revision: "file-2", recoveryRequired: true },
    f.composition,
    20,
    false,
    "source-1",
  );
  expect(f.app.hasDraft).toBe(true);
  expect(
    f.inspector.querySelector<HTMLInputElement>('[data-code-field="x"]')!.value,
  ).toBe("87");
  expect(
    f.actions.querySelector<HTMLButtonElement>("[data-code-recover]")!.disabled,
  ).toBe(true);
  f.inspector.querySelector<HTMLButtonElement>("[data-code-discard]")!.click();
  expect(f.app.hasDraft).toBe(false);
  expect(
    f.actions.querySelector<HTMLButtonElement>("[data-code-recover]")!.disabled,
  ).toBe(false);
  f.app.dispose();
});

it("keeps a local draft visible after invalid external code and prevents saving it over that source", () => {
  const f = editor();
  const field = f.inspector.querySelector<HTMLInputElement>(
    '[data-code-field="x"]',
  )!;
  field.value = "87";
  field.dispatchEvent(new Event("input"));
  f.app.update(
    {
      ...source,
      revision: "file-2",
      syntaxError: "Demo.tsx:4: Unexpected token",
      elements: [],
      canUndo: true,
    },
    f.composition,
    20,
    false,
    "source-1",
  );
  expect(f.app.hasDraft).toBe(true);
  const retained = f.inspector.querySelector<HTMLInputElement>(
    '[data-code-field="x"]',
  )!;
  expect(retained.value).toBe("87");
  expect(retained.disabled).toBe(true);
  expect(
    f.inspector.querySelector<HTMLButtonElement>("[data-code-save]")!.disabled,
  ).toBe(true);
  f.inspector.querySelector<HTMLButtonElement>("[data-code-discard]")!.click();
  expect(f.app.canChangeHistory("undo")).toBe(true);
  expect(f.inspector.textContent).toContain("syntax error");
  f.app.dispose();
});

it("selects a visual layer first and preserves the user's selection on refresh", () => {
  const withMusic: CodeSource = {
    ...source,
    elements: [
      {
        id: "music",
        name: "Music",
        kind: "audio",
        line: 8,
        fields: { src: { value: "assets/music.wav", editable: true } },
      },
      ...source.elements,
    ],
  };
  const f = editor(withMusic);
  expect(f.inspector.querySelector("h2")?.textContent).toBe("Title");
  f.timeline
    .querySelector<HTMLButtonElement>('[data-code-id="music"]')!
    .click();
  f.app.update(
    { ...withMusic, revision: "file-2" },
    f.composition,
    20,
    false,
    "source-2",
  );
  expect(f.inspector.querySelector("h2")?.textContent).toBe("Music");
  f.app.dispose();

  const audio = editor({ ...withMusic, elements: [withMusic.elements[0]!] });
  expect(audio.inspector.querySelector("h2")?.textContent).toBe("Music");
  audio.app.dispose();
});

it("batches literal field edits with the source revision and explains computed fields", () => {
  const f = editor();
  f.timeline
    .querySelector<HTMLButtonElement>('[data-code-id="title"]')!
    .click();
  const location = f.inspector.querySelector<HTMLElement>(
    ".code-source-location",
  )!;
  expect(location.textContent).toBe("Demo.tsx:14");
  expect(location.title).toBe("src/Demo.tsx:14");
  expect(f.inspector.textContent).toContain(
    "Opacity is calculated by the animation.",
  );
  const text = f.inspector.querySelector<HTMLTextAreaElement>(
    '[data-code-field="text"]',
  )!;
  text.value = "Edited title";
  text.dispatchEvent(new Event("input", { bubbles: true }));
  expect(f.save).not.toHaveBeenCalled();
  f.inspector.querySelector<HTMLButtonElement>("[data-code-save]")!.click();
  expect(f.save).toHaveBeenCalledWith(
    [{ id: "title", field: "text", value: "Edited title" }],
    "file-1",
  );
  expect(f.seek).toHaveBeenCalledWith(0);
});

it("preserves CSS lengths and keeps a source-conflicting draft until explicit reload", () => {
  const f = editor();
  const font = f.inspector.querySelector<HTMLInputElement>(
    '[data-code-field="style.fontSize"]',
  )!;
  expect(font.value).toBe("2rem");
  font.value = "3rem";
  font.dispatchEvent(new Event("input"));
  f.inspector.querySelector<HTMLButtonElement>("[data-code-save]")!.click();
  expect(f.save).toHaveBeenCalledWith(
    [{ id: "title", field: "style.fontSize", value: "3rem" }],
    "file-1",
  );
  const external = structuredClone(source);
  external.revision = "file-2";
  external.elements[0]!.fields["style.fontSize"]!.value = "4rem";
  f.app.update(external, f.composition, 20, false, "source-2");
  expect(font.value).toBe("3rem");
  expect(
    f.inspector.querySelector<HTMLButtonElement>("[data-code-save]")!.disabled,
  ).toBe(true);
  expect(f.inspector.textContent).toContain("Source changed in another editor");
  f.inspector.querySelector<HTMLButtonElement>("[data-code-discard]")!.click();
  expect(
    f.inspector.querySelector<HTMLInputElement>(
      '[data-code-field="style.fontSize"]',
    )!.value,
  ).toBe("4rem");
  expect(f.app.hasDraft).toBe(false);
  f.app.dispose();
});

it("cancels a canvas move when the displayed source changes", async () => {
  const f = editor();
  await vi.waitFor(() => expect(f.canvas.children.length).toBe(1));
  f.canvas
    .querySelector<HTMLButtonElement>("button")!
    .dispatchEvent(
      new MouseEvent("pointerdown", { button: 0, clientX: 100, clientY: 100 }),
    );
  window.dispatchEvent(
    new MouseEvent("pointermove", { clientX: 140, clientY: 120 }),
  );
  f.app.update(
    { ...source, revision: "file-2" },
    f.composition,
    20,
    false,
    "source-2",
  );
  window.dispatchEvent(new MouseEvent("pointerup"));
  expect(f.app.hasDraft).toBe(false);
  expect(f.save).not.toHaveBeenCalled();
  f.app.dispose();
});

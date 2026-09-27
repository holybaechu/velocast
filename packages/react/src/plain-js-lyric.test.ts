import { afterEach, expect, it, vi } from "vitest";
import {
  registerFrameAdapter,
  resolveSequenceFrame,
  interpolate,
  Easing,
} from "@velocast/core";
import { clearFrameAdaptersForTest } from "@velocast/core/testing";

const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
afterEach(async () => {
  await window.__velocast?.destroy();
  clearFrameAdaptersForTest();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
  else Reflect.deleteProperty(document, "fonts");
});

it("uses shared nested-frame rules through real plain-JS adapter seeks", async () => {
  const fonts = new Set<unknown>();
  vi.stubGlobal(
    "FontFace",
    class {
      load() {
        return Promise.resolve(this);
      }
    },
  );
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: {
      add: (font: unknown) => fonts.add(font),
      delete: (font: unknown) => fonts.delete(font),
    },
  });

  let root: HTMLElement | undefined;
  let font: FontFace | undefined;
  const protocol = registerFrameAdapter(
    "lyric-transition",
    {
      id: "plain-js-shared-time",
      getDurationFrames: () => 120,
      async init(context) {
        font = new FontFace("LyricKorean", 'local("Malgun Gothic")');
        await font.load();
        context.signal?.throwIfAborted();
        document.fonts.add(font);
        root = document.createElement("main");
        document.body.appendChild(root);
      },
      seekFrame(frame, context) {
        root!.replaceChildren();
        for (const [from, name, property, fallback] of [
          [10, "first", "firstLine", "첫 번째 가사 줄"],
          [50, "second", "secondLine", "다음 가사 줄"],
        ] as const) {
          const scope = [
            { from: 0, durationFrames: 120 },
            { from, durationFrames: 40 },
          ];
          const line = resolveSequenceFrame(frame, scope);
          if (!line.isActive) continue;
          const section = document.createElement("section");
          section.dataset.lyricLine = name;
          section.dataset.lineFrame = String(line.localFrame);
          const title = document.createElement("h1");
          title.textContent = String(
            (context.inputProps as Record<string, unknown> | undefined)?.[
              property
            ] ?? fallback,
          );
          section.appendChild(title);
          const emphasis = resolveSequenceFrame(frame, [
            ...scope,
            { from: 8, durationFrames: 12 },
          ]);
          if (emphasis.isActive) {
            const highlight = document.createElement("div");
            highlight.dataset.emphasisFrame = String(emphasis.localFrame);
            highlight.style.width = `${interpolate(
              emphasis.localFrame,
              [0, 11],
              [0, 240],
              {
                easing: Easing.inOut(Easing.linear),
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              },
            )}px`;
            section.appendChild(highlight);
          }
          root!.appendChild(section);
        }
      },
      destroy() {
        root?.remove();
        root = undefined;
        if (font) document.fonts.delete(font);
        font = undefined;
      },
    },
    { width: 640, height: 360, fps: 60, target: "main", rootElement: "main" },
  );

  for (const [frame, line, local, emphasis] of [
    [9, null, null, null],
    [10, "first", 0, null],
    [18, "first", 8, 0],
    [29, "first", 19, 11],
    [30, "first", 20, null],
    [49, "first", 39, null],
    [50, "second", 0, null],
    [58, "second", 8, 0],
    [89, "second", 39, null],
    [90, null, null, null],
  ] as const) {
    await protocol.seekFrame("lyric-transition", frame);
    const element = document.querySelector<HTMLElement>("[data-lyric-line]");
    expect(element?.dataset.lyricLine ?? null).toBe(line);
    expect(element ? Number(element.dataset.lineFrame) : null).toBe(local);
    const highlight = document.querySelector<HTMLElement>(
      "[data-emphasis-frame]",
    );
    expect(highlight ? Number(highlight.dataset.emphasisFrame) : null).toBe(
      emphasis,
    );
  }
  await protocol.seekFrame("lyric-transition", 29);
  expect(
    document.querySelector<HTMLElement>("[data-emphasis-frame]")!.style.width,
  ).toBe("240px");
  const first = document.querySelector("main")!.innerHTML;
  await protocol.seekFrame("lyric-transition", 58);
  await protocol.seekFrame("lyric-transition", 10);
  await protocol.seekFrame("lyric-transition", 29);
  expect(document.querySelector("main")!.innerHTML).toBe(first);
  await protocol.setInputProps({ firstLine: "변경된 가사" });
  await protocol.seekFrame("lyric-transition", 29);
  expect(document.querySelector("h1")!.textContent).toBe("변경된 가사");
  await protocol.destroy();
  expect(fonts.size).toBe(0);
  expect(document.body.children).toHaveLength(0);
});

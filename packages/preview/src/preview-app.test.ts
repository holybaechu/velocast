import { afterEach, expect, it, vi } from "vitest";
import { PreviewApp } from "./preview-app.js";

const apps: PreviewApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.dispose();
  vi.unstubAllGlobals();
});

function mount(view: EventTarget) {
  const controls = new Map<string, HTMLElement>();
  function element(): HTMLElement {
    return Object.assign(new EventTarget(), {
      classList: { add() {} },
      setAttribute() {},
      appendChild() {},
      click: vi.fn(),
      querySelector(selector: string): HTMLElement {
        if (!controls.has(selector)) controls.set(selector, element());
        return controls.get(selector)!;
      },
    }) as unknown as HTMLElement;
  }
  const root = Object.assign(element(), {
    ownerDocument: { createElement: element },
  });
  const app = new PreviewApp({ root, window: view as unknown as Window });
  apps.push(app);
  return { app, play: controls.get("[data-play]")! };
}

it("releases the Space shortcut on disposal and leaves the live app handling it", async () => {
  for (const name of [
    "HTMLInputElement",
    "HTMLSelectElement",
    "HTMLButtonElement",
  ])
    vi.stubGlobal(name, class {});
  const view = Object.assign(new EventTarget(), {
    location: { href: "http://127.0.0.1:9000/" },
    clearTimeout,
  });
  const space = () => {
    const event = Object.assign(new Event("keydown", { cancelable: true }), {
      code: "Space",
    });
    view.dispatchEvent(event);
    return event;
  };
  const first = mount(view);
  expect(space().defaultPrevented).toBe(true);
  expect(first.play.click).toHaveBeenCalledOnce();
  await first.app.dispose();
  expect(space().defaultPrevented).toBe(false);
  expect(first.play.click).toHaveBeenCalledOnce();

  const second = mount(view);
  expect(space().defaultPrevented).toBe(true);
  expect(first.play.click).toHaveBeenCalledOnce();
  expect(second.play.click).toHaveBeenCalledOnce();
});

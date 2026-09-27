// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const playgroundRoot = resolve(import.meta.dirname, "..");
const productHeroRuntimePath = resolve(import.meta.dirname, "product-hero.js");
const mainRuntimePath = resolve(import.meta.dirname, "main.js");

function evaluateClassicScript(path) {
  const source = readFileSync(path, "utf8");
  (0, eval)(source);
}

function loadPlaygroundRuntime() {
  delete globalThis.VelocastPlaygroundProductHero;
  delete globalThis.VelocastPlayground;
  evaluateClassicScript(productHeroRuntimePath);
  evaluateClassicScript(mainRuntimePath);
  return globalThis.VelocastPlayground;
}

function mountStaticMarkup() {
  document.body.innerHTML = `
    <div id="root">
      <main class="preview-shell">
        <section id="product-hero" class="product-hero" aria-label="Render metrics">
          <section class="metric-scene">
            <div class="metric-headline"></div>
            <dl class="metric-grid">
              <div class="metric-row"><dt class="metric-label">TIME</dt><dd class="metric-value" data-metric="time"></dd></div>
              <div class="metric-row"><dt class="metric-label">PROGRESS</dt><dd class="metric-value" data-metric="progress"></dd></div>
              <div class="metric-row"><dt class="metric-label">RESOLUTION</dt><dd class="metric-value" data-metric="resolution"></dd></div>
              <div class="metric-row"><dt class="metric-label">RATE</dt><dd class="metric-value" data-metric="rate"></dd></div>
              <div class="metric-row"><dt class="metric-label">COMPOSITION</dt><dd class="metric-value" data-metric="composition"></dd></div>
            </dl>
          </section>
        </section>
      </main>
    </div>
  `;
}

function fakeGsap() {
  const timelines = [];

  return {
    timelines,
    timeline() {
      let tweenTarget;
      let tweenVars;
      const timeline = {
        to(target, vars) {
          tweenTarget = target;
          tweenVars = vars;
          return timeline;
        },
        totalTime: vi.fn((seconds) => {
          if (tweenTarget === undefined || tweenVars === undefined) {
            return timeline;
          }

          const progress = Math.min(
            Math.max(seconds / tweenVars.duration, 0),
            1,
          );
          tweenTarget.frame = tweenVars.frame * progress;
          tweenVars.onUpdate();

          return timeline;
        }),
      };
      timelines.push(timeline);
      return timeline;
    },
  };
}

function fakeVelocastGsap() {
  return {
    register: vi.fn(),
  };
}

beforeEach(() => {
  vi.resetModules();
  globalThis.__velocastPlaygroundAutoStart = false;
});

afterEach(() => {
  document.body.innerHTML = "";
  delete globalThis.VelocastPlaygroundProductHero;
  delete globalThis.VelocastPlayground;
  delete globalThis.__velocastPlaygroundAutoStart;
});

describe("playground bootstrap", () => {
  it("loads file-safe classic runtime scripts from the real HTML shell", () => {
    const html = readFileSync(resolve(playgroundRoot, "index.html"), "utf8");
    const dom = new JSDOM(html);
    const scripts = [...dom.window.document.querySelectorAll("script")];

    expect(scripts.map((script) => script.getAttribute("src"))).toEqual([
      "./node_modules/gsap/dist/gsap.min.js",
      "../../packages/gsap/browser/velocast-gsap.global.js",
      "./src/product-hero.js",
      "./src/main.js",
    ]);
    expect(scripts.map((script) => script.getAttribute("type"))).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it("fails clearly when GSAP is missing", () => {
    mountStaticMarkup();
    const { startProductHeroPlayground } = loadPlaygroundRuntime();

    expect(() =>
      startProductHeroPlayground({
        gsapApi: undefined,
        velocastGsap: fakeVelocastGsap(),
      }),
    ).toThrow("VELOCAST_GSAP_MISSING");
  });

  it("fails clearly when the Velocast GSAP adapter is missing", () => {
    mountStaticMarkup();
    const { startProductHeroPlayground } = loadPlaygroundRuntime();

    expect(() =>
      startProductHeroPlayground({
        gsapApi: fakeGsap(),
        velocastGsap: undefined,
      }),
    ).toThrow("VELOCAST_GSAP_ADAPTER_MISSING");
  });

  it("registers the product hero with VelocastGSAP", () => {
    mountStaticMarkup();
    const gsapApi = fakeGsap();
    const velocastGsap = fakeVelocastGsap();
    const { startProductHeroPlayground } = loadPlaygroundRuntime();

    startProductHeroPlayground({
      gsapApi,
      velocastGsap,
    });

    expect(velocastGsap.register).toHaveBeenCalledTimes(1);
    const [[compositionId, timeline, options]] = velocastGsap.register.mock.calls;

    expect(compositionId).toBe("product-hero");
    expect(timeline).toEqual(
      expect.objectContaining({
        to: expect.any(Function),
        totalTime: expect.any(Function),
      }),
    );
    expect(timeline.totalTime).toHaveBeenCalledWith(72 / 60, false);
    expect(gsapApi.timelines[0].totalTime).toHaveBeenCalledWith(72 / 60, false);
    expect(velocastGsap.register).toHaveBeenCalledWith(
      "product-hero",
      timeline,
      expect.objectContaining({
        width: 3840,
        height: 2160,
        fps: 60,
        target: "#product-hero",
        durationFrames: 240,
        rootElement: expect.any(HTMLElement),
      }),
    );
    expect(options.rootElement.querySelector(".metric-headline")?.textContent).toBe(
      "FRAME 0072",
    );
  });
});

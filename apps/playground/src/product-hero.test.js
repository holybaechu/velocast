// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearFrameAdaptersForTest } from "@velocast/core/testing";
import { registerGsapTimeline } from "@velocast/gsap";
import { gsap } from "gsap";

const runtimePath = resolve(import.meta.dirname, "product-hero.js");

function loadProductHeroRuntime() {
  delete globalThis.VelocastPlaygroundProductHero;
  const source = readFileSync(runtimePath, "utf8");
  (0, eval)(source);
  return globalThis.VelocastPlaygroundProductHero;
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

  return document.querySelector("#root");
}

function metric(target, name) {
  return target.querySelector(`[data-metric="${name}"]`)?.textContent;
}

function expectRenderedFrame(target, frame, productHeroFrameMetrics) {
  const expected = productHeroFrameMetrics(frame);

  expect(target.querySelector(".metric-headline")?.textContent).toBe(
    expected.label,
  );
  expect(metric(target, "time")).toBe(expected.time);
  expect(metric(target, "progress")).toBe(expected.progress);
}

afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-velocast-rendering");
  clearFrameAdaptersForTest();
  window.__velocast = undefined;
  window.Velocast = undefined;
  gsap.globalTimeline.clear();
});

describe("vanilla GSAP product hero playground", () => {
  it("keeps the canonical playground composition contract", () => {
    const { productHeroComposition, productHeroPreviewFrame } =
      loadProductHeroRuntime();

    expect(productHeroComposition).toEqual({
      id: "product-hero",
      width: 3840,
      height: 2160,
      fps: 60,
      durationFrames: 240,
      target: "#product-hero",
      maxConcurrency: 4,
    });
    expect(productHeroPreviewFrame).toBe(72);
  });

  it("resolves the static product hero target and renders the preview frame", () => {
    const {
      productHeroFrameMetrics,
      productHeroPreviewFrame,
      resolveProductHeroTarget,
    } = loadProductHeroRuntime();
    const root = mountStaticMarkup();
    const target = resolveProductHeroTarget(root);

    expect(target.id).toBe("product-hero");
    expectRenderedFrame(target, productHeroPreviewFrame, productHeroFrameMetrics);
  });

  it("renders deterministic frame metrics from frame numbers", () => {
    const {
      renderProductHeroFrame,
      resolveProductHeroTarget,
    } = loadProductHeroRuntime();
    const root = mountStaticMarkup();
    const target = resolveProductHeroTarget(root);

    renderProductHeroFrame(target, 96);

    expect(target.style.width).toBe("3840px");
    expect(target.style.height).toBe("2160px");
    expect(target.textContent).toContain("FRAME 0096");
    expect(target.textContent).toContain("1.60s");
    expect(target.textContent).toContain("40%");
    expect(target.textContent).toContain("3840x2160");
    expect(target.textContent).toContain("60 FPS");
    expect(target.textContent).toContain("product-hero");
  });

  it("computes canonical frame metrics for probe frames", () => {
    const { productHeroFrameMetrics } = loadProductHeroRuntime();

    expect(productHeroFrameMetrics(0)).toMatchObject({
      frame: 0,
      label: "FRAME 0000",
      time: "0.00s",
      progress: "0%",
    });
    expect(productHeroFrameMetrics(172)).toMatchObject({
      frame: 172,
      label: "FRAME 0172",
      time: "2.87s",
      progress: "72%",
    });
  });

  it("shows capture scale when Velocast rendering is active", () => {
    const { renderProductHeroFrame, resolveProductHeroTarget } =
      loadProductHeroRuntime();
    document.documentElement.dataset.velocastRendering = "true";
    const root = mountStaticMarkup();
    const target = resolveProductHeroTarget(root);

    renderProductHeroFrame(target, 144);

    expect(target.style.getPropertyValue("--scene-scale")).toBe("2");
    expect(target.querySelector(".metric-headline")?.textContent).toBe(
      "FRAME 0144",
    );
  });

  it("maps GSAP timeline time to canonical frame numbers", () => {
    const {
      createProductHeroTimeline,
      productHeroComposition,
      productHeroFrameMetrics,
      productHeroPreviewFrame,
      renderProductHeroFrame,
      resolveProductHeroTarget,
    } = loadProductHeroRuntime();
    const calls = [];
    const root = mountStaticMarkup();
    const target = resolveProductHeroTarget(root);
    const timeline = createProductHeroTimeline(gsap, target, (frame) => {
      calls.push(frame);
      renderProductHeroFrame(target, frame);
    });

    timeline.totalTime(productHeroPreviewFrame / productHeroComposition.fps, false);

    for (const frame of [0, 72, 96, 239]) {
      calls.length = 0;

      timeline.totalTime(frame / productHeroComposition.fps, false);

      expect(Math.round(calls.at(-1) ?? Number.NaN)).toBe(frame);
      expectRenderedFrame(target, frame, productHeroFrameMetrics);
    }
  });

  it("lets the Velocast GSAP adapter seek canonical frames", async () => {
    const {
      createProductHeroTimeline,
      productHeroComposition,
      productHeroFrameMetrics,
      productHeroPreviewFrame,
      resolveProductHeroTarget,
    } = loadProductHeroRuntime();
    const root = mountStaticMarkup();
    const target = resolveProductHeroTarget(root);
    const timeline = createProductHeroTimeline(gsap, target);

    timeline.totalTime(productHeroPreviewFrame / productHeroComposition.fps, false);

    registerGsapTimeline(productHeroComposition.id, timeline, {
      width: productHeroComposition.width,
      height: productHeroComposition.height,
      fps: productHeroComposition.fps,
      target: productHeroComposition.target,
      maxConcurrency: productHeroComposition.maxConcurrency,
      rootElement: target,
      durationFrames: productHeroComposition.durationFrames,
    });

    for (const frame of [0, 72, 96, 239]) {
      await window.__velocast?.seekFrame(productHeroComposition.id, frame);

      expectRenderedFrame(target, frame, productHeroFrameMetrics);
    }
  });

  it("seeks frames 168 through 176 without semantic duplicates", async () => {
    const {
      createProductHeroTimeline,
      productHeroComposition,
      resolveProductHeroTarget,
    } = loadProductHeroRuntime();
    const root = mountStaticMarkup();
    const target = resolveProductHeroTarget(root);
    const timeline = createProductHeroTimeline(gsap, target);
    const observedLabels = [];

    registerGsapTimeline(productHeroComposition.id, timeline, {
      width: productHeroComposition.width,
      height: productHeroComposition.height,
      fps: productHeroComposition.fps,
      target: productHeroComposition.target,
      maxConcurrency: productHeroComposition.maxConcurrency,
      rootElement: target,
      durationFrames: productHeroComposition.durationFrames,
    });

    for (let frame = 168; frame <= 176; frame += 1) {
      await window.__velocast?.seekFrame(productHeroComposition.id, frame);
      observedLabels.push(
        target.querySelector(".metric-headline")?.textContent ?? "",
      );
    }

    expect(observedLabels).toEqual([
      "FRAME 0168",
      "FRAME 0169",
      "FRAME 0170",
      "FRAME 0171",
      "FRAME 0172",
      "FRAME 0173",
      "FRAME 0174",
      "FRAME 0175",
      "FRAME 0176",
    ]);
    expect(new Set(observedLabels).size).toBe(observedLabels.length);
  });
});

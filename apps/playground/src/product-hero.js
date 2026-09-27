// @ts-check

(() => {
  /** @type {import("@velocast/core").CompositionManifest} */
  const productHeroComposition = {
    id: "product-hero",
    width: 3840,
    height: 2160,
    fps: 60,
    durationFrames: 240,
    target: "#product-hero",
    maxConcurrency: 4,
  };

  const productHeroPreviewFrame = 72;

  /**
   * @typedef {object} ProductHeroFrameMetrics
   * @property {number} frame
   * @property {number} progressRatio
   * @property {string} label
   * @property {string} time
   * @property {string} progress
   * @property {string} resolution
   * @property {string} rate
   * @property {string} composition
   */

  /**
   * @typedef {object} GsapTimelineLike
   * @property {(target: { frame: number }, vars: { frame: number, duration: number, ease: "none", onUpdate: () => void }, position: number) => unknown} to
   * @property {(timeSeconds: number, suppressEvents?: boolean) => unknown} totalTime
   */

  /**
   * @typedef {object} GsapLike
   * @property {(options: { paused: true }) => GsapTimelineLike} timeline
   */

  /**
   * @typedef {object} ProductHeroNamespace
   * @property {typeof productHeroComposition} productHeroComposition
   * @property {number} productHeroPreviewFrame
   * @property {(frame: number) => ProductHeroFrameMetrics} productHeroFrameMetrics
   * @property {(root?: ParentNode | null) => HTMLElement} resolveProductHeroTarget
   * @property {(target: HTMLElement, frame: number) => void} renderProductHeroFrame
   * @property {(gsapApi: GsapLike, target: HTMLElement, onFrame?: (frame: number) => void) => GsapTimelineLike} createProductHeroTimeline
   */

  /**
   * @param {number} frame
   * @returns {number}
   */
  function clampFrame(frame) {
    return Math.min(
      Math.max(Math.round(frame), 0),
      productHeroComposition.durationFrames - 1,
    );
  }

  /**
   * @param {number} frame
   * @returns {ProductHeroFrameMetrics}
   */
  function productHeroFrameMetrics(frame) {
    const currentFrame = clampFrame(frame);
    const progressRatio =
      currentFrame / Math.max(productHeroComposition.durationFrames - 1, 1);

    return {
      frame: currentFrame,
      progressRatio,
      label: `FRAME ${String(currentFrame).padStart(4, "0")}`,
      time: `${(currentFrame / productHeroComposition.fps).toFixed(2)}s`,
      progress: `${Math.round(progressRatio * 100)}%`,
      resolution: `${productHeroComposition.width}x${productHeroComposition.height}`,
      rate: `${productHeroComposition.fps} FPS`,
      composition: productHeroComposition.id,
    };
  }

  /**
   * @returns {boolean}
   */
  function isVelocastRendering() {
    return document.documentElement.dataset.velocastRendering === "true";
  }

  /**
   * @param {ParentNode | null} [root]
   * @returns {HTMLElement}
   */
  function resolveProductHeroTarget(root = document) {
    const target = root?.querySelector?.("#product-hero");
    if (!(target instanceof HTMLElement)) {
      throw new Error("product hero target was not mounted");
    }

    renderProductHeroFrame(target, productHeroPreviewFrame);
    return target;
  }

  /**
   * @param {HTMLElement} target
   * @param {number} frame
   * @returns {void}
   */
  function renderProductHeroFrame(target, frame) {
    const metrics = productHeroFrameMetrics(frame);
    const captureScale = Math.min(
      productHeroComposition.width / 1920,
      productHeroComposition.height / 1080,
    );
    const scale = isVelocastRendering() ? captureScale : 1;

    target.style.width = `${productHeroComposition.width}px`;
    target.style.height = `${productHeroComposition.height}px`;
    target.style.setProperty("--scene-scale", String(scale));
    const scene = target.querySelector(".metric-scene");
    if (scene instanceof HTMLElement) {
      scene.style.setProperty(
        "--metric-progress",
        metrics.progressRatio.toFixed(2),
      );
    }

    const headline = target.querySelector(".metric-headline");
    if (headline instanceof HTMLElement) {
      headline.textContent = metrics.label;
    }

    const values = {
      time: metrics.time,
      progress: metrics.progress,
      resolution: metrics.resolution,
      rate: metrics.rate,
      composition: metrics.composition,
    };

    for (const [key, value] of Object.entries(values)) {
      const node = target.querySelector(`[data-metric="${key}"]`);
      if (node instanceof HTMLElement) {
        node.textContent = value;
      }
    }
  }

  /**
   * @param {GsapLike} gsapApi
   * @param {HTMLElement} target
   * @param {(frame: number) => void} [onFrame]
   * @returns {GsapTimelineLike}
   */
  function createProductHeroTimeline(
    gsapApi,
    target,
    onFrame = (frame) => renderProductHeroFrame(target, frame),
  ) {
    const state = { frame: 0 };
    const timeline = gsapApi.timeline({ paused: true });

    timeline.to(
      state,
      {
        frame: productHeroComposition.durationFrames - 1,
        duration:
          (productHeroComposition.durationFrames - 1) /
          productHeroComposition.fps,
        ease: "none",
        onUpdate() {
          onFrame(state.frame);
        },
      },
      0,
    );

    return timeline;
  }

  const scope =
    /** @type {typeof globalThis & { VelocastPlaygroundProductHero?: ProductHeroNamespace }} */ (
      globalThis
    );

  scope.VelocastPlaygroundProductHero = {
    productHeroComposition,
    productHeroPreviewFrame,
    productHeroFrameMetrics,
    resolveProductHeroTarget,
    renderProductHeroFrame,
    createProductHeroTimeline,
  };
})();

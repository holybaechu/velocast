// @ts-check

(() => {
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
   * @typedef {object} VelocastGsapGlobal
   * @property {(compositionId: string, timeline: unknown, options?: Record<string, unknown>) => unknown} register
   */

  /**
   * @typedef {object} ProductHeroNamespace
   * @property {{ id: string, width: number, height: number, fps: number, durationFrames: number, target: string, maxConcurrency?: number }} productHeroComposition
   * @property {number} productHeroPreviewFrame
   * @property {(root?: ParentNode | null) => HTMLElement} resolveProductHeroTarget
   * @property {(gsapApi: GsapLike, target: HTMLElement) => GsapTimelineLike} createProductHeroTimeline
   */

  /**
   * @typedef {object} PlaygroundNamespace
   * @property {(options?: { root?: ParentNode, gsapApi?: GsapLike, velocastGsap?: VelocastGsapGlobal }) => void} startProductHeroPlayground
   */

  /**
   * @typedef {typeof globalThis & {
   *   gsap?: GsapLike,
   *   VelocastGSAP?: VelocastGsapGlobal,
   *   VelocastPlaygroundProductHero?: ProductHeroNamespace,
   *   VelocastPlayground?: PlaygroundNamespace,
   *   __velocastPlaygroundAutoStart?: boolean
   * }} PlaygroundScope
   */

  const scope = /** @type {PlaygroundScope} */ (globalThis);

  /**
   * @param {object} [options]
   * @param {ParentNode} [options.root]
   * @param {GsapLike} [options.gsapApi]
   * @param {VelocastGsapGlobal} [options.velocastGsap]
   * @returns {void}
   */
  function startProductHeroPlayground(options = {}) {
    const productHero = scope.VelocastPlaygroundProductHero;
    if (productHero === undefined) {
      throw new Error(
        "VELOCAST_PLAYGROUND_PRODUCT_HERO_MISSING: Product hero runtime was not found.",
      );
    }

    const gsapApi = options.gsapApi ?? scope.gsap;
    if (gsapApi === undefined) {
      throw new Error("VELOCAST_GSAP_MISSING: GSAP was not found.");
    }

    const velocastGsap = options.velocastGsap ?? scope.VelocastGSAP;
    if (velocastGsap === undefined) {
      throw new Error(
        "VELOCAST_GSAP_ADAPTER_MISSING: VelocastGSAP was not found.",
      );
    }

    const {
      createProductHeroTimeline,
      productHeroComposition,
      productHeroPreviewFrame,
      resolveProductHeroTarget,
    } = productHero;
    const target = resolveProductHeroTarget(options.root ?? document);
    const timeline = createProductHeroTimeline(gsapApi, target);

    timeline.totalTime(
      productHeroPreviewFrame / productHeroComposition.fps,
      false,
    );

    velocastGsap.register(productHeroComposition.id, timeline, {
      width: productHeroComposition.width,
      height: productHeroComposition.height,
      fps: productHeroComposition.fps,
      target: productHeroComposition.target,
      maxConcurrency: productHeroComposition.maxConcurrency,
      rootElement: target,
      durationFrames: productHeroComposition.durationFrames,
    });
  }

  scope.VelocastPlayground = {
    startProductHeroPlayground,
  };

  if (scope.__velocastPlaygroundAutoStart !== false) {
    startProductHeroPlayground();
  }
})();

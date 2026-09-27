import { Velocast } from "@velocast/core";
import { registerGsapTimeline } from "./index.js";
import type { GsapTimelineRegistrationOptions } from "./index.js";

type GlobalScope = typeof globalThis & {
  gsap?: unknown;
  Velocast?: typeof Velocast;
  VelocastGSAP?: {
    register(
      compositionId: string,
      timeline: unknown,
      options?: GsapTimelineRegistrationOptions,
    ): unknown;
  };
};

const scope = globalThis as GlobalScope;

function assertGsapLoaded(): void {
  if (scope.gsap === undefined) {
    throw new Error(
      "VELOCAST_GSAP_MISSING: GSAP was not found. Load gsap before velocast-gsap.",
    );
  }
}

scope.Velocast = scope.Velocast ?? Velocast;
scope.VelocastGSAP = {
  register(compositionId, timeline, options) {
    assertGsapLoaded();
    return registerGsapTimeline(compositionId, timeline, options);
  },
};

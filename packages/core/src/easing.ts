import type { EasingFunction } from "./interpolation.js";

function finite(value: number): number {
  if (!Number.isFinite(value))
    throw new RangeError("easing values must be finite");
  return value;
}

function checked(easing: EasingFunction): EasingFunction {
  if (typeof easing !== "function")
    throw new TypeError("easing must be a function");
  return (progress) => finite(easing(finite(progress)));
}

function sample(t: number, first: number, second: number): number {
  const remaining = 1 - t;
  return (
    3 * remaining * remaining * t * first +
    3 * remaining * t * t * second +
    t * t * t
  );
}

/**
 * Cubic Bezier timing with endpoints (0,0)/(1,1); x controls must be in [0,1].
 * Inverts the x coordinate (it does not merely evaluate y at `progress`).
 * Progress outside [0,1] clamps to the endpoints; y controls may overshoot.
 * This is a bounded timing curve, not a full Remotion compatibility export.
 */
export function cubicBezier(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): EasingFunction {
  [x1, y1, x2, y2].forEach(finite);
  if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1)
    throw new RangeError("Bezier x controls must be in [0, 1]");
  return (progress) => {
    finite(progress);
    if (progress <= 0) return 0;
    if (progress >= 1) return 1;
    let t = progress;
    for (let iteration = 0; iteration < 8; iteration++) {
      const difference = sample(t, x1, x2) - progress;
      if (difference === 0) return finite(sample(t, y1, y2));
      const derivative =
        3 * (1 - t) * (1 - t) * x1 +
        6 * (1 - t) * t * (x2 - x1) +
        3 * t * t * (1 - x2);
      if (Math.abs(derivative) < 1e-8) break;
      const next = t - difference / derivative;
      if (next < 0 || next > 1) break;
      if (Math.abs(next - t) < 1e-13) return finite(sample(next, y1, y2));
      t = next;
    }
    // Bounded fallback covers flat derivatives and every valid monotone x curve.
    let lower = 0;
    let upper = 1;
    for (let iteration = 0; iteration < 60; iteration++) {
      t = (lower + upper) / 2;
      const x = sample(t, x1, x2);
      if (x === progress) break;
      if (x < progress) lower = t;
      else upper = t;
    }
    return finite(sample(t, y1, y2));
  };
}

/**
 * Shared timing helpers. `ease` is (0.42,0,1,1), matching the pinned lyrics
 * project's Remotion 4.0.244 control points, not CSS's differently named `ease`.
 * Our precise inversion is not a bit-identical emulation of that version's
 * approximation near flat endpoints; compatibility modules must account for it.
 */
export const Easing = Object.freeze({
  linear: (progress: number): number => finite(progress),
  ease: cubicBezier(0.42, 0, 1, 1),
  bezier: cubicBezier,
  in: (easing: EasingFunction): EasingFunction => checked(easing),
  out: (easing: EasingFunction): EasingFunction => {
    const evaluate = checked(easing);
    return (progress) => finite(1 - evaluate(1 - finite(progress)));
  },
  inOut: (easing: EasingFunction): EasingFunction => {
    const evaluate = checked(easing);
    return (progress) => {
      finite(progress);
      return finite(
        progress < 0.5
          ? evaluate(progress * 2) / 2
          : 1 - evaluate((1 - progress) * 2) / 2,
      );
    };
  },
});

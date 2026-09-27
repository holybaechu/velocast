import { describe, expect, it } from "vitest";
import { cubicBezier, Easing, interpolate } from "./index.js";

describe("easing", () => {
  it("uses cubic-bezier x inversion and composes lyric ease-out deterministically", () => {
    const linear = cubicBezier(0, 0, 1, 1);
    expect(linear(0.25)).toBeCloseTo(0.25, 12);
    expect(Easing.ease(0.5)).toBeCloseTo(0.31535681257253934, 7);
    expect(Easing.out(Easing.ease)(0.5)).toBeCloseTo(0.6846431874274607, 7);
    expect(Easing.inOut(Easing.ease)(0.5)).toBe(0.5);
    const seek = (frame: number) =>
      interpolate(frame, [0, 60], [0, 100], {
        easing: Easing.out(Easing.ease),
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
    const values = [0, 30, 60, 30, 0].map(seek);
    expect(values[0]).toBe(0);
    expect(values[1]).toBeCloseTo(68.46431874274607, 5);
    expect(values[2]).toBe(100);
    expect(values[3]).toBe(values[1]);
    expect(values[4]).toBe(0);
  });

  // Literal oracle values observed from the isolated Remotion 4.0.244 installation.
  // No Remotion code or dependency is loaded by this test/package.
  it.each([
    [0.001, 0.0000018875054558443418, 0.001715648210520948],
    [0.1, 0.01702660965156294, 0.16057215423753346],
    [0.25, 0.09346465071882487, 0.3781381308251097],
    [0.5, 0.31535681257253934, 0.6846431874274607],
    [0.75, 0.6218618691748903, 0.9065353492811752],
    [0.9, 0.8394278457624665, 0.9829733903484371],
    [0.999, 0.998284351789479, 0.9999981124945442],
  ])("matches the pinned ease/ease-out oracle at %s", (input, ease, out) => {
    // The upstream numerical approximation loses precision near the endpoint.
    // This bound applies to these literal representative samples, not all t.
    expect(Math.abs(Easing.ease(input) - ease)).toBeLessThan(0.000002);
    expect(Math.abs(Easing.out(Easing.ease)(input) - out)).toBeLessThan(
      0.000002,
    );
  });

  it("matches actual lyrics scroll numbers at the first transition", () => {
    const options = {
      easing: Easing.out(Easing.ease),
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    } as const;
    expect(interpolate(1068, [1068, 1082], [0, -138], options)).toBe(0);
    expect(interpolate(1069, [1068, 1082], [0, -138], options)).toBeCloseTo(
      -16.037064861554864,
      5,
    );
    expect(interpolate(1070, [1068, 1082], [0, -138], options)).toBeCloseTo(
      -31.08963662084288,
      5,
    );
    expect(interpolate(1082, [1068, 1082], [0, -138], options)).toBe(-138);
  });

  it("covers flat derivatives, bounded progress and overshooting y controls", () => {
    expect(cubicBezier(0, 0, 0, 1)(0.125)).toBeCloseTo(0.5, 12);
    expect(cubicBezier(0, 1, 0, 1)(1e-12)).toBeCloseTo(0.000299970001, 12);
    expect(cubicBezier(1, 0, 0, 1)(0.5)).toBe(0.5);
    expect(cubicBezier(1 / 3, -1, 2 / 3, 2)(0.1)).toBeCloseTo(-0.188, 12);
    expect(Easing.ease(-1)).toBe(0);
    expect(Easing.ease(2)).toBe(1);
    expect(Easing.linear(-1)).toBe(-1);
    expect(Easing.in(Easing.linear)(0.4)).toBe(0.4);
    expect(Easing.inOut(Easing.ease)(0.25)).toBeCloseTo(0.15767840628626967, 7);
    expect(Easing.inOut(Easing.ease)(0.75)).toBeCloseTo(0.8423215937137303, 7);
  });

  it("records the pinned oracle's near-endpoint discrepancy instead of claiming bit identity", () => {
    const difference = Math.abs(Easing.ease(0.9999) - 0.9997675083569296);
    expect(difference).toBeGreaterThan(0.00006);
    expect(difference).toBeLessThan(0.000061);
  });

  it("rejects non-finite parameters/results and non-invertible x controls", () => {
    expect(() => cubicBezier(-0.1, 0, 1, 1)).toThrow(/x controls/);
    expect(() => cubicBezier(0, 0, 1.1, 1)).toThrow(/x controls/);
    expect(() => cubicBezier(0, NaN, 1, 1)).toThrow(/finite/);
    expect(() => Easing.ease(Infinity)).toThrow(/finite/);
    expect(() => Easing.out(() => NaN)(0.5)).toThrow(/finite/);
    expect(() => Easing.inOut(() => Infinity)(0.5)).toThrow(/finite/);
    expect(() => Easing.in(null as unknown as (x: number) => number)).toThrow(
      /function/,
    );
  });
});

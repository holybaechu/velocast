export type EasingFunction = (progress: number) => number;
export type Extrapolation = "extend" | "clamp" | "identity";

export interface InterpolationOptions {
  readonly extrapolateLeft?: Extrapolation;
  readonly extrapolateRight?: Extrapolation;
  readonly easing?: EasingFunction;
}

function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
  return value;
}

/**
 * Piecewise numeric interpolation over strictly increasing input keyframes.
 * Extrapolation defaults to extend on both sides; clamp acts on input before
 * easing. At an interior keyframe the preceding segment is selected. Easing
 * receives segment-local progress; supply a pure callback for deterministic seeks.
 * Only extend/clamp/identity are supported (not Remotion's additional wrap mode).
 */
export function interpolate(
  value: number,
  inputRange: readonly number[],
  outputRange: readonly number[],
  options: InterpolationOptions = {},
): number {
  finite(value, "value");
  if (!Array.isArray(inputRange) || !Array.isArray(outputRange))
    throw new TypeError("inputRange and outputRange must be arrays");
  if (inputRange.length < 2 || inputRange.length !== outputRange.length)
    throw new RangeError(
      "inputRange and outputRange must have the same length of at least two",
    );
  for (let index = 0; index < inputRange.length; index++) {
    finite(inputRange[index]!, "inputRange values");
    finite(outputRange[index]!, "outputRange values");
    if (index > 0 && inputRange[index]! <= inputRange[index - 1]!)
      throw new RangeError("inputRange must be strictly increasing");
  }
  if (!options || typeof options !== "object" || Array.isArray(options))
    throw new TypeError("options must be an object");
  const left = options.extrapolateLeft ?? "extend";
  const right = options.extrapolateRight ?? "extend";
  if (
    !["extend", "clamp", "identity"].includes(left) ||
    !["extend", "clamp", "identity"].includes(right)
  )
    throw new RangeError("extrapolation must be extend, clamp or identity");
  const easing = options.easing ?? ((progress: number) => progress);
  if (typeof easing !== "function")
    throw new TypeError("easing must be a function");
  let segment = 0;
  while (segment < inputRange.length - 2 && value > inputRange[segment + 1]!)
    segment++;
  const minimum = inputRange[segment]!;
  const maximum = inputRange[segment + 1]!;
  let input = value;
  if (input < minimum) {
    if (left === "identity") return input;
    if (left === "clamp") input = minimum;
  }
  if (input > maximum) {
    if (right === "identity") return input;
    if (right === "clamp") input = maximum;
  }
  const outputMinimum = outputRange[segment]!;
  const outputMaximum = outputRange[segment + 1]!;
  if (outputMinimum === outputMaximum) return outputMinimum;
  const span = finite(maximum - minimum, "input segment span");
  const progress = finite((input - minimum) / span, "normalized progress");
  const eased = finite(easing(progress), "easing result");
  return finite(
    outputMinimum +
      eased * finite(outputMaximum - outputMinimum, "output segment span"),
    "interpolated value",
  );
}

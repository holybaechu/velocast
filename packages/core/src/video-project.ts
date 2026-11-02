export interface ProjectAsset {
  id: string;
  name: string;
  kind: "image" | "video" | "audio";
  src: string;
  durationSeconds?: number;
  width?: number;
  height?: number;
  /** Required for video assets; records whether the source contains an audio track. */
  hasAudio?: boolean;
}

export interface ProjectScene {
  id: string;
  name: string;
  from: number;
  durationFrames: number;
  background: string;
}

export interface ProjectLayer {
  id: string;
  name: string;
  kind: "text" | "shape" | "image" | "video" | "audio";
  sceneId?: string;
  from: number;
  durationFrames: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
  text?: string;
  fontSize?: number;
  fontFamily?: string;
  color?: string;
  assetId?: string;
  fit?: "contain" | "cover";
  trimBeforeFrames?: number;
  gain?: number;
  fadeInFrames?: number;
  fadeOutFrames?: number;
}

export interface ProjectComposition {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  durationFrames: number;
  background: string;
  scenes: ProjectScene[];
  layers: ProjectLayer[];
}

/** The editable, JSON-persisted source used by Studio, scripts, and rendering. */
export interface VideoProject {
  format: "velocast-project";
  version: 1;
  name: string;
  assets: ProjectAsset[];
  compositions: ProjectComposition[];
}

/** Recognizes project intent; call parseVideoProject to validate the contents. */
export function isVideoProject(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    (value as Record<string, unknown>).format === "velocast-project"
  );
}

export function parseVideoProject(value: unknown): VideoProject {
  const project = object(value, "project", [
    "format",
    "version",
    "name",
    "assets",
    "compositions",
  ]);
  if (project.format !== "velocast-project")
    invalid("project.format", "must be velocast-project");
  if (project.version !== 1) invalid("project.version", "must be 1");
  text(project.name, "project.name");
  const assets = list(project.assets, "project.assets").map((value, index) => {
    const path = `project.assets[${index}]`;
    const asset = object(value, path, [
      "id",
      "name",
      "kind",
      "src",
      "durationSeconds",
      "width",
      "height",
      "hasAudio",
    ]);
    identity(asset, path);
    choice(asset.kind, `${path}.kind`, ["image", "video", "audio"]);
    if (asset.kind === "video") {
      if (typeof asset.hasAudio !== "boolean")
        invalid(
          `${path}.hasAudio`,
          "must be a boolean declaring whether the video has an audio track",
        );
    } else if (Object.hasOwn(asset, "hasAudio"))
      invalid(`${path}.hasAudio`, "is only supported for video assets");
    text(asset.src, `${path}.src`);
    if (
      /[:\\%?#]/.test(asset.src) ||
      Array.from(asset.src).some((character) => character.charCodeAt(0) < 32) ||
      asset.src.split("/").some((part) => !part || /[. ]$/.test(part))
    )
      invalid(
        `${path}.src`,
        "must be a local relative path without traversal, URL syntax, or encoded characters",
      );
    for (const key of ["durationSeconds", "width", "height"])
      if (Object.hasOwn(asset, key))
        number(
          asset[key],
          `${path}.${key}`,
          key !== "durationSeconds",
          Number.MIN_VALUE,
        );
    return asset as unknown as ProjectAsset;
  });
  unique(assets, "project.assets");
  const compositions = list(project.compositions, "project.compositions").map(
    (value, index) => {
      const path = `project.compositions[${index}]`;
      const composition = object(value, path, [
        "id",
        "name",
        "width",
        "height",
        "fps",
        "durationFrames",
        "background",
        "scenes",
        "layers",
      ]);
      identity(composition, path);
      for (const key of ["width", "height", "durationFrames"])
        number(composition[key], `${path}.${key}`, true, 1);
      number(composition.fps, `${path}.fps`, true, 1);
      color(composition.background, `${path}.background`);
      const scenes = list(composition.scenes, `${path}.scenes`).map(
        (value, index) => {
          const scenePath = `${path}.scenes[${index}]`;
          const scene = object(value, scenePath, [
            "id",
            "name",
            "from",
            "durationFrames",
            "background",
          ]);
          identity(scene, scenePath);
          timing(
            scene,
            scenePath,
            composition.durationFrames as number,
            composition.id as string,
          );
          color(scene.background, `${scenePath}.background`);
          return scene as unknown as ProjectScene;
        },
      );
      unique(scenes, `${path}.scenes`);
      const ordered = [...scenes].sort((a, b) => a.from - b.from);
      for (let i = 1; i < ordered.length; i++) {
        const previous = ordered[i - 1]!,
          next = ordered[i]!;
        if (next.from < previous.from + previous.durationFrames)
          invalid(`${path}.scenes`, `${next.id} overlaps ${previous.id}`);
      }
      const layers = list(composition.layers, `${path}.layers`).map(
        (value, index) => {
          const layerPath = `${path}.layers[${index}]`;
          const layer = object(value, layerPath, [
            "id",
            "name",
            "kind",
            "sceneId",
            "from",
            "durationFrames",
            "x",
            "y",
            "width",
            "height",
            "rotation",
            "opacity",
            "text",
            "fontSize",
            "fontFamily",
            "color",
            "assetId",
            "fit",
            "trimBeforeFrames",
            "gain",
            "fadeInFrames",
            "fadeOutFrames",
          ]);
          identity(layer, layerPath);
          choice(layer.kind, `${layerPath}.kind`, [
            "text",
            "shape",
            "image",
            "video",
            "audio",
          ]);
          const scene = Object.hasOwn(layer, "sceneId")
            ? scenes.find(({ id }) => id === layer.sceneId)
            : undefined;
          if (Object.hasOwn(layer, "sceneId") && !scene)
            invalid(`${layerPath}.sceneId`, "must reference an existing scene");
          timing(
            layer,
            layerPath,
            scene?.durationFrames ?? (composition.durationFrames as number),
            scene?.id ?? (composition.id as string),
          );
          for (const key of ["x", "y", "rotation"])
            number(layer[key], `${layerPath}.${key}`);
          for (const key of ["width", "height"])
            number(layer[key], `${layerPath}.${key}`, false, Number.MIN_VALUE);
          number(layer.opacity, `${layerPath}.opacity`, false, 0, 1);
          if (layer.kind === "text")
            text(layer.text, `${layerPath}.text`, true);
          else if (Object.hasOwn(layer, "text"))
            text(layer.text, `${layerPath}.text`, true);
          if (Object.hasOwn(layer, "fontFamily"))
            text(layer.fontFamily, `${layerPath}.fontFamily`);
          if (Object.hasOwn(layer, "fontSize"))
            number(
              layer.fontSize,
              `${layerPath}.fontSize`,
              false,
              Number.MIN_VALUE,
            );
          if (Object.hasOwn(layer, "color"))
            color(layer.color, `${layerPath}.color`);
          if (Object.hasOwn(layer, "fit"))
            choice(layer.fit, `${layerPath}.fit`, ["contain", "cover"]);
          for (const key of [
            "trimBeforeFrames",
            "fadeInFrames",
            "fadeOutFrames",
          ])
            if (Object.hasOwn(layer, key))
              number(layer[key], `${layerPath}.${key}`, true, 0);
          if (
            !Number.isSafeInteger(
              ((layer.trimBeforeFrames as number | undefined) ?? 0) +
                (layer.durationFrames as number),
            )
          )
            invalid(
              `${layerPath}.trimBeforeFrames`,
              "plus durationFrames must remain a safe integer",
            );
          if (Object.hasOwn(layer, "gain"))
            number(layer.gain, `${layerPath}.gain`, false, 0);
          if (
            ["image", "video", "audio"].includes(layer.kind as string) ||
            Object.hasOwn(layer, "assetId")
          ) {
            const asset = assets.find(({ id }) => id === layer.assetId);
            if (!asset || asset.kind !== layer.kind)
              invalid(
                `${layerPath}.assetId`,
                `must reference an existing ${String(layer.kind)} asset`,
              );
            if (
              (layer.kind === "video" || layer.kind === "audio") &&
              asset.durationSeconds !== undefined &&
              (((layer.trimBeforeFrames as number | undefined) ?? 0) +
                (layer.durationFrames as number)) /
                (composition.fps as number) >
                asset.durationSeconds + 1e-6
            )
              invalid(
                layerPath,
                "trim and duration extend beyond the source duration",
              );
          }
          if (
            ((layer.fadeInFrames as number | undefined) ?? 0) +
              ((layer.fadeOutFrames as number | undefined) ?? 0) >
            (layer.durationFrames as number)
          )
            invalid(layerPath, "fade durations must fit within the layer");
          return layer as unknown as ProjectLayer;
        },
      );
      unique(layers, `${path}.layers`);
      return {
        ...composition,
        scenes,
        layers,
      } as unknown as ProjectComposition;
    },
  );
  if (!compositions.length)
    invalid("project.compositions", "must contain at least one composition");
  unique(compositions, "project.compositions");
  return structuredClone({
    ...project,
    assets,
    compositions,
  }) as unknown as VideoProject;
}

function invalid(path: string, reason: string): never {
  throw new Error(`project.invalid: ${path} ${reason}`);
}
function object(
  value: unknown,
  path: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid(path, "must be an object");
  for (const key of Object.keys(value))
    if (!keys.includes(key)) invalid(`${path}.${key}`, "is not supported");
  return value as Record<string, unknown>;
}
function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) invalid(path, "must be an array");
  return value;
}
function text(
  value: unknown,
  path: string,
  empty = false,
): asserts value is string {
  if (typeof value !== "string" || (!empty && !value.trim()))
    invalid(path, "must be a string" + (empty ? "" : " with content"));
}
function number(
  value: unknown,
  path: string,
  integer = false,
  minimum = -Infinity,
  maximum = Infinity,
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (integer && !Number.isSafeInteger(value)) ||
    value < minimum ||
    value > maximum
  )
    invalid(
      path,
      `must be a finite ${integer ? "safe integer" : "number"} between ${minimum} and ${maximum}`,
    );
}
function choice(value: unknown, path: string, choices: readonly string[]) {
  if (typeof value !== "string" || !choices.includes(value))
    invalid(path, `must be one of ${choices.join(", ")}`);
}
function identity(value: Record<string, unknown>, path: string) {
  text(value.id, `${path}.id`);
  if (!/^[a-z\d][a-z\d._-]{0,127}$/i.test(value.id))
    invalid(
      `${path}.id`,
      "must contain 1–128 letters, digits, dots, dashes, or underscores and start with a letter or digit",
    );
  text(value.name, `${path}.name`);
}
function unique(values: readonly { id: string }[], path: string) {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.id)) invalid(path, `contains duplicate id ${value.id}`);
    seen.add(value.id);
  }
}
function color(value: unknown, path: string) {
  if (typeof value !== "string" || !/^#[a-f\d]{6}([a-f\d]{2})?$/i.test(value))
    invalid(path, "must be a six- or eight-digit hex color");
}
function timing(
  value: Record<string, unknown>,
  path: string,
  parentDuration: number,
  parentId: string,
) {
  number(value.from, `${path}.from`, true, 0);
  number(value.durationFrames, `${path}.durationFrames`, true, 1);
  if (
    !Number.isSafeInteger(value.from + value.durationFrames) ||
    value.from + value.durationFrames > parentDuration
  )
    invalid(path, `ends outside parent ${parentId}`);
}

/** Convert a layer's parent-relative interval to composition frames. */
export function getProjectLayerRange(
  composition: ProjectComposition,
  layer: ProjectLayer,
): { start: number; end: number } {
  const scene =
    layer.sceneId === undefined
      ? undefined
      : composition.scenes.find(({ id }) => id === layer.sceneId);
  if (layer.sceneId !== undefined && !scene)
    throw new Error(
      `project.invalid: layer ${layer.id} refers to missing scene ${layer.sceneId}`,
    );
  const start = (scene?.from ?? 0) + layer.from;
  return { start, end: start + layer.durationFrames };
}

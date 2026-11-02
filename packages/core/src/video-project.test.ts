import { expect, it } from "vitest";
import {
  getProjectLayerRange,
  isVideoProject,
  parseVideoProject,
} from "./video-project.js";

function project() {
  return {
    format: "velocast-project",
    version: 1,
    name: "Product demo",
    assets: [
      {
        id: "voice",
        name: "Narration",
        kind: "audio",
        src: "assets/voice.wav",
        durationSeconds: 30,
      },
    ],
    compositions: [
      {
        id: "demo",
        name: "Demo",
        width: 1920,
        height: 1080,
        fps: 30,
        durationFrames: 900,
        background: "#101820",
        scenes: [
          {
            id: "intro",
            name: "Introduction",
            from: 300,
            durationFrames: 300,
            background: "#ffffff",
          },
        ],
        layers: [
          {
            id: "title",
            name: "Title",
            kind: "text",
            sceneId: "intro",
            from: 30,
            durationFrames: 240,
            x: 100,
            y: 100,
            width: 900,
            height: 200,
            rotation: 0,
            opacity: 1,
            text: "Hello",
            fontSize: 64,
            color: "#101820",
          },
        ],
      },
    ],
  };
}

it("loads an independent project snapshot and resolves scene-local layer timing", () => {
  const input = project();
  const loaded = parseVideoProject(input);
  input.compositions[0]!.layers[0]!.text = "Changed elsewhere";
  const composition = loaded.compositions[0]!;
  expect(composition.layers[0]!.text).toBe("Hello");
  expect(getProjectLayerRange(composition, composition.layers[0]!)).toEqual({
    start: 330,
    end: 570,
  });
});

it("requires explicit audio presence for video assets and rejects it on other media", () => {
  const input = project();
  const video = {
    id: "video",
    name: "Video",
    kind: "video",
    src: "assets/video.mp4",
  };
  expect(() => parseVideoProject({ ...input, assets: [video] })).toThrow(
    /assets\[0\]\.hasAudio.*boolean/,
  );
  for (const hasAudio of [false, true])
    expect(
      parseVideoProject({ ...input, assets: [{ ...video, hasAudio }] })
        .assets[0]!.hasAudio,
    ).toBe(hasAudio);
  expect(() =>
    parseVideoProject({ ...input, assets: [{ ...video, hasAudio: "false" }] }),
  ).toThrow(/hasAudio.*boolean/);
  expect(() =>
    parseVideoProject({
      ...input,
      assets: [{ ...input.assets[0], hasAudio: false }],
    }),
  ).toThrow(/hasAudio.*video/);
});

it("rejects invalid source before it can change frame bounds or saved project shape", () => {
  const input = project();
  expect(isVideoProject({ ...input, version: 99 })).toBe(true);
  expect(() => parseVideoProject({ ...input, version: 99 })).toThrow(
    /project\.version/,
  );
  expect(() => parseVideoProject({ ...input, hiddenState: true })).toThrow(
    /hiddenState/,
  );
  input.compositions[0]!.layers[0]!.durationFrames = 271;
  expect(() => parseVideoProject(input)).toThrow(/layers\[0\].*outside.*intro/);
  input.compositions[0]!.layers[0]!.durationFrames = 240;
  input.compositions[0]!.scenes.push({
    id: "overlap",
    name: "Overlap",
    from: 450,
    durationFrames: 120,
    background: "#ffffff",
  });
  expect(() => parseVideoProject(input)).toThrow(/overlap.*intro/);
});

it("rejects unsafe asset sources, unresolved media, and trims beyond the source", () => {
  const input = project();
  for (const src of [
    "../secret.wav",
    "https://example.org/voice.wav",
    "/voice.wav",
    "assets\\voice.wav",
    "assets/%2e%2e/voice.wav",
  ]) {
    input.assets[0]!.src = src;
    expect(() => parseVideoProject(input)).toThrow(/assets\[0\]\.src/);
  }
  input.assets[0]!.src = "assets/voice.wav";
  const layer = {
    ...input.compositions[0]!.layers[0]!,
    kind: "audio",
    assetId: "missing",
    trimBeforeFrames: 0,
  };
  const document = {
    ...input,
    compositions: [{ ...input.compositions[0], layers: [layer] }],
  };
  expect(() => parseVideoProject(document)).toThrow(/layers\[0\]\.assetId/);
  layer.assetId = "voice";
  layer.kind = "video";
  expect(() => parseVideoProject(document)).toThrow(/assetId.*video/);
  layer.kind = "audio";
  layer.trimBeforeFrames = 661;
  expect(() => parseVideoProject(document)).toThrow(
    /layers\[0\].*source duration/,
  );
  layer.trimBeforeFrames = 660;
  expect(parseVideoProject(document).compositions[0]!.layers[0]!.assetId).toBe(
    "voice",
  );
});

it("keeps empty canvases valid but rejects empty projects, duplicate IDs, and unsupported frame clocks", () => {
  const input = project();
  const blank = {
    ...input,
    compositions: [{ ...input.compositions[0], scenes: [], layers: [] }],
  };
  expect(parseVideoProject(blank).compositions[0]!.layers).toEqual([]);
  expect(() => parseVideoProject({ ...input, compositions: [] })).toThrow(
    /at least one composition/,
  );
  input.compositions[0]!.fps = 29.97;
  expect(() => parseVideoProject(input)).toThrow(/fps.*integer/);
  input.compositions[0]!.fps = 30;
  input.compositions[0]!.durationFrames = Number.MAX_SAFE_INTEGER + 1;
  expect(() => parseVideoProject(input)).toThrow(/durationFrames.*integer/);
  input.compositions[0]!.durationFrames = 900;
  input.compositions[0]!.layers.push({ ...input.compositions[0]!.layers[0]! });
  expect(() => parseVideoProject(input)).toThrow(/duplicate id title/);
  const media = {
    ...input.compositions[0]!.layers[0]!,
    kind: "audio",
    assetId: "voice",
    trimBeforeFrames: Number.MAX_SAFE_INTEGER,
  };
  const document = {
    ...input,
    assets: [{ ...input.assets[0]!, durationSeconds: undefined }],
    compositions: [{ ...input.compositions[0], layers: [media] }],
  };
  Reflect.deleteProperty(document.assets[0]!, "durationSeconds");
  expect(() => parseVideoProject(document)).toThrow(
    /trimBeforeFrames.*safe integer/,
  );
});

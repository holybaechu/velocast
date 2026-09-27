// @vitest-environment node
import { expect, it } from "vitest";
import {
  remotionCompatibilityViteConfig,
  withRemotionCompatibilityViteConfig,
} from "./bundler.js";
it("returns a Vite exact alias without affecting plugins and deduplicates React", () => {
  const settings = remotionCompatibilityViteConfig();
  expect(settings.resolve.alias[0]!.find.test("remotion")).toBe(true);
  expect(settings.resolve.alias[0]!.find.test("@remotion/media")).toBe(false);
  expect(settings.resolve.alias[0]!.replacement).toMatch(/remotion\.js$/);
  expect(settings.resolve.dedupe).toEqual(["react", "react-dom"]);
});

it("adds compatibility to an existing Vite config without losing its settings", () => {
  const plugin = { name: "existing-plugin" };
  const config = withRemotionCompatibilityViteConfig({
    plugins: [plugin],
    resolve: {
      alias: [{ find: "@src", replacement: "/src" }],
      dedupe: ["other"],
    },
  });
  expect(config.plugins).toEqual([plugin]);
  expect(config.resolve.alias).toHaveLength(2);
  expect(config.resolve.alias[0]!.find).toEqual(/^remotion$/);
  expect(config.resolve.alias[1]).toEqual({
    find: "@src",
    replacement: "/src",
  });
  expect(config.resolve.dedupe).toEqual(["react", "react-dom", "other"]);
});

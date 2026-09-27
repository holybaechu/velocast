import { expect, it } from "vitest";
import { SourceRefreshGate } from "./source-refresh.js";

it("waits for a settled build and avoids repeatedly loading a broken revision", () => {
  const gate = new SourceRefreshGate();
  expect(gate.observe("a", "b")).toBe(false);
  expect(gate.observe("a", "c")).toBe(false);
  expect(gate.observe("a", "c")).toBe(true);
  gate.reject("c");
  expect(gate.observe("a", "c")).toBe(false);
  expect(gate.observe("a", "d")).toBe(false);
  expect(gate.observe("a", "d")).toBe(true);
  expect(gate.observe("d", "d")).toBe(false);
});

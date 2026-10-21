import { expect, it } from "vitest";
import { importTimedText, validateTimedTextCues } from "./timestamps.js";

it("imports SRT and VTT boundaries without inventing or rewriting supplied text", () => {
  const srt = importTimedText(
    `1\n00:00:00,000 --> 00:00:01,250\nFirst supplied line\n\n2\n00:00:01,250 --> 00:00:02,000\nSecond\nline\n`,
    "srt",
  );
  expect(srt.cues).toEqual([
    { id: "1", startSeconds: 0, endSeconds: 1.25, text: "First supplied line" },
    { id: "2", startSeconds: 1.25, endSeconds: 2, text: "Second\nline" },
  ]);
  const vtt = importTimedText(
    `WEBVTT\n\nintro\n00:00.500 --> 00:02.000 align:start\n<v Singer>Exact words</v>`,
    "vtt",
  );
  expect(vtt.cues[0]).toEqual({
    id: "intro",
    startSeconds: 0.5,
    endSeconds: 2,
    text: "<v Singer>Exact words</v>",
  });
});

it("rejects invalid, reversed, and out-of-order transcript boundaries", () => {
  expect(() =>
    validateTimedTextCues([
      { id: "x", startSeconds: 2, endSeconds: 2, text: "word" },
    ]),
  ).toThrow("startSeconds < endSeconds");
  expect(() =>
    validateTimedTextCues([
      { id: "a", startSeconds: 2, endSeconds: 3, text: "a" },
      { id: "b", startSeconds: 1, endSeconds: 4, text: "b" },
    ]),
  ).toThrow("transcript.invalid_order");
  expect(() => importTimedText("00:bogus --> 00:02.000\nWords", "vtt")).toThrow(
    "transcript.invalid_timestamp",
  );
});

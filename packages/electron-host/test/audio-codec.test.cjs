"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { selectAudioEncoder } = require("../audio-codec.cjs");
const format = { sampleRate: 44100, numberOfChannels: 2 };
test("automatic audio prefers available AAC at the authored sample rate", async () => {
  const calls = [];
  const result = await selectAudioEncoder(
    "auto",
    format,
    async (codec, options) => {
      calls.push({ codec, options });
      return true;
    },
  );
  assert.equal(result.codec, "aac");
  assert.equal(result.sampleRate, 44100);
  assert.equal(result.fallbackUsed, false);
  assert.deepEqual(
    calls.map((call) => call.codec),
    ["aac"],
  );
});
test("unavailable AAC falls back to native 48 kHz Opus while retaining the source clock", async () => {
  const result = await selectAudioEncoder(
    "auto",
    format,
    async (codec, options) => codec === "opus" && options.sampleRate === 48000,
  );
  assert.equal(result.codec, "opus");
  assert.equal(result.sampleRate, 48000);
  assert.equal(result.sourceSampleRate, 44100);
  assert.equal(result.fallbackUsed, true);
});
test("an explicitly requested audio codec never silently falls back", async () => {
  const calls = [];
  await assert.rejects(
    selectAudioEncoder("aac", format, async (codec) => {
      calls.push(codec);
      return codec === "opus";
    }),
    /aac encoder is unavailable/,
  );
  assert.deepEqual(calls, ["aac"]);
  const opus = await selectAudioEncoder(
    "opus",
    format,
    async (codec) => codec === "opus",
  );
  assert.equal(opus.codec, "opus");
  assert.equal(opus.fallbackUsed, false);
  await assert.rejects(
    selectAudioEncoder("auto", format, async () => false),
    /AAC and Opus encoders are unavailable/,
  );
});

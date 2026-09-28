"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { createMediaSession } = require("../media-client.cjs");
const { inputFile, mb } = require("../media-io.cjs");
const { wavHeader } = require("../media-runtime.cjs");

test(
  "actual AAC packet padding must not shift authored stereo impulses",
  { timeout: 60000 },
  async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "velocast-aac-timing-"),
    );
    let session;
    try {
      const sampleRate = 48000,
        frames = 48000,
        expectedPeaks = [9600, 28800],
        pcm = Buffer.alloc(frames * 8);
      pcm.writeFloatLE(0.8, expectedPeaks[0] * 8);
      pcm.writeFloatLE(0.7, expectedPeaks[1] * 8 + 4);
      const source = path.join(directory, "impulses.wav"),
        encoded = path.join(directory, "aac.mp4"),
        decoded = path.join(directory, "decoded.f32");
      fs.writeFileSync(
        source,
        Buffer.concat([wavHeader(frames, sampleRate, 2), pcm]),
      );
      session = await createMediaSession({ timeoutMs: 30000 });
      let encodedMetadata;
      try {
        encodedMetadata = await session.run({
          kind: "encode-audio",
          path: source,
          outputPath: encoded,
          audioCodec: "aac",
        });
      } catch (error) {
        // Hosts without an AAC encoder still verify its explicit unavailable diagnostic;
        // macOS and Windows are expected to support the required AAC test format.
        if (
          process.platform !== "darwin" &&
          process.platform !== "win32" &&
          /audio_encoder_unavailable/.test(error.message)
        ) {
          assert.match(error.message, /aac encoder is unavailable/);
          return;
        }
        throw error;
      }
      const input = inputFile(encoded);
      let timing;
      try {
        const track = await input.getPrimaryAudioTrack(),
          packets = [];
        for await (const packet of new mb.EncodedPacketSink(track).packets(
          undefined,
          undefined,
          { metadataOnly: true },
        ))
          packets.push({
            timestamp: packet.timestamp,
            duration: packet.duration,
          });
        timing = {
          firstTimestamp: await track.getFirstTimestamp(),
          duration: await track.computeDuration(),
          packetCount: packets.length,
          firstPackets: packets.slice(0, 4),
          lastPackets: packets.slice(-4),
        };
      } finally {
        input.dispose();
      }
      const decodeMetadata = await session.run({
        kind: "decode-audio",
        path: encoded,
        outputPath: decoded,
        sampleRate,
        channels: 2,
        format: "f32",
      });
      const bytes = fs.readFileSync(decoded),
        peaks = [0, 0];
      for (let frame = 0; frame < bytes.length / 8; frame++)
        for (let channel = 0; channel < 2; channel++)
          if (
            Math.abs(bytes.readFloatLE(frame * 8 + channel * 4)) >
            Math.abs(bytes.readFloatLE(peaks[channel] * 8 + channel * 4))
          )
            peaks[channel] = frame;
      const evidence = {
        platform: process.platform,
        arch: process.arch,
        sampleRate,
        inputSamples: frames,
        encodedAudio: encodedMetadata.audio,
        timing,
        decodedSamples: decodeMetadata.samples,
        expectedPeaks,
        actualPeaks: peaks,
        shiftSamples: peaks.map(
          (peak, channel) => peak - expectedPeaks[channel],
        ),
      };
      console.log("AAC_TIMING_EVIDENCE " + JSON.stringify(evidence));
      assert.ok(
        Math.abs(peaks[0] - expectedPeaks[0]) <= 2,
        `AAC left impulse shifted by ${peaks[0] - expectedPeaks[0]} samples: ${JSON.stringify(evidence)}`,
      );
      assert.ok(
        Math.abs(peaks[1] - expectedPeaks[1]) <= 2,
        `AAC right impulse shifted by ${peaks[1] - expectedPeaks[1]} samples: ${JSON.stringify(evidence)}`,
      );
      assert.ok(
        Math.abs(timing.duration - frames / sampleRate) <= 2048 / sampleRate,
        `AAC presentation duration ${timing.duration}`,
      );
    } finally {
      await session?.close();
      const target = fs.realpathSync(directory);
      assert.equal(path.dirname(target), fs.realpathSync(os.tmpdir()));
      assert.ok(path.basename(target).startsWith("velocast-aac-timing-"));
      fs.rmSync(target, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 100,
      });
    }
  },
);

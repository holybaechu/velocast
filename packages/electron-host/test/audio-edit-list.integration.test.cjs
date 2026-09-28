"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { createMediaSession } = require("../media-client.cjs");
const { wavHeader } = require("../media-runtime.cjs");
const { inputFile, outputFile, mb } = require("../media-io.cjs");
test(
  "MP4 audio edit lists discard negative preroll without rebasing it into authored time",
  { timeout: 30000 },
  async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "velocast-audio-edit-list-"),
    );
    let session;
    try {
      const rate = 48000,
        prefix = 2112,
        frames = rate + prefix,
        pcm = Buffer.alloc(frames * 8),
        expected = [9600, 28800];
      pcm.writeFloatLE(0.8, (expected[0] + prefix) * 8);
      pcm.writeFloatLE(0.7, (expected[1] + prefix) * 8 + 4);
      const source = path.join(directory, "padded.wav"),
        encoded = path.join(directory, "encoded.mp4"),
        edited = path.join(directory, "edited.mp4"),
        decoded = path.join(directory, "decoded.f32");
      fs.writeFileSync(
        source,
        Buffer.concat([wavHeader(frames, rate, 2), pcm]),
      );
      session = await createMediaSession();
      const metadata = await session.run({
        kind: "encode-audio",
        path: source,
        outputPath: encoded,
      });
      const input = inputFile(encoded),
        sink = outputFile(edited);
      try {
        const track = await input.getPrimaryAudioTrack(),
          stream = new mb.EncodedAudioPacketSource(metadata.audio.codec),
          config = await track.getDecoderConfig();
        sink.output.addAudioTrack(stream);
        await sink.output.start();
        let count = 0;
        for await (const packet of new mb.EncodedPacketSink(track).packets())
          await stream.add(
            packet.clone({ timestamp: packet.timestamp - prefix / rate }),
            count++ ? undefined : { decoderConfig: config },
          );
        stream.close();
        await sink.output.finalize();
        sink.close();
      } finally {
        input.dispose();
      }
      const editedInput = inputFile(edited);
      try {
        const track = await editedInput.getPrimaryAudioTrack();
        assert.ok((await track.getFirstTimestamp()) < 0);
        assert.ok(Math.abs((await track.computeDuration()) - 1) < 2048 / rate);
      } finally {
        editedInput.dispose();
      }
      await session.run({
        kind: "decode-audio",
        path: edited,
        outputPath: decoded,
        sampleRate: rate,
        channels: 2,
        format: "f32",
      });
      const bytes = fs.readFileSync(decoded),
        peaks = [0, 0];
      for (let i = 0; i < bytes.length / 8; i++)
        for (let c = 0; c < 2; c++)
          if (
            Math.abs(bytes.readFloatLE(i * 8 + c * 4)) >
            Math.abs(bytes.readFloatLE(peaks[c] * 8 + c * 4))
          )
            peaks[c] = i;
      assert.ok(
        Math.abs(peaks[0] - expected[0]) <= 2,
        `left edit-list impulse ${peaks[0]} expected${expected[0]}`,
      );
      assert.ok(
        Math.abs(peaks[1] - expected[1]) <= 2,
        `right edit-list impulse ${peaks[1]} expected${expected[1]}`,
      );
    } finally {
      await session?.close();
      const absolute = fs.realpathSync(directory);
      assert.equal(path.dirname(absolute), fs.realpathSync(os.tmpdir()));
      assert.ok(
        path.basename(absolute).startsWith("velocast-audio-edit-list-"),
      );
      fs.rmSync(absolute, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 100,
      });
    }
  },
);

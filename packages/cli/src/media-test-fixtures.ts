import { deflateSync } from "node:zlib";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runMediaOperation } from "./media-runtime.js";

/** Generated PCM fixture: no external encoders or fixture downloads. */
export async function writeTestWav(
  path: string,
  duration = 2,
  sampleRate = 11025,
  channels = 1,
): Promise<void> {
  const count = Math.round(duration * sampleRate),
    bytes = Buffer.alloc(44 + count * channels * 4);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(3, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * channels * 4, 28);
  bytes.writeUInt16LE(channels * 4, 32);
  bytes.writeUInt16LE(32, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(count * channels * 4, 40);
  for (let index = 0; index < count; index++)
    for (let channel = 0; channel < channels; channel++) {
      const t = index / sampleRate;
      bytes.writeFloatLE(
        t % 0.5 < 0.06 ? 0.8 * Math.sin(2 * Math.PI * 440 * t) : 0,
        44 + (index * channels + channel) * 4,
      );
    }
  await writeFile(path, bytes);
}
function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type),
    payload = Buffer.concat([name, data]);
  let crc = 0xffffffff;
  for (const byte of payload) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length);
  payload.copy(output, 4);
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4);
  return output;
}
export async function writeTestPng(
  path: string,
  width: number,
  height: number,
  color: readonly number[],
): Promise<void> {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      for (let c = 0; c < 4; c++)
        rows[y * (1 + width * 4) + 1 + x * 4 + c] = color[c] ?? 255;
  await writeFile(
    path,
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(rows)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}
export async function writeTestVideo(
  outputPath: string,
  directory: string,
  options: {
    width?: number;
    height?: number;
    frames?: number;
    fps?: number;
    timestamps?: number[];
    rotation?: number;
  } = {},
): Promise<void> {
  const width = options.width ?? 64,
    height = options.height ?? 64,
    frames = options.frames ?? 30,
    fps = options.fps ?? 30;
  const paths: string[] = [];
  for (let index = 0; index < frames; index++) {
    const path = join(directory, `fixture-${width}-${height}-${index}.png`);
    await writeTestPng(path, width, height, [
      255 - (index % 200),
      index % 200,
      (index * 7) % 255,
      255,
    ]);
    paths.push(path);
  }
  await runMediaOperation({
    kind: "encode-frames",
    framePaths: paths,
    fps,
    width,
    height,
    bitrate: 1_000_000,
    codec: "h264",
    outputPath,
    ...(options.timestamps ? { timestamps: options.timestamps } : {}),
    ...(options.rotation ? { rotation: options.rotation } : {}),
  });
}

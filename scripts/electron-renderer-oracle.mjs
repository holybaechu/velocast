export const WIDTH = 192;
export const HEIGHT = 108;
export const FPS = 12;
export const FRAME_STATES = Object.freeze([
  0, 1, 2, 3, 3, 3, 2, 1, 0, 0, 0, 1, 2, 3, 2, 1, 0, 1, 2, 2, 2, 3, 1, 0,
]);
export const COLORS = Object.freeze([
  [32, 64, 192],
  [192, 48, 64],
  [48, 176, 80],
  [176, 144, 32],
]);

const pixel = (bytes, frame, x, y, width, height) => {
  const at = ((frame * height + y) * width + x) * 4;
  return [bytes[at], bytes[at + 1], bytes[at + 2]];
};

export function assertFrameOracle(
  bytes,
  expectedFrames = FRAME_STATES.map((_, i) => i),
  { width = WIDTH, height = HEIGHT, states = FRAME_STATES } = {},
) {
  const stride = width * height * 4;
  if (bytes.length !== stride * expectedFrames.length)
    throw new Error(
      `decoded byte count ${bytes.length}; expected ${stride * expectedFrames.length}`,
    );
  const sx = (x) => Math.floor((x * width) / WIDTH);
  const sy = (y) => Math.floor((y * height) / HEIGHT);
  for (const [position, frame] of expectedFrames.entries()) {
    const state = states[frame];
    if (state === undefined) throw new Error(`invalid expected frame ${frame}`);
    const actualColor = pixel(bytes, position, sx(170), sy(30), width, height);
    const expectedColor = COLORS[state];
    for (let channel = 0; channel < 3; channel++)
      if (Math.abs(actualColor[channel] - expectedColor[channel]) > 25)
        throw new Error(
          `frame ${position}: visual state ${state}, channel ${channel}: ${actualColor[channel]} versus ${expectedColor[channel]}`,
        );
    // A separate binary strip changes even across the static stretches. It catches
    // a duplicated paint that a scene-level image comparison would miss.
    for (let bit = 0; bit < 8; bit++) {
      const actual = pixel(
        bytes,
        position,
        sx(8 + bit * 20 + 5),
        sy(98),
        width,
        height,
      );
      const white = ((frame >> bit) & 1) === 1;
      if (actual.some((value) => (white ? value < 205 : value > 50)))
        throw new Error(
          `frame ${position}: identity bit ${bit} does not encode source frame ${frame}`,
        );
    }
  }
}

export function assertMediaTiming(
  media,
  decodedAudioSamples,
  expectedFrames,
  fps = FPS,
) {
  const expectedSeconds = expectedFrames / fps;
  const expectedSamples = Math.round(expectedSeconds * 48000);
  const video = media.streams.find((stream) => stream.codec_type === "video");
  const audio = media.streams.find((stream) => stream.codec_type === "audio");
  if (!video || !audio) throw new Error("missing video/audio stream");
  if (
    !Number.isFinite(Number(video.start_time)) ||
    Math.abs(Number(video.start_time)) > 0.005
  )
    throw new Error(`video PTS was not rebased: ${video.start_time}`);
  if (
    !Number.isFinite(Number(audio.start_time)) ||
    Math.abs(Number(audio.start_time)) > 0.05
  )
    throw new Error(`audio PTS was not rebased: ${audio.start_time}`);
  if (
    !Number.isFinite(Number(media.format.duration)) ||
    Math.abs(Number(media.format.duration) - expectedSeconds) > 0.1
  )
    throw new Error(
      `media duration ${media.format.duration}; expected ${expectedSeconds}`,
    );
  if (Math.abs(decodedAudioSamples - expectedSamples) > 2048)
    throw new Error(
      `decoded audio samples ${decodedAudioSamples}; expected about ${expectedSamples}`,
    );
}

export async function* splitRawFrames(chunks, stride) {
  if (!Number.isSafeInteger(stride) || stride <= 0)
    throw new Error("invalid raw frame stride");
  let frame = Buffer.allocUnsafe(stride),
    filled = 0;
  for await (const chunk of chunks) {
    for (let offset = 0; offset < chunk.length;) {
      const count = Math.min(stride - filled, chunk.length - offset);
      chunk.copy(frame, filled, offset, offset + count);
      filled += count;
      offset += count;
      if (filled === stride) {
        yield frame;
        frame = Buffer.allocUnsafe(stride);
        filled = 0;
      }
    }
  }
  if (filled) throw new Error(`partial decoded frame: ${filled} bytes`);
}

export function cancellationMarkerPath(eventPath, nativePid) {
  if (!Number.isSafeInteger(nativePid) || nativePid <= 0)
    throw new Error("invalid native process id");
  return `${eventPath}.${nativePid}.cancel`;
}

export function firstRenderedFrame(eventText) {
  for (const line of eventText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    } // Final write may be partial.
    if (
      event?.event === "frame_rendered" &&
      Number.isSafeInteger(event.frame) &&
      event.frame >= 0
    )
      return event.frame;
  }
  return null;
}

export function median(values) {
  if (!values.length || values.some((value) => !Number.isFinite(value)))
    throw new Error("median requires finite values");
  const ordered = [...values].sort((a, b) => a - b),
    middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

export function assertGpuTelemetry(report, backend, expectedFrames) {
  if (backend !== "electron")
    throw new Error("Only the Electron browser host is supported");
  const capture = "electron_d3d11_shared_texture";
  if (report.capture_backend !== capture)
    throw new Error(
      `capture_backend ${report.capture_backend}; expected ${capture}`,
    );
  if (
    !["d3d11_video_processor", "d3d11_shader_nv12"].includes(
      report.conversion_backend,
    )
  )
    throw new Error(
      `conversion_backend ${report.conversion_backend} is not D3D11 GPU conversion`,
    );
  if (
    !/^(h264|hevc|av1)_(amf|nvenc|qsv|mf)$/.test(report.encoder_backend ?? "")
  )
    throw new Error(
      `encoder_backend ${report.encoder_backend} is not a Windows hardware encoder`,
    );
  if (
    report.cpu_readback_frames !== 0 ||
    report.fallback_used ||
    report.dropped_frames !== 0 ||
    report.stale_frames !== 0
  )
    throw new Error(
      `GPU fallback/readback/drop/stale: ${JSON.stringify(report)}`,
    );
  for (const field of ["frames_expected", "frames_rendered", "frames_encoded"])
    if (report[field] !== expectedFrames)
      throw new Error(`${field} ${report[field]}; expected ${expectedFrames}`);
  if (report.surface_format_encoder !== "nv12")
    throw new Error(`surface_format_encoder ${report.surface_format_encoder}`);
  if (!(report.total_wall_ms > 0))
    throw new Error("native total_wall_ms was not positive");
}

export function assertComparable(first, second) {
  for (const field of [
    "sourceVersion",
    "codec_name",
    "pix_fmt",
    "color_range",
    "color_space",
    "width",
    "height",
    "sample_rate",
    "channels",
  ])
    if (first[field] !== second[field])
      throw new Error(
        `${field} differs: first=${first[field]} second=${second[field]}`,
      );
  for (const field of [
    "encoder_backend",
    "selected_codec",
    "target_bitrate_bps",
    "surface_format_encoder",
  ])
    if (first.telemetry[field] !== second.telemetry[field])
      throw new Error(
        `telemetry ${field} differs: first=${first.telemetry[field]} second=${second.telemetry[field]}`,
      );
  if (first.audioSignal && second.audioSignal) {
    if (Math.abs(first.audioSignal.samples - second.audioSignal.samples) > 1024)
      throw new Error(
        `decoded audio sample counts differ: ${first.audioSignal.samples} versus ${second.audioSignal.samples}`,
      );
    const ratio = second.audioSignal.rms / first.audioSignal.rms;
    if (ratio < 0.9 || ratio > 1.1)
      throw new Error(`decoded audio RMS differs: ${ratio}`);
  }
}

export function compareDecodedPixels(
  first,
  second,
  { maxMae = 8, maxOutlierFraction = 0.01 } = {},
) {
  if (first.length !== second.length || first.length % 4)
    throw new Error(
      `decoded pixel buffers differ in length: ${first.length} versus ${second.length}`,
    );
  let totalError = 0,
    outliers = 0,
    maximumError = 0;
  const pixels = first.length / 4;
  for (let offset = 0; offset < first.length; offset += 4) {
    let pixelError = 0;
    for (let channel = 0; channel < 3; channel++) {
      const error = Math.abs(
        first[offset + channel] - second[offset + channel],
      );
      totalError += error;
      pixelError = Math.max(pixelError, error);
      maximumError = Math.max(maximumError, error);
    }
    if (pixelError > 32) outliers++;
  }
  const stats = {
    mae: totalError / (pixels * 3),
    outlierFraction: outliers / pixels,
    maximumError,
  };
  if (stats.mae > maxMae || stats.outlierFraction > maxOutlierFraction)
    throw new Error(`decoded pixel mismatch: ${JSON.stringify(stats)}`);
  return stats;
}

"use strict";
const { AUDIO_CODECS } = require("./media-settings.cjs");

async function selectAudioEncoder(requested = "auto", format, isSupported) {
  if (!["auto", ...AUDIO_CODECS].includes(requested)) {
    throw new Error("media.invalid_audio_codec");
  }
  const candidates = ["webm", "mkv"].includes(format.container)
    ? ["opus", "aac"]
    : ["aac", "opus"];
  for (const codec of requested === "auto" ? candidates : [requested]) {
    if (format.container === "webm" && !["opus", "vorbis"].includes(codec))
      continue;
    // Opus timestamps and MP4 playback use the native 48 kHz clock. Resampling
    // is performed explicitly by the filtered streaming PCM path before encode.
    const sampleRate = codec === "opus" ? 48000 : format.sampleRate;
    const options = {
      sampleRate,
      numberOfChannels: format.numberOfChannels,
      ...(!codec.startsWith("pcm-") && codec !== "flac"
        ? { bitrate: 192000 }
        : {}),
    };
    if (await isSupported(codec, options)) {
      return {
        codec,
        ...options,
        requestedCodec: requested,
        sourceSampleRate: format.sampleRate,
        fallbackUsed: requested === "auto" && codec !== candidates[0],
      };
    }
  }
  throw new Error(
    `media.audio_encoder_unavailable: ${requested === "auto" ? "AAC and Opus encoders are unavailable" : `${requested} encoder is unavailable`} for ${format.numberOfChannels} channels`,
  );
}

module.exports = { selectAudioEncoder };

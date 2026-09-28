"use strict";

async function selectAudioEncoder(requested = "auto", format, isSupported) {
  if (!["auto", "aac", "opus"].includes(requested)) {
    throw new Error("media.invalid_audio_codec: use auto, aac or opus");
  }
  for (const codec of requested === "auto" ? ["aac", "opus"] : [requested]) {
    // Opus timestamps and MP4 playback use the native 48 kHz clock. Resampling
    // is performed explicitly by the filtered streaming PCM path before encode.
    const sampleRate = codec === "opus" ? 48000 : format.sampleRate;
    const options = {
      sampleRate,
      numberOfChannels: format.numberOfChannels,
      bitrate: 192000,
    };
    if (await isSupported(codec, options)) {
      return {
        codec,
        ...options,
        requestedCodec: requested,
        sourceSampleRate: format.sampleRate,
        fallbackUsed: requested === "auto" && codec === "opus",
      };
    }
  }
  throw new Error(
    `media.audio_encoder_unavailable: ${requested === "auto" ? "AAC and Opus encoders are unavailable" : `${requested} encoder is unavailable`} for ${format.numberOfChannels} channels`,
  );
}

module.exports = { selectAudioEncoder };

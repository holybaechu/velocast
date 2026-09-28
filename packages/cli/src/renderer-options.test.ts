import type { Config } from "@velocast/core";
import { describe, expect, it } from "vitest";
import {
  parseCliAcceleration,
  parseCliAssemblyMode,
  parseCliBitrate,
  parseCliConcurrency,
  parseCliCodec,
  resolveRendererAudioCodec,
  resolveRendererAcceleration,
  resolveRendererAssemblyMode,
  resolveRendererBitrate,
  resolveRendererCodec,
  resolveRendererContainer,
  resolveRendererConcurrency,
  resolveRendererMediaBackend,
  resolveRendererPixelFormat,
  resolveRendererVideoProfile,
} from "./renderer-options.js";

describe("parseCliConcurrency", () => {
  it("parses numeric CLI concurrency", () => {
    expect(parseCliConcurrency("4")).toBe(4);
  });

  it("trims CLI concurrency values", () => {
    expect(parseCliConcurrency(" 4 ")).toBe(4);
    expect(parseCliConcurrency(" auto ")).toBe("auto");
  });

  it("parses auto CLI concurrency", () => {
    expect(parseCliConcurrency("auto")).toBe("auto");
  });

  it("rejects invalid CLI concurrency", () => {
    expect(() => parseCliConcurrency("0")).toThrow(
      "--concurrency must be a positive integer or auto",
    );
  });

  it("rejects non-decimal CLI concurrency syntax", () => {
    for (const value of ["0x10", "1e2", "1.5"]) {
      expect(() => parseCliConcurrency(value)).toThrow(
        "--concurrency must be a positive integer or auto",
      );
    }
  });

  it("rejects unsafe CLI concurrency integers", () => {
    expect(() =>
      parseCliConcurrency(String(Number.MAX_SAFE_INTEGER + 1)),
    ).toThrow("--concurrency must be a positive integer or auto");
  });

  it("rejects non-string CLI concurrency parser edge cases", () => {
    expect(() => parseCliConcurrency(true as unknown as string)).toThrow(
      "--concurrency must be a positive integer or auto",
    );
  });
});

describe("resolveRendererConcurrency", () => {
  it("uses CLI value before config value", () => {
    expect(
      resolveRendererConcurrency({ renderer: { concurrency: 2 } }, "6"),
    ).toBe(6);
  });

  it("uses config value when CLI value is absent", () => {
    expect(
      resolveRendererConcurrency({ renderer: { concurrency: "auto" } }),
    ).toBe("auto");
  });

  it("returns undefined when neither CLI nor config sets concurrency", () => {
    expect(resolveRendererConcurrency({})).toBeUndefined();
  });

  it("rejects invalid config concurrency", () => {
    expect(() =>
      resolveRendererConcurrency({
        renderer: { concurrency: 0 },
      } as unknown as Config),
    ).toThrow("renderer.concurrency must be a positive integer or auto");
  });

  it("rejects unsafe config concurrency integers", () => {
    expect(() =>
      resolveRendererConcurrency({
        renderer: { concurrency: Number.MAX_SAFE_INTEGER + 1 },
      }),
    ).toThrow("renderer.concurrency must be a positive integer or auto");
  });
});

describe("parseCliAcceleration", () => {
  it("parses required acceleration", () => {
    expect(parseCliAcceleration("required")).toBe("required");
  });

  it("parses auto acceleration", () => {
    expect(parseCliAcceleration("auto")).toBe("auto");
  });

  it("parses off acceleration", () => {
    expect(parseCliAcceleration("off")).toBe("off");
  });

  it("trims CLI acceleration values", () => {
    expect(parseCliAcceleration(" auto ")).toBe("auto");
  });

  it("rejects invalid CLI acceleration", () => {
    expect(() => parseCliAcceleration("gpu")).toThrow(
      "--acceleration must be required, auto, or off",
    );
  });

  it("rejects non-string CLI acceleration parser edge cases", () => {
    expect(() => parseCliAcceleration(true as unknown as string)).toThrow(
      "--acceleration must be required, auto, or off",
    );
  });
});

describe("parseCliAssemblyMode", () => {
  it("parses assembly mode", () => {
    expect(parseCliAssemblyMode("segments")).toBe("segments");
    expect(parseCliAssemblyMode("reference")).toBe("reference");
    expect(parseCliAssemblyMode("auto")).toBe("auto");
  });

  it("trims CLI assembly mode values", () => {
    expect(parseCliAssemblyMode(" reference ")).toBe("reference");
  });

  it("rejects invalid assembly mode", () => {
    expect(() => parseCliAssemblyMode("fast")).toThrow(
      "--assembly must be auto, reference, or segments",
    );
  });

  it("rejects non-string CLI assembly parser edge cases", () => {
    expect(() => parseCliAssemblyMode(true as unknown as string)).toThrow(
      "--assembly must be auto, reference, or segments",
    );
  });
});

describe("parseCliBitrate", () => {
  it("parses bitrate suffixes as bits per second", () => {
    expect(parseCliBitrate("60M")).toBe(60_000_000);
    expect(parseCliBitrate("12000k")).toBe(12_000_000);
  });

  it("parses bitrate bps suffixes case-insensitively", () => {
    expect(parseCliBitrate("60MBPS")).toBe(60_000_000);
    expect(parseCliBitrate("12000kbps")).toBe(12_000_000);
  });

  it("rejects invalid CLI bitrates", () => {
    expect(() => parseCliBitrate("fast")).toThrow(
      "--bitrate must be a positive bitrate such as 60M or 12000k",
    );
  });

  it("rejects unsafe CLI bitrate integers", () => {
    expect(() => parseCliBitrate(String(Number.MAX_SAFE_INTEGER + 1))).toThrow(
      "--bitrate must be a positive bitrate such as 60M or 12000k",
    );
  });

  it("rejects non-string CLI bitrate parser edge cases", () => {
    expect(() => parseCliBitrate(60_000_000 as unknown as string)).toThrow(
      "--bitrate must be a positive bitrate such as 60M or 12000k",
    );
  });
});

describe("parseCliCodec", () => {
  it("trims CLI codec values", () => {
    expect(parseCliCodec(" hevc ")).toBe("hevc");
    expect(parseCliCodec(" av1 ")).toBe("av1");
    expect(parseCliCodec(" H265 ")).toBe("hevc");
    expect(parseCliCodec(" H264 ")).toBe("h264");
  });

  it("rejects blank CLI codec", () => {
    expect(() => parseCliCodec(" ")).toThrow(
      "--codec must be a non-empty string",
    );
  });

  it("rejects non-string CLI codec parser edge cases", () => {
    expect(() => parseCliCodec(true as unknown as string)).toThrow(
      "--codec must be a non-empty string",
    );
  });
});

describe("resolveRendererBitrate", () => {
  it("uses CLI bitrate before config bitrate", () => {
    expect(
      resolveRendererBitrate({ renderer: { bitrate: "40M" } }, "60M"),
    ).toBe(60_000_000);
  });

  it("uses config bitrate when CLI bitrate is absent", () => {
    expect(resolveRendererBitrate({ renderer: { bitrate: "40M" } })).toBe(
      40_000_000,
    );
  });

  it("still accepts numeric config bitrates", () => {
    expect(resolveRendererBitrate({ renderer: { bitrate: 60_000_000 } })).toBe(
      60_000_000,
    );
  });

  it("rejects unsafe numeric config bitrates", () => {
    expect(() =>
      resolveRendererBitrate({
        renderer: { bitrate: Number.MAX_SAFE_INTEGER + 1 },
      }),
    ).toThrow(
      "renderer.bitrate must be a positive bitrate such as 60M or 12000k",
    );
  });
});

describe("resolveRendererCodec", () => {
  it("rejects blank renderer codecs", () => {
    expect(() =>
      resolveRendererCodec({ renderer: { codec: " " } } as unknown as Config),
    ).toThrow("renderer.codec must be a non-empty string");
  });

  it("trims configured renderer codecs", () => {
    expect(
      resolveRendererCodec({
        renderer: { codec: " hevc " },
      } as unknown as Config),
    ).toBe("hevc");
  });

  it("uses config codec when CLI codec is absent", () => {
    expect(resolveRendererCodec({ renderer: { codec: "hevc" } })).toBe("hevc");
  });

  it("uses CLI codec before configured renderer codec", () => {
    expect(resolveRendererCodec({ renderer: { codec: "hevc" } }, " av1 ")).toBe(
      "av1",
    );
  });

  it("accepts only the advertised logical video codecs", () => {
    for (const codec of ["h264", "hevc", "av1", "vp8", "vp9", "prores"])
      expect(parseCliCodec(codec)).toBe(codec);
    expect(() => parseCliCodec("mjpeg")).toThrow(
      "expected h264, hevc, av1, vp8, vp9, or prores",
    );
  });
});

describe("media format options", () => {
  it("resolves format options with CLI-over-config precedence", () => {
    const config: Config = {
      renderer: {
        container: "mov",
        audioCodec: "aac",
        mediaBackend: "webcodecs",
        videoProfile: "prores_ks",
      },
    };
    expect(resolveRendererContainer(config, "webm")).toBe("webm");
    expect(resolveRendererAudioCodec(config, "flac")).toBe("flac");
    expect(resolveRendererMediaBackend(config, "native")).toBe("native");
    expect(resolveRendererVideoProfile(config, "prores_4444")).toBe(
      "prores_4444",
    );
  });

  it("uses configured values and leaves runtime-inferred defaults omitted", () => {
    expect(resolveRendererContainer({ renderer: { container: "mkv" } })).toBe(
      "mkv",
    );
    expect(
      resolveRendererAudioCodec({ renderer: { audioCodec: "pcm-f32" } }),
    ).toBe("pcm-f32");
    expect(
      resolveRendererMediaBackend({ renderer: { mediaBackend: "native" } }),
    ).toBe("native");
    expect(resolveRendererContainer({})).toBeUndefined();
    expect(resolveRendererAudioCodec({})).toBeUndefined();
    expect(resolveRendererMediaBackend({})).toBeUndefined();
  });

  it("rejects invalid enumerated options and blank video profiles", () => {
    expect(() => resolveRendererContainer({}, "avi")).toThrow(
      "--container must be",
    );
    expect(() => resolveRendererAudioCodec({}, "pcm-s8")).toThrow(
      "--audio-codec must be",
    );
    expect(() => resolveRendererMediaBackend({}, "ffmpeg")).toThrow(
      "--media-backend must be",
    );
    expect(() => resolveRendererVideoProfile({}, " ")).toThrow(
      "--video-profile must be a non-empty string",
    );
    expect(() =>
      resolveRendererContainer({
        renderer: { container: "avi" },
      } as unknown as Config),
    ).toThrow("renderer.container must be");
  });
});

describe("resolveRendererAssemblyMode", () => {
  it("uses CLI assembly mode before config assembly mode", () => {
    expect(
      resolveRendererAssemblyMode(
        { renderer: { assembly: "reference" } },
        "segments",
      ),
    ).toBe("segments");
  });

  it("uses config assembly mode when CLI assembly mode is absent", () => {
    expect(
      resolveRendererAssemblyMode({ renderer: { assembly: "reference" } }),
    ).toBe("reference");
  });

  it("rejects invalid config assembly mode", () => {
    expect(() =>
      resolveRendererAssemblyMode({
        renderer: { assembly: "fast" },
      } as unknown as Config),
    ).toThrow("renderer.assembly must be auto, reference, or segments");
  });
});

describe("resolveRendererAcceleration", () => {
  it("uses CLI acceleration before config acceleration", () => {
    expect(
      resolveRendererAcceleration(
        { renderer: { acceleration: "off" } },
        "required",
      ),
    ).toBe("required");
  });

  it("uses config acceleration when CLI acceleration is absent", () => {
    expect(
      resolveRendererAcceleration({ renderer: { acceleration: "required" } }),
    ).toBe("required");
  });

  it("defaults acceleration to auto so installs can fall back when GPU setup is unavailable", () => {
    expect(resolveRendererAcceleration({})).toBe("auto");
  });

  it("rejects invalid config acceleration", () => {
    expect(() =>
      resolveRendererAcceleration({
        renderer: { acceleration: "gpu" },
      } as unknown as Config),
    ).toThrow("renderer.acceleration must be required, auto, or off");
  });
});

describe("resolveRendererPixelFormat", () => {
  it("uses broad defaults while retaining explicit pixel format requests", () => {
    expect(resolveRendererPixelFormat({}, undefined, "auto")).toBe("yuv420p");
    expect(resolveRendererPixelFormat({}, undefined, "off")).toBe("yuv420p");
    expect(
      resolveRendererPixelFormat(
        { renderer: { pixelFormat: "yuv444p" } },
        undefined,
        "auto",
      ),
    ).toBe("yuv444p");
  });

  it("defaults to yuv420p for required acceleration", () => {
    expect(resolveRendererPixelFormat({}, undefined, "required")).toBe(
      "yuv420p",
    );
  });

  it("uses a 10-bit 4:2:2 default for ProRes", () => {
    expect(resolveRendererPixelFormat({}, undefined, "off", "prores")).toBe(
      "yuv422p10le",
    );
  });

  it("accepts yuv420p for required acceleration", () => {
    expect(
      resolveRendererPixelFormat(
        { renderer: { pixelFormat: "yuv420p" } },
        undefined,
        "required",
      ),
    ).toBe("yuv420p");
  });

  it("normalizes required hardware pixel format casing", () => {
    expect(resolveRendererPixelFormat({}, " NV12 ", "required")).toBe("nv12");
    expect(
      resolveRendererPixelFormat(
        { renderer: { pixelFormat: "YUV420P" } },
        undefined,
        "required",
      ),
    ).toBe("yuv420p");
  });

  it("trims CLI pixel format values", () => {
    expect(resolveRendererPixelFormat({}, " nv12 ", "required")).toBe("nv12");
    expect(resolveRendererPixelFormat({}, " rgb24 ", "off")).toBe("rgb24");
  });

  it("keeps configured pixel format values strict", () => {
    expect(() =>
      resolveRendererPixelFormat(
        { renderer: { pixelFormat: " nv12 " } },
        undefined,
        "required",
      ),
    ).toThrow(
      "accelerated rendering currently supports nv12/yuv420p output, but  nv12  was requested.\nUse --pixel-format nv12, or use --acceleration off for the software BGRA path.",
    );
  });

  it("rejects yuv444p for required acceleration", () => {
    expect(() =>
      resolveRendererPixelFormat(
        { renderer: { pixelFormat: "yuv444p" } },
        undefined,
        "required",
      ),
    ).toThrow(
      "accelerated rendering currently supports nv12/yuv420p output, but yuv444p was requested.\nUse --pixel-format nv12, or use --acceleration off for the software BGRA path.",
    );
  });

  it("rejects an empty configured pixel format", () => {
    expect(() =>
      resolveRendererPixelFormat(
        { renderer: { pixelFormat: "" } },
        undefined,
        "auto",
      ),
    ).toThrow("renderer.pixelFormat must be a non-empty string");
  });

  it("rejects a non-string configured pixel format", () => {
    expect(() =>
      resolveRendererPixelFormat(
        { renderer: { pixelFormat: 123 } } as unknown as Config,
        undefined,
        "auto",
      ),
    ).toThrow("renderer.pixelFormat must be a non-empty string");
  });

  it("rejects a non-string CLI pixel format", () => {
    expect(() =>
      resolveRendererPixelFormat({}, 123 as unknown as string, "auto"),
    ).toThrow("renderer.pixelFormat must be a non-empty string");
  });
});

it.each(["h264_vaapi", "hevc_vaapi", "av1_vaapi"])(
  "rejects retired codec %s in CLI and config before launch",
  (codec) => {
    expect(() => parseCliCodec(codec)).toThrow("encoder.codec_unavailable");
    expect(() =>
      resolveRendererCodec({ renderer: { codec } } as unknown as Config),
    ).toThrow("encoder.codec_unavailable");
  },
);

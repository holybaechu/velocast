import { describe, expect, it } from "vitest";
import {
  extractKnownRendererError,
  extractRendererReportSuccessWarning,
  extractRendererSuccessWarning,
} from "./renderer-output.js";

describe("extractKnownRendererError", () => {
  it("extracts exact accelerated paint timeout messages from renderer output", () => {
    expect(
      extractKnownRendererError(
        "2026-05-15T12:00:00Z INFO renderer\nError: frame 0 timed out waiting for accelerated paint\n",
      ),
    ).toBe("frame 0 timed out waiting for accelerated paint");
  });

  it("extracts exact ffmpeg exit messages from renderer output", () => {
    expect(
      extractKnownRendererError(
        "thread main failed\nError: ffmpeg exited with code 234\n",
      ),
    ).toBe("ffmpeg exited with code 234");
  });

  it("extracts segment remux failure messages from renderer output", () => {
    expect(
      extractKnownRendererError(
        "INFO muxing segments\nError: ffmpeg segment remux failed with code 1: Invalid data found when processing input\n",
      ),
    ).toBe(
      "ffmpeg segment remux failed with code 1: Invalid data found when processing input",
    );
  });

  it("extracts required GPU benchmark validation failures from renderer output", () => {
    expect(
      extractKnownRendererError(
        "INFO renderer\nError: required GPU benchmark expected positive total_wall_ms, got 0\n",
      ),
    ).toBe("required GPU benchmark expected positive total_wall_ms, got 0");
  });

  it("extracts segment worker compatibility validation failures from renderer output", () => {
    expect(
      extractKnownRendererError(
        "INFO renderer\nError: worker_backend.incompatible: worker 1 used cpu_readback\n",
      ),
    ).toBe("worker_backend.incompatible: worker 1 used cpu_readback");
  });

  it("extracts remuxed output validation failures from renderer output", () => {
    expect(
      extractKnownRendererError(
        "INFO renderer\nError: remuxed output contains 238 frame(s), expected 240\n",
      ),
    ).toBe("remuxed output contains 238 frame(s), expected 240");
  });

  it("extracts selected frame hash count validation failures", () => {
    expect(
      extractKnownRendererError(
        "INFO renderer\nError: decoded selected frame hash count 16 did not match selected frame count 17 in renders/out.mp4\n",
      ),
    ).toBe(
      "decoded selected frame hash count 16 did not match selected frame count 17 in renders/out.mp4",
    );
  });

  it("extracts selected frame hash missing-frame validation failures", () => {
    expect(
      extractKnownRendererError(
        "INFO renderer\nError: decoded selected frame hash probe missing frame 172 in renders/out.mp4\n",
      ),
    ).toBe(
      "decoded selected frame hash probe missing frame 172 in renders/out.mp4",
    );
  });

  it("extracts boundary frame hash probe count failures", () => {
    expect(
      extractKnownRendererError(
        "INFO renderer\nError: decoded boundary frame hash probe returned 16 frame(s), expected 17 in renders/out.mp4\n",
      ),
    ).toBe(
      "decoded boundary frame hash probe returned 16 frame(s), expected 17 in renders/out.mp4",
    );
  });

  it("extracts selected frame hash probe count failures", () => {
    expect(
      extractKnownRendererError(
        "INFO renderer\nError: decoded selected frame hash probe returned 16 frame(s), expected 17 in renders/out.mp4\n",
      ),
    ).toBe(
      "decoded selected frame hash probe returned 16 frame(s), expected 17 in renders/out.mp4",
    );
  });

  it("extracts adjacent duplicate frame hash validation failures", () => {
    expect(
      extractKnownRendererError(
        "INFO renderer\nError: adjacent duplicate decoded segment-boundary frame at index 120 in renders/out.mp4\n",
      ),
    ).toBe(
      "adjacent duplicate decoded segment-boundary frame at index 120 in renders/out.mp4",
    );
  });

  it("extracts frame zero preview repeat validation failures", () => {
    expect(
      extractKnownRendererError(
        "INFO renderer\nError: frame 0 matched preview frame 72 in renders/out.mp4\n",
      ),
    ).toBe("frame 0 matched preview frame 72 in renders/out.mp4");
  });

  it("extracts watched frame range repeat validation failures", () => {
    expect(
      extractKnownRendererError(
        "INFO renderer\nError: frames 168-176 repeated decoded frame hash: frame 176 matched frame 168 in renders/out.mp4\n",
      ),
    ).toBe(
      "frames 168-176 repeated decoded frame hash: frame 176 matched frame 168 in renders/out.mp4",
    );
  });

  it("extracts watched frame preview repeat validation failures", () => {
    expect(
      extractKnownRendererError(
        "INFO renderer\nError: frame 168 matched frame 0 in renders/out.mp4\n",
      ),
    ).toBe("frame 168 matched frame 0 in renders/out.mp4");
  });

  it("extracts ffmpeg encoder initialization failures from renderer output", () => {
    expect(
      extractKnownRendererError(
        "INFO renderer starting\nError: ffmpeg encoder initialization failed: failed to spawn ffmpeg with d3d11va encoder\n",
      ),
    ).toBe(
      "ffmpeg encoder initialization failed: failed to spawn ffmpeg with d3d11va encoder",
    );
  });

  it("preserves ffmpeg encoder initialization failure details without earlier logs", () => {
    expect(
      extractKnownRendererError(
        [
          "INFO renderer starting",
          "DEBUG probing D3D11 device",
          "Error: ffmpeg encoder initialization failed: ffmpeg exited before accepting hardware frames",
          "stderr:",
          "Unknown encoder 'h264_nvenc'",
          "Install FFmpeg with D3D11 hardware encoder support.",
          "",
        ].join("\n"),
      ),
    ).toBe(
      [
        "ffmpeg encoder initialization failed: ffmpeg exited before accepting hardware frames",
        "stderr:",
        "Unknown encoder 'h264_nvenc'",
        "Install FFmpeg with D3D11 hardware encoder support.",
      ].join("\n"),
    );
  });

  it("preserves D3D11 dependency setup guidance from renderer output", () => {
    expect(
      extractKnownRendererError(
        [
          "INFO renderer starting",
          "Error: D3D11 accelerated rendering dependencies are missing.",
          "Run: .\\scripts\\setup-accelerated-rendering.ps1",
          "",
        ].join("\n"),
      ),
    ).toBe(
      [
        "D3D11 accelerated rendering dependencies are missing.",
        "Run: .\\scripts\\setup-accelerated-rendering.ps1",
      ].join("\n"),
    );
  });

  it("preserves required acceleration unavailable backend cause", () => {
    expect(
      extractKnownRendererError(
        [
          "INFO renderer starting",
          "Error: accelerated rendering is required, but no compatible GPU backend is available on this platform.",
          "Backend cause: acceleration.required_unavailable: no required GPU backend is available (windows_d3d11_mf unavailable: platform.device_unavailable: Windows D3D11 device unavailable)",
          "",
        ].join("\n"),
      ),
    ).toBe(
      [
        "accelerated rendering is required, but no compatible GPU backend is available on this platform.",
        "Backend cause: acceleration.required_unavailable: no required GPU backend is available (windows_d3d11_mf unavailable: platform.device_unavailable: Windows D3D11 device unavailable)",
      ].join("\n"),
    );
  });

  it("preserves required acceleration path fallback guidance", () => {
    expect(
      extractKnownRendererError(
        [
          "INFO renderer starting",
          "Error: accelerated rendering is required, but it is not available for this render path: streamed BGRA worker assembly is enabled.",
          'Set acceleration to "auto" to allow software fallback, or disable the incompatible option.',
          "",
        ].join("\n"),
      ),
    ).toBe(
      [
        "accelerated rendering is required, but it is not available for this render path: streamed BGRA worker assembly is enabled.",
        'Set acceleration to "auto" to allow software fallback, or disable the incompatible option.',
      ].join("\n"),
    );
  });

  it("preserves required acceleration pixel-format guidance", () => {
    expect(
      extractKnownRendererError(
        [
          "INFO renderer starting",
          "Error: accelerated rendering currently supports nv12/yuv420p output, but yuv444p was requested.",
          "Use --pixel-format nv12, or use --acceleration off for the software BGRA path.",
          "",
        ].join("\n"),
      ),
    ).toBe(
      [
        "accelerated rendering currently supports nv12/yuv420p output, but yuv444p was requested.",
        "Use --pixel-format nv12, or use --acceleration off for the software BGRA path.",
      ].join("\n"),
    );
  });

  it("extracts exact Electron load errors from renderer output", () => {
    expect(
      extractKnownRendererError(
        "INFO renderer\nError: electron.host_error: ERR_CONNECTION_REFUSED (http://127.0.0.1:4545/)\n",
      ),
    ).toBe("electron.host_error: ERR_CONNECTION_REFUSED (http://127.0.0.1:4545/)");
  });

  it("extracts composition paint timeout errors from renderer output", () => {
    expect(
      extractKnownRendererError(
        "INFO renderer\nError: electron.host_error: composition paint timed out after resize\n",
      ),
    ).toBe("electron.host_error: composition paint timed out after resize");
  });

  it("extracts selector metadata errors from renderer output", () => {
    expect(
      extractKnownRendererError(
        "Error: selector #hero was not found in composition metadata\n",
      ),
    ).toBe("selector #hero was not found in composition metadata");
  });

  it("extracts accelerated readback errors from renderer output", () => {
    expect(
      extractKnownRendererError(
        "Error: capture.accelerated_readback_unavailable\n",
      ),
    ).toBe("capture.accelerated_readback_unavailable");
  });

  it("extracts Windows shared-texture capture probe errors from renderer output", () => {
    expect(
      extractKnownRendererError(
        "Error: capture.d3d11_unavailable: Electron shared texture unavailable\n",
      ),
    ).toBe(
      "capture.d3d11_unavailable: Electron shared texture unavailable",
    );
  });

  it("extracts exact worker failure messages from renderer output", () => {
    expect(
      extractKnownRendererError(
        "Error: worker 120..240 failed: exit status: exit code: 1\nstderr:\nboom\n",
      ),
    ).toBe("worker 120..240 failed: exit status: exit code: 1\nstderr:\nboom");
  });

  it("extracts worker failure details from renderer output", () => {
    expect(
      extractKnownRendererError(
        "Error: worker 120..240 failed: status exit code: 1\nstdout:\n\nstderr:\nframe 128 timed out waiting for accelerated paint\n",
      ),
    ).toBe(
      "worker 120..240 failed: status exit code: 1\nstdout:\n\nstderr:\nframe 128 timed out waiting for accelerated paint",
    );
  });
});

describe("extractRendererSuccessWarning", () => {
  it("surfaces auto acceleration fallback from successful renderer output", () => {
    expect(
      extractRendererSuccessWarning(
        [
          "2026-05-21T10:00:00Z INFO initializing",
          "hardware encoder unavailable; falling back to software BGRA stdin",
          "render complete",
        ].join("\n"),
      ),
    ).toBe("hardware encoder unavailable; falling back to software BGRA stdin");
  });

  it("prefers detailed fallback backend causes from successful renderer output", () => {
    expect(
      extractRendererSuccessWarning(
        [
          "hardware encoder unavailable; falling back to software BGRA stdin",
          "renderer completed using fallback path: hardware encoder unavailable: accelerated rendering is required, but no compatible GPU backend is available on this platform.",
          "Backend cause: acceleration.required_unavailable: no required GPU backend is available (windows_d3d11_mf unavailable: platform.device_unavailable: Windows D3D11 device unavailable)",
        ].join("\n"),
      ),
    ).toBe(
      [
        "renderer completed using fallback path: hardware encoder unavailable: accelerated rendering is required, but no compatible GPU backend is available on this platform.",
        "Backend cause: acceleration.required_unavailable: no required GPU backend is available (windows_d3d11_mf unavailable: platform.device_unavailable: Windows D3D11 device unavailable)",
      ].join("\n"),
    );
  });
});

describe("extractRendererReportSuccessWarning", () => {
  it("formats auto fallback reports with structured backend diagnostics", () => {
    expect(
      extractRendererReportSuccessWarning({
        fallback_used: true,
        fallback_reason:
          "hardware encoder unavailable: accelerated rendering is required, but no compatible GPU backend is available on this platform.",
        backend_diagnostics: [
          {
            backend: "windows_d3d11_mf",
            available: false,
            unavailable_code: "platform.device_unavailable",
            unavailable_reason:
              "platform.device_unavailable: Windows D3D11 device unavailable",
          },
          {
            backend: "software_bgra_ffmpeg",
            available: true,
          },
        ],
      }),
    ).toBe(
      [
        "renderer completed using fallback path: hardware encoder unavailable: accelerated rendering is required, but no compatible GPU backend is available on this platform.",
        "Backend diagnostics: windows_d3d11_mf unavailable: platform.device_unavailable: Windows D3D11 device unavailable",
      ].join("\n"),
    );
  });

  it("formats CPU readback reports when no fallback was used", () => {
    expect(
      extractRendererReportSuccessWarning({
        fallback_used: false,
        cpu_readback_frames: 2,
      }),
    ).toBe("renderer completed using CPU readback for 2 frame(s)");
  });
});

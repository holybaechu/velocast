import { describe, expect, it } from "vitest";
import {
  extractKnownRendererError,
  extractRendererReportSuccessWarning,
  extractRendererSuccessWarning,
} from "./renderer-output.js";

describe("extractKnownRendererError", () => {
  it.each([
    "output.frame_count_mismatch: actual encoded packets differ from schedule",
    "output.timestamps_not_rebased",
    "worker.encoder_mismatch",
    "acceleration.required_unavailable: WebCodecs cannot guarantee hardware encoding",
  ])("preserves current renderer validation errors: %s", (message) => {
    expect(
      extractKnownRendererError(`INFO renderer\nError: ${message}\n`),
    ).toBe(message);
  });

  it("does not mistake stack frame filenames for renderer error codes", () => {
    expect(
      extractKnownRendererError(
        "unexpected failure\n    at /app/runtime.js:15:2\n",
      ),
    ).toBeUndefined();
  });

  it("extracts exact media host exit messages from renderer output", () => {
    expect(
      extractKnownRendererError(
        "thread main failed\nError: media.host_failed: Electron utility exited with code 234\n",
      ),
    ).toBe("media.host_failed: Electron utility exited with code 234");
  });

  it("extracts segment remux failure messages from renderer output", () => {
    expect(
      extractKnownRendererError(
        "INFO muxing segments\nError: media.invalid_container: invalid data found when reading segment\n",
      ),
    ).toBe("media.invalid_container: invalid data found when reading segment");
  });

  it("extracts webcodecs encoder initialization failures from renderer output", () => {
    expect(
      extractKnownRendererError(
        "INFO renderer starting\nError: encoder.webcodecs_open_failed: codec h264 is unavailable\n",
      ),
    ).toBe("encoder.webcodecs_open_failed: codec h264 is unavailable");
  });

  it("preserves webcodecs encoder initialization failure details without earlier logs", () => {
    expect(
      extractKnownRendererError(
        [
          "INFO renderer starting",
          "DEBUG probing VideoEncoder",
          "Error: encoder.webcodecs_open_failed: VideoEncoder configure failed",
          "stderr:",
          "Unsupported logical codec 'hevc'",
          "Install a current compatible Electron runtime.",
          "",
        ].join("\n"),
      ),
    ).toBe(
      [
        "encoder.webcodecs_open_failed: VideoEncoder configure failed",
        "stderr:",
        "Unsupported logical codec 'hevc'",
        "Install a current compatible Electron runtime.",
      ].join("\n"),
    );
  });

  it("preserves WebCodecs runtime installation diagnostics", () => {
    expect(
      extractKnownRendererError(
        "INFO renderer starting\nError: runtime.electron_missing: install the matching Electron WebCodecs runtime\n",
      ),
    ).toBe(
      "runtime.electron_missing: install the matching Electron WebCodecs runtime",
    );
  });

  it("extracts exact Electron load errors from renderer output", () => {
    expect(
      extractKnownRendererError(
        "INFO renderer\nError: electron.host_error: ERR_CONNECTION_REFUSED (http://127.0.0.1:4545/)\n",
      ),
    ).toBe(
      "electron.host_error: ERR_CONNECTION_REFUSED (http://127.0.0.1:4545/)",
    );
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

  it("extracts compositor capture probe errors from renderer output", () => {
    expect(
      extractKnownRendererError(
        "Error: capture.compositor_unavailable: Electron compositor unavailable\n",
      ),
    ).toBe("capture.compositor_unavailable: Electron compositor unavailable");
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
        "Error: worker 120..240 failed: status exit code: 1\nstdout:\n\nstderr:\nelectron.host_error: composition paint timed out\n",
      ),
    ).toBe(
      "worker 120..240 failed: status exit code: 1\nstdout:\n\nstderr:\nelectron.host_error: composition paint timed out",
    );
  });
});

describe("extractRendererSuccessWarning", () => {
  it("surfaces structured fallback text from successful renderer output", () => {
    expect(
      extractRendererSuccessWarning(
        [
          "2026-05-21T10:00:00Z INFO initializing",
          "renderer completed using fallback path: codec configuration unsupported",
          "render complete",
        ].join("\n"),
      ),
    ).toBe(
      "renderer completed using fallback path: codec configuration unsupported",
    );
  });

  it("prefers detailed fallback backend causes from successful renderer output", () => {
    expect(
      extractRendererSuccessWarning(
        [
          "renderer completed using CPU readback for 3 frame(s)",
          "renderer completed using fallback path: hardware encoder unavailable: accelerated rendering is required, but no compatible GPU backend is available on this platform.",
          "Backend cause: acceleration.required_unavailable: no required GPU backend is available (webcodecs unavailable: platform.device_unavailable: WebCodecs codec unavailable)",
        ].join("\n"),
      ),
    ).toBe(
      [
        "renderer completed using fallback path: hardware encoder unavailable: accelerated rendering is required, but no compatible GPU backend is available on this platform.",
        "Backend cause: acceleration.required_unavailable: no required GPU backend is available (webcodecs unavailable: platform.device_unavailable: WebCodecs codec unavailable)",
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
            backend: "webcodecs",
            available: false,
            unavailable_code: "platform.device_unavailable",
            unavailable_reason:
              "platform.device_unavailable: WebCodecs codec unavailable",
          },
          {
            backend: "electron_webcodecs_h264",
            available: true,
          },
        ],
      }),
    ).toBe(
      [
        "renderer completed using fallback path: hardware encoder unavailable: accelerated rendering is required, but no compatible GPU backend is available on this platform.",
        "Backend diagnostics: webcodecs unavailable: platform.device_unavailable: WebCodecs codec unavailable",
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

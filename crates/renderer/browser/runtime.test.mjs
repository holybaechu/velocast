import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function browserRuntime() {
  // Execute the exact source embedded by Rust, in the page's DOM environment.
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "runtime.js"),
    "utf8",
  );
  return new Function("window", "document", `return ${source}`)(
    window,
    document,
  );
}

describe("renderer browser execution", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="hero"></div>';
    document.body.style.transform = "";
    document.title = "original";
    delete document.documentElement.dataset.velocastCaptureTarget;
    delete window.__velocast;
    delete window.__velocastRenderer;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    delete document.fonts;
    vi.restoreAllMocks();
  });

  it("fails a pinned render when its authoring runtime is replaced", async () => {
    const runtime = browserRuntime();
    let session;
    const old = {
      async beginSession(value) {
        session = { ...value };
      },
      getSession() {
        return session;
      },
      cancelPending: vi.fn(),
    };
    window.__velocast = old;
    await runtime.bindSession({ sessionId: "job", sourceVersion: "source-a" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await runtime.report("source-swap", "result:", () =>
      runtime.completeFrame(() => {
        window.__velocast = {
          ...old,
          getSession: () => ({ sessionId: "job", sourceVersion: "source-b" }),
        };
        return "must not publish";
      }),
    );
    expect(document.title).toContain(
      "result:source-swap:err:VELOCAST_SOURCE_CHANGED",
    );
    expect(old.cancelPending).toHaveBeenCalled();
  });

  it("does not let a replaced renderer bridge publish its late report", async () => {
    const old = browserRuntime();
    window.__velocastRenderer = old;
    let release;
    const pending = old.report(
      "old-bridge",
      "result:",
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const current = browserRuntime();
    window.__velocastRenderer = current;
    await current.report("new-bridge", "result:", () => "current");
    release("old");
    await pending;
    expect(document.title).toBe('result:new-bridge:ok:"current"');
  });

  it("cancels an old report before publishing a newer result", async () => {
    const runtime = browserRuntime();
    let releaseOld;
    const old = runtime.report(
      "old",
      "result:",
      () =>
        new Promise((resolve) => {
          releaseOld = resolve;
        }),
    );
    await vi.waitFor(() => expect(releaseOld).toBeTypeOf("function"));
    await runtime.report("new", "result:", () => "new frame");
    releaseOld("old frame");
    await old;
    expect(document.title).toBe('result:new:ok:"new frame"');
  });

  it("reports failed font faces instead of capturing fallback text", async () => {
    const runtime = browserRuntime();
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: {
        ready: Promise.resolve(),
        *[Symbol.iterator]() {
          yield { family: "FixtureFont", status: "error" };
        },
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await runtime.report("font-failure", "result:", () =>
      runtime.completeFrame(() => "frame"),
    );
    expect(document.title).toBe(
      "result:font-failure:err:VELOCAST_FONT_LOAD_FAILED: FixtureFont",
    );
  });

  it("rejects incompatible and incomplete browser protocols before frame execution", () => {
    const runtime = browserRuntime();
    window.__velocast = { protocolVersion: 99 };
    expect(() => runtime.assertProtocol(2)).toThrow(
      "VELOCAST_PROTOCOL_VERSION_MISMATCH: expected 2, received 99",
    );
    window.__velocast = { protocolVersion: 2 };
    expect(() => runtime.assertProtocol(2)).toThrow(
      "VELOCAST_PROTOCOL_INVALID: getCompositions must be a function",
    );
    window.__velocast = {
      protocolVersion: 2,
      getCompositions() {},
      getDurationFrames() {},
      seekFrame() {},
      setInputProps() {},
      cancelPending() {},
      destroy() {},
      beginSession() {},
      getSession() {},
    };
    expect(runtime.assertProtocol(2)).toBe(2);
  });

  it("rejects version-2 authors at the version-3 audio contract boundary", () => {
    const runtime = browserRuntime();
    window.__velocast = { protocolVersion: 2 };
    expect(() => runtime.assertProtocol(3)).toThrow(
      "VELOCAST_PROTOCOL_VERSION_MISMATCH: expected 3, received 2",
    );
  });

  it.each(["fonts", "image", "paint"])(
    "cancels %s waits without letting late readiness publish success",
    async (stage) => {
      const runtime = browserRuntime();
      let release;
      const waiting = new Promise((resolve) => {
        release = resolve;
      });
      let entered = false;
      if (stage === "fonts") {
        Object.defineProperty(document, "fonts", {
          configurable: true,
          value: {
            get ready() {
              entered = true;
              return waiting;
            },
          },
        });
      } else if (stage === "image") {
        document.body.innerHTML = '<img src="cover.png">';
        document.querySelector("img").decode = () => {
          entered = true;
          return waiting;
        };
      } else {
        vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => {
          entered = true;
          return 1;
        });
      }
      const cancelPending = vi.fn();
      window.__velocast = { cancelPending };
      vi.spyOn(console, "error").mockImplementation(() => {});
      const report = runtime.report("cancel-1", "result:", () =>
        runtime.completeFrame(() => "late frame"),
      );
      await vi.waitFor(() => expect(entered).toBe(true));
      expect(runtime.cancel("different-token")).toBe(false);
      expect(runtime.cancel("cancel-1")).toBe(true);
      await report;
      expect(cancelPending).toHaveBeenCalledOnce();
      expect(document.title).toContain(
        "result:cancel-1:err:VELOCAST_REQUEST_CANCELLED",
      );
      release();
      await Promise.resolve();
      await Promise.resolve();
      expect(document.title).not.toContain(":ok:");
    },
  );

  it("does not execute a report cancelled before its operation starts", async () => {
    const runtime = browserRuntime();
    const operation = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const pending = runtime.report("pre-cancelled", "result:", operation);
    runtime.cancel("pre-cancelled");
    await pending;
    expect(operation).not.toHaveBeenCalled();
    expect(document.title).toContain("VELOCAST_REQUEST_CANCELLED");
  });

  it("releases a scheduled paint callback when its request is cancelled", async () => {
    const runtime = browserRuntime();
    const raf = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(123);
    const cancel = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const pending = runtime.report("paint-release", "result:", () =>
      runtime.completeFrame(() => "frame"),
    );
    await vi.waitFor(() => expect(raf).toHaveBeenCalledOnce());
    runtime.cancel("paint-release");
    await pending;
    expect(cancel).toHaveBeenCalledWith(123);
  });

  it("measures and translates a target after removing the previous capture transform", () => {
    const runtime = browserRuntime();
    const hero = document.getElementById("hero");
    document.body.style.transform = "translate(-99px, -99px)";
    vi.spyOn(hero, "getBoundingClientRect").mockImplementation(() => {
      expect(document.body.style.transform).toBe("");
      return { left: 40, top: 25, width: 640, height: 480 };
    });

    runtime.prepareTarget("#hero");

    expect(document.body.style.transform).toBe("translate(-40px, -25px)");
    expect(document.documentElement.dataset.velocastCaptureTarget).toBe(
      "#hero",
    );
  });

  it("defers target measurement until seek mounts the target and resources settle", async () => {
    const runtime = browserRuntime();
    document.body.innerHTML = "";
    runtime.selectTarget("#lazy");
    const completion = runtime.completeFrame(async () => {
      await Promise.resolve();
      const target = document.createElement("div");
      target.id = "lazy";
      document.body.appendChild(target);
      vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
        left: 31,
        top: 47,
        width: 320,
        height: 180,
      });
    });
    await completion;
    expect(document.body.style.transform).toBe("translate(-31px, -47px)");
  });

  it("measures each requested frame without exposing the previous capture translation to seek", async () => {
    const runtime = browserRuntime();
    const target = document.getElementById("hero");
    let position;
    vi.spyOn(target, "getBoundingClientRect").mockImplementation(() => ({
      left: position[0],
      top: position[1],
      width: 320,
      height: 180,
    }));
    runtime.selectTarget("#hero");
    const translations = [];
    for (const next of [
      [31, 47],
      [44, 54],
      [31, 47],
    ]) {
      await runtime.completeFrame(() => {
        expect(document.body.style.transform).toBe("");
        position = next;
      });
      translations.push(document.body.style.transform);
    }
    expect(translations).toEqual([
      "translate(-31px, -47px)",
      "translate(-44px, -54px)",
      "translate(-31px, -47px)",
    ]);
    runtime.selectTarget(null);
    expect(document.body.style.transform).toBe("");
    expect(
      document.documentElement.dataset.velocastCaptureTarget,
    ).toBeUndefined();
  });

  it("reports a missing late-mounted target with its request token instead of continuing capture", async () => {
    const runtime = browserRuntime();
    runtime.selectTarget("#never-mounted");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await runtime.report("missing-target", "result:", () =>
      runtime.completeFrame(() => undefined),
    );
    expect(document.title).toBe(
      "result:missing-target:err:selector #never-mounted was not found",
    );
  });

  it("reports a completed frame only after seeking, font readiness, and two animation frames", async () => {
    const runtime = browserRuntime();
    let releaseFonts;
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: {
        ready: new Promise((resolve) => {
          releaseFonts = resolve;
        }),
      },
    });
    const animationFrames = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    const seek = vi.fn(() => "captured");
    const completion = runtime.report(
      "script-1",
      "velocast-script-result:",
      () => runtime.completeFrame(seek),
    );

    await vi.waitFor(() => expect(seek).toHaveBeenCalledOnce());
    expect(document.title).toBe("original");
    expect(animationFrames).toHaveLength(0);
    releaseFonts();
    await vi.waitFor(() => expect(animationFrames).toHaveLength(1));
    animationFrames.shift()(0);
    expect(document.title).toBe("original");
    animationFrames.shift()(16);
    await completion;
    expect(document.title).toBe(
      'velocast-script-result:script-1:ok:"captured"',
    );
  });

  it("does not report a frame while an image mounted by seek is still decoding", async () => {
    const runtime = browserRuntime();
    const image = document.createElement("img");
    image.src = "cover.png";
    let releaseImage;
    image.decode = vi.fn(
      () =>
        new Promise((resolve) => {
          releaseImage = resolve;
        }),
    );
    const animationFrames = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    const completion = runtime.report("image-1", "result:", () =>
      runtime.completeFrame(async () => {
        await Promise.resolve();
        document.getElementById("hero").appendChild(image);
        return "frame-90";
      }),
    );

    await vi.waitFor(() => expect(image.decode).toHaveBeenCalledOnce());
    expect(document.title).toBe("original");
    expect(animationFrames).toHaveLength(0);
    releaseImage();
    await vi.waitFor(() => expect(animationFrames).toHaveLength(1));
    animationFrames.shift()(0);
    expect(document.title).toBe("original");
    animationFrames.shift()(16);
    await completion;
    expect(document.title).toBe('result:image-1:ok:"frame-90"');
  });

  it.each(["synchronous", "asynchronous"])(
    "reports %s image decode failures with the source and request token before painting",
    async (kind) => {
      const runtime = browserRuntime();
      const image = document.createElement("img");
      image.src = "fixture://broken.png";
      image.decode = () => {
        const error = new Error("invalid image data");
        if (kind === "synchronous") throw error;
        return Promise.reject(error);
      };
      document.getElementById("hero").appendChild(image);
      const raf = vi.spyOn(window, "requestAnimationFrame");
      vi.spyOn(console, "error").mockImplementation(() => {});

      await runtime.report("broken-2", "result:", () =>
        runtime.completeFrame(() => "must not capture"),
      );

      expect(document.title).toBe(
        "result:broken-2:err:VELOCAST_IMAGE_DECODE_FAILED: fixture://broken.png: invalid image data",
      );
      expect(raf).not.toHaveBeenCalled();
    },
  );

  it("does not let images outside the selected capture target fail its frame", async () => {
    const runtime = browserRuntime();
    const hero = document.getElementById("hero");
    hero.innerHTML = '<img src="cover.png">';
    hero.querySelector("img").decode = () => Promise.resolve();
    const unrelated = document.createElement("img");
    unrelated.src = "broken-preview.png";
    unrelated.decode = () => Promise.reject(new Error("unrelated preview"));
    document.body.appendChild(unrelated);
    vi.spyOn(hero, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 640,
      height: 480,
    });
    runtime.prepareTarget("#hero");

    await expect(runtime.completeFrame(() => "hero frame")).resolves.toBe(
      "hero frame",
    );
  });

  it("allows empty image placeholders without treating them as failed resources", async () => {
    const runtime = browserRuntime();
    document.getElementById("hero").innerHTML =
      '<img alt="placeholder"><img src="">';

    await expect(runtime.completeFrame(() => "empty frame")).resolves.toBe(
      "empty frame",
    );
  });

  it("waits for an image when the image itself is the capture target", async () => {
    const runtime = browserRuntime();
    document.body.innerHTML = '<img id="cover" src="cover.png">';
    const image = document.getElementById("cover");
    image.decode = () => Promise.reject(new Error("target not ready"));
    vi.spyOn(image, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 640,
      height: 480,
    });
    runtime.prepareTarget("#cover");

    await expect(runtime.completeFrame(() => undefined)).rejects.toThrow(
      "VELOCAST_IMAGE_DECODE_FAILED: cover.png: target not ready",
    );
  });

  it.each([
    '<img srcset="cover-2x.png 2x">',
    '<picture><source srcset="cover.webp"><img></picture>',
  ])(
    "waits for responsive image sources without a src attribute: %s",
    async (markup) => {
      const runtime = browserRuntime();
      document.getElementById("hero").innerHTML = markup;
      document.querySelector("img").decode = () =>
        Promise.reject(new Error("responsive resource failed"));

      await expect(runtime.completeFrame(() => undefined)).rejects.toThrow(
        "responsive resource failed",
      );
    },
  );

  it("decodes the current image after reverse, repeated, and fresh-session seeks", async () => {
    const renderFrames = async (frames) => {
      const runtime = browserRuntime();
      document.getElementById("hero").innerHTML = '<img src="frame-0.png">';
      const image = document.querySelector("img");
      image.decode = async () => {
        await Promise.resolve();
        image.dataset.decoded = image.getAttribute("src");
      };
      const outputs = [];
      for (const frame of frames) {
        await runtime.completeFrame(() => {
          image.src = `frame-${frame}.png`;
        });
        outputs.push(image.dataset.decoded);
      }
      return outputs;
    };

    expect(await renderFrames([0, 90, 12, 90])).toEqual([
      "frame-0.png",
      "frame-90.png",
      "frame-12.png",
      "frame-90.png",
    ]);
    expect(await renderFrames([90])).toEqual(["frame-90.png"]);
  });

  it("does not reuse decoded image state after props replace an image at the same frame", async () => {
    const runtime = browserRuntime();
    const hero = document.getElementById("hero");
    await runtime.completeFrame(() => {
      hero.innerHTML = '<img src="first-props.png">';
      hero.querySelector("img").decode = () => Promise.resolve();
    });

    await expect(
      runtime.completeFrame(() => {
        hero.innerHTML = '<img src="second-props.png">';
        hero.querySelector("img").decode = () =>
          Promise.reject(new Error("new props not ready"));
      }),
    ).rejects.toThrow(
      "VELOCAST_IMAGE_DECODE_FAILED: second-props.png: new props not ready",
    );
  });

  it("preserves an installed frame protocol and awaits its props and readiness hooks", async () => {
    const runtime = browserRuntime();
    const values = [];
    const protocol = {
      async setInputProps(props) {
        values.push(props);
      },
      async waitForReady() {
        values.push("ready");
      },
    };
    window.__velocast = protocol;
    runtime.installMissingProtocol();
    await runtime.setInputProps({ title: 'quoted " title' });
    await runtime.waitForReady();
    expect(window.__velocast).toBe(protocol);
    expect(values).toEqual([{ title: 'quoted " title' }, "ready"]);
  });

  it("updates viewport dimensions without adding duplicate render styles", () => {
    const runtime = browserRuntime();
    runtime.renderEnvironment(640, 480);
    runtime.renderEnvironment(1200, 630);
    expect(
      document.querySelectorAll("#velocast-render-environment"),
    ).toHaveLength(1);
    expect(document.documentElement.dataset.velocastRendering).toBe("true");
    expect(document.documentElement.style.width).toBe("1200px");
    expect(document.body.style.height).toBe("630px");
    expect(window.getComputedStyle(document.documentElement).overflow).toBe(
      "hidden",
    );
  });

  it("reports a missing frame protocol instead of inventing a composition", async () => {
    const runtime = browserRuntime();
    runtime.installMissingProtocol();
    await expect(window.__velocast.getCompositions()).rejects.toThrow(
      "VELOCAST_PROTOCOL_MISSING:",
    );
    expect(runtime.waitForReady()).toBeUndefined();
    expect(runtime.setInputProps({})).toBeUndefined();
  });

  it.each([
    [
      "synchronous",
      () => {
        throw new Error("capture failed");
      },
    ],
    [
      "asynchronous",
      async () => {
        throw new Error("capture failed");
      },
    ],
  ])(
    "reports %s browser errors using the original request token",
    async (_kind, operation) => {
      const runtime = browserRuntime();
      vi.spyOn(console, "error").mockImplementation(() => {});
      await runtime.report("script-7", "velocast-script-result:", operation);
      expect(document.title).toBe(
        "velocast-script-result:script-7:err:capture failed",
      );
    },
  );

  it("uses the same bounds validation for measurement and target capture", () => {
    const runtime = browserRuntime();
    const hero = document.getElementById("hero");
    vi.spyOn(hero, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 0,
      height: 480,
    });
    expect(() => runtime.measureSelector("#hero")).toThrow(
      "selector #hero has empty bounds",
    );
    expect(() => runtime.prepareTarget("#hero")).toThrow(
      "selector #hero has empty bounds",
    );
    expect(() => runtime.measureSelector("#missing")).toThrow(
      "selector #missing was not found",
    );
  });
});

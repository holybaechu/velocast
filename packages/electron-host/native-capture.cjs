"use strict";

// The authored renderer never sees native handles. Unrequested paints are returned
// immediately; one caller owns a requested texture until the import takes over.
class NativeCapture {
  constructor(contents, timeout = 1800) {
    this.contents = contents;
    this.timeout = timeout;
    this.pending = null;
    this.lastFrame = -1;
    this.closed = false;
    this.onPaint = (event) => {
      const texture = event.texture;
      const pending = this.pending;
      if (this.activity) {
        this.activity[pending ? "texturePaints" : "readinessPaints"]++;
        this.activity.lastPaintAt = performance.now();
      }
      if (!texture) {
        pending?.reject(new Error("capture.shared_texture_unavailable"));
        return;
      }
      const release = () => {
        try {
          texture.release();
        } catch (error) {
          this.failure = new Error(
            `capture.native_release_failed: ${error.message}`,
          );
          this.cancel?.(this.failure);
        }
      };
      const info = texture.textureInfo;
      const count = info?.metadata?.frameCount;
      const previous = this.lastFrame;
      if (Number.isSafeInteger(count))
        this.lastFrame = Math.max(count, previous);
      if (!pending) {
        release();
        return;
      }
      const { width, height } = pending;
      if (
        info?.widgetType !== "frame" ||
        count <= pending.after ||
        count <= previous
      ) {
        release();
        return;
      }
      const rect = info?.visibleRect;
      const matchesSize = (size) =>
        size &&
        info.codedSize?.width === size.width &&
        info.codedSize?.height === size.height &&
        rect?.x === 0 &&
        rect?.y === 0 &&
        rect?.width === size.width &&
        rect?.height === size.height;
      const validResource =
        Number.isSafeInteger(count) &&
        info.handle &&
        ["bgra", "rgba", "rgbaf16"].includes(info.pixelFormat);
      // Viewport changes are asynchronous: even a fresh counter can describe a
      // known bootstrap or prior viewport. Drain only exact, otherwise-valid
      // surfaces during settlement, never crop them or admit them for encoding.
      if (
        validResource &&
        !matchesSize(pending) &&
        pending.previousViewports.some(matchesSize)
      ) {
        this.activity.staleResizePaints++;
        release();
        return;
      }
      if (!validResource || !matchesSize(pending)) {
        release();
        // Report geometry, never native handle contents, so platform failures
        // remain actionable without exposing cross-process GPU capabilities.
        pending.reject(new Error(`capture.invalid_native_geometry: ${JSON.stringify({
          expected: { width, height },
          codedSize: info?.codedSize,
          visibleRect: rect,
          pixelFormat: info?.pixelFormat,
          frameCount: count,
          hasHandle: Boolean(info?.handle),
        })}`));
        return;
      }
      this.pending = null;
      pending.resolve(texture);
    };
    contents.on("paint", this.onPaint);
  }

  resetSource() {
    if (this.busy) throw new Error("capture.busy");
    // Navigation can replace RenderWidgetHostView and its native capture counter.
    this.lastFrame = -1;
  }

  async capture(width, height, previousViewports = []) {
    if (this.closed) throw new Error("capture.closed");
    if (this.failure) throw this.failure;
    if (this.busy) throw new Error("capture.busy");
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > 16384 ||
      height > 16384
    )
      throw new Error("capture.invalid_native_geometry");
    let timer;
    this.busy = true;
    const activity = this.activity = {
      startFrame: this.lastFrame,
      readinessPaints: 0,
      texturePaints: 0,
      staleResizePaints: 0,
      lastPaintAt: null,
    };
    const result = new Promise((resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `capture.shared_texture_timeout: ${this.pending ? "texture" : "readiness"}, lastFrame=${this.lastFrame}, ${JSON.stringify({
                startFrame: activity.startFrame,
                readinessPaints: activity.readinessPaints,
                texturePaints: activity.texturePaints,
                staleResizePaints: activity.staleResizePaints,
                sinceLastPaintMs: activity.lastPaintAt === null
                  ? null : Math.round(performance.now() - activity.lastPaintAt),
              })}`,
            ),
          ),
        this.timeout,
      );
      this.cancel = reject;
      this.contents.startPainting();
      // Restarting OSR requests a full native frame even for unchanged content.
      // invalidate() only replays a CPU backing bitmap in Electron 44 and is not
      // a shared-texture refresh API. Never use it as a native capture fallback.
      this.contents
        .executeJavaScriptInIsolatedWorld(1001, [
          {
            code: "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
          },
        ])
        .then(() => {
          if (this.closed || this.cancel !== reject) return;
          if (this.failure) {
            reject(this.failure);
            return;
          }
          this.contents.stopPainting();
          this.pending = {
            width,
            height,
            previousViewports,
            after: this.lastFrame,
            resolve,
            reject,
          };
          this.contents.startPainting();
        })
        .catch(reject);
    });
    try {
      return await result;
    } finally {
      clearTimeout(timer);
      this.busy = false;
      this.cancel = null;
      this.pending = null;
      this.activity = null;
    }
  }

  dispose() {
    this.closed = true;
    this.cancel?.(new Error("capture.closed"));
    // Keep releasing late deliveries until the owned BrowserWindow is destroyed.
  }
}
module.exports = { NativeCapture };

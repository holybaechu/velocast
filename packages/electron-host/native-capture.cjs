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
      if (
        !Number.isSafeInteger(count) ||
        !info.handle ||
        info.codedSize?.width !== width ||
        info.codedSize?.height !== height ||
        rect?.x !== 0 ||
        rect?.y !== 0 ||
        rect?.width !== width ||
        rect?.height !== height ||
        !["bgra", "rgba", "rgbaf16"].includes(info.pixelFormat)
      ) {
        release();
        pending.reject(new Error("capture.invalid_native_geometry"));
        return;
      }
      this.pending = null;
      pending.resolve(texture);
    };
    contents.on("paint", this.onPaint);
  }

  async capture(width, height) {
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
    const result = new Promise((resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `capture.shared_texture_timeout: ${this.pending ? "texture" : "readiness"}, lastFrame=${this.lastFrame}`,
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
        .executeJavaScript(
          "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
        )
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
    }
  }

  dispose() {
    this.closed = true;
    this.cancel?.(new Error("capture.closed"));
    // Keep releasing late deliveries until the owned BrowserWindow is destroyed.
  }
}
module.exports = { NativeCapture };

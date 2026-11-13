"use strict";

// The controller fences compositor submission before capture. Restarting the
// capturer copies that surface even when the frame's pixels have not changed.
// Never use invalidate(): Electron can replay a cached bitmap through that API.
class SharedTextureCapture {
  constructor(contents) {
    this.contents = contents;
    this.closed = false;
    this.pending = null;
    contents.stopPainting();
    this.onPaint = (event) => {
      const texture = event.texture;
      const pending = this.pending;
      if (!pending) {
        texture?.release();
        return;
      }
      if (!texture) {
        this.reject(new Error("capture.shared_texture_unavailable"));
        return;
      }
      const { widgetType, codedSize, visibleRect } = texture.textureInfo;
      if (
        widgetType !== "frame" ||
        codedSize.width !== pending.width ||
        codedSize.height !== pending.height ||
        visibleRect.x !== 0 ||
        visibleRect.y !== 0 ||
        visibleRect.width !== pending.width ||
        visibleRect.height !== pending.height
      ) {
        texture.release();
        return;
      }
      this.pending = null;
      clearTimeout(pending.timer);
      contents.stopPainting();
      pending.resolve(texture);
    };
    contents.on("paint", this.onPaint);
  }

  capture(width, height, timeoutMs = 1800) {
    if (this.closed) throw new Error("capture.closed");
    if (this.pending) throw new Error("capture.busy");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.reject(new Error("Electron shared texture capture timed out"));
      }, timeoutMs);
      this.pending = { width, height, resolve, reject, timer };
      try {
        this.contents.startPainting();
      } catch (error) {
        this.reject(error);
      }
    });
  }

  reject(error) {
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      if (!this.contents.isDestroyed()) this.contents.stopPainting();
      pending.reject(error);
    }
  }

  dispose() {
    this.closed = true;
    this.reject(new Error("capture.closed"));
    // Keep the listener until the WebContents is destroyed: late deliveries
    // still own a texture and must be released after cancellation or timeout.
  }
}

module.exports = { SharedTextureCapture };

(() => {
  let activeReport;
  let boundSession;

  function sameSession(left, right) {
    return (
      left &&
      right &&
      left.sessionId === right.sessionId &&
      (left.sourceVersion ?? undefined) === (right.sourceVersion ?? undefined)
    );
  }

  function assertBoundSession() {
    if (!boundSession) return;
    if (
      window.__velocast !== boundSession.protocol ||
      !sameSession(boundSession.identity, boundSession.protocol.getSession())
    ) {
      boundSession.protocol.cancelPending();
      throw new Error(
        "VELOCAST_SOURCE_CHANGED: the pinned browser runtime/session was replaced during rendering",
      );
    }
  }

  function cancelledError() {
    const error = new Error(
      "VELOCAST_REQUEST_CANCELLED: the browser request was cancelled",
    );
    error.name = "AbortError";
    return error;
  }

  function withAbort(work, signal) {
    if (!signal) return Promise.resolve(work);
    if (signal.aborted) {
      Promise.resolve(work).catch(() => {});
      return Promise.reject(signal.reason);
    }
    return new Promise((resolve, reject) => {
      const cleanup = () => signal.removeEventListener("abort", abort);
      const abort = () => {
        cleanup();
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      Promise.resolve(work).then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    });
  }

  function findTarget(selector) {
    const target = document.querySelector(selector);
    if (!target) throw new Error(`selector ${selector} was not found`);
    return target;
  }

  function bounds(target, selector) {
    const rect = target.getBoundingClientRect();
    if (
      !Number.isFinite(rect.width) ||
      !Number.isFinite(rect.height) ||
      rect.width <= 0 ||
      rect.height <= 0
    ) {
      throw new Error(`selector ${selector} has empty bounds`);
    }
    return rect;
  }

  return {
    assertProtocol(expectedVersion) {
      const protocol = window.__velocast;
      if (!protocol)
        throw new Error(
          "VELOCAST_PROTOCOL_MISSING: No frame adapter protocol was installed on window.__velocast.",
        );
      if (protocol.protocolVersion !== expectedVersion) {
        throw new Error(
          `VELOCAST_PROTOCOL_VERSION_MISMATCH: expected ${expectedVersion}, received ${String(protocol.protocolVersion ?? "unversioned")}. Rebuild the authoring helper and native renderer together.`,
        );
      }
      for (const method of [
        "getCompositions",
        "getDurationFrames",
        "seekFrame",
        "setInputProps",
        "cancelPending",
        "destroy",
        "beginSession",
        "getSession",
      ]) {
        if (typeof protocol[method] !== "function")
          throw new Error(
            `VELOCAST_PROTOCOL_INVALID: ${method} must be a function`,
          );
      }
      return protocol.protocolVersion;
    },

    async bindSession(identity) {
      const protocol = window.__velocast;
      if (
        boundSession &&
        (!sameSession(identity, boundSession.identity) ||
          protocol !== boundSession.protocol)
      ) {
        throw new Error(
          "VELOCAST_SESSION_MISMATCH: a different session is already bound to this renderer",
        );
      }
      await protocol.beginSession(identity);
      const pinned = protocol.getSession();
      if (window.__velocast !== protocol || !sameSession(identity, pinned)) {
        throw new Error(
          "VELOCAST_SOURCE_CHANGED: runtime changed while binding render session",
        );
      }
      boundSession = { protocol, identity: { ...pinned } };
    },

    renderEnvironment(width, height) {
      const styleId = "velocast-render-environment";
      let style = document.getElementById(styleId);
      if (!style) {
        style = document.createElement("style");
        style.id = styleId;
        document.head.appendChild(style);
      }
      style.textContent = `
        html, body {
          overflow: hidden !important;
          scrollbar-width: none !important;
          -ms-overflow-style: none !important;
        }
        html::-webkit-scrollbar, body::-webkit-scrollbar, *::-webkit-scrollbar {
          display: none !important;
          width: 0 !important;
          height: 0 !important;
        }
      `;
      document.documentElement.dataset.velocastRendering = "true";
      document.documentElement.style.width = `${width}px`;
      document.documentElement.style.height = `${height}px`;
      document.documentElement.style.overflow = "hidden";
      if (document.body) {
        document.body.style.width = `${width}px`;
        document.body.style.height = `${height}px`;
        document.body.style.overflow = "hidden";
      }
    },

    installMissingProtocol() {
      if (window.__velocast) return;
      const missing = () => {
        throw new Error(
          "VELOCAST_PROTOCOL_MISSING: No frame adapter protocol was installed on window.__velocast.",
        );
      };
      window.__velocast = {
        async getCompositions() {
          missing();
        },
        async getDurationFrames() {
          missing();
        },
        async seekFrame() {
          missing();
        },
      };
    },

    setInputProps(inputProps) {
      const protocol = window.__velocast;
      return protocol && typeof protocol.setInputProps === "function"
        ? protocol.setInputProps(inputProps)
        : undefined;
    },

    waitForReady() {
      const protocol = window.__velocast;
      return protocol && typeof protocol.waitForReady === "function"
        ? protocol.waitForReady()
        : undefined;
    },

    async report(token, prefix, operation) {
      let cancellationFailure;
      try {
        if (activeReport) this.cancel(activeReport.token);
      } catch (error) {
        cancellationFailure = error;
      }
      const request = { token, controller: new AbortController() };
      activeReport = request;
      const signal = request.controller.signal;
      const report = (status, payload) => {
        if (
          activeReport !== request ||
          (window.__velocastRenderer && window.__velocastRenderer !== this)
        )
          return;
        document.title =
          prefix + token + ":" + status + ":" + String(payload ?? "");
      };
      try {
        if (cancellationFailure) throw cancellationFailure;
        assertBoundSession();
        const value = await withAbort(
          Promise.resolve().then(() => {
            signal.throwIfAborted();
            return operation(signal);
          }),
          signal,
        );
        signal.throwIfAborted();
        assertBoundSession();
        report("ok", JSON.stringify(value));
      } catch (error) {
        if (activeReport !== request) return;
        const message = String(error && (error.message || error));
        report("err", message);
        console.error("velocast script failed", error);
      } finally {
        if (activeReport === request) activeReport = undefined;
      }
    },

    cancel(token) {
      if (
        !activeReport ||
        (token !== undefined && token !== activeReport.token)
      )
        return false;
      activeReport.controller.abort(cancelledError());
      (boundSession?.protocol ?? window.__velocast)?.cancelPending?.();
      return true;
    },

    async completeFrame(seek, signal = activeReport?.controller.signal) {
      assertBoundSession();
      signal?.throwIfAborted();
      const selector = document.documentElement.dataset.velocastCaptureTarget;
      if (selector && document.body) document.body.style.transform = "";
      const value = await withAbort(
        Promise.resolve().then(() => {
          signal?.throwIfAborted();
          return seek(signal);
        }),
        signal,
      );
      if (document.fonts && document.fonts.ready) {
        try {
          await withAbort(document.fonts.ready, signal);
        } catch (error) {
          if (signal?.aborted) throw signal.reason;
          throw new Error(
            `VELOCAST_FONT_LOAD_FAILED: ${String(error?.message || error)}`,
            { cause: error },
          );
        }
        if (typeof document.fonts[Symbol.iterator] === "function") {
          for (const font of document.fonts) {
            if (font.status === "error")
              throw new Error(`VELOCAST_FONT_LOAD_FAILED: ${font.family}`);
          }
        }
      }
      const target = selector ? findTarget(selector) : document;
      const images = Array.from(target.querySelectorAll("img"));
      if (target.tagName === "IMG") images.unshift(target);
      await Promise.all(
        images.map(async (image) => {
          const pictureSource =
            image.parentElement?.tagName === "PICTURE"
              ? image.parentElement
                  .querySelector("source[srcset]")
                  ?.getAttribute("srcset")
              : undefined;
          const requestedSource =
            image.currentSrc ||
            image.getAttribute("src")?.trim() ||
            image.getAttribute("srcset")?.trim() ||
            pictureSource?.trim();
          if (!requestedSource) return;
          try {
            signal?.throwIfAborted();
            await withAbort(image.decode(), signal);
          } catch (error) {
            if (signal?.aborted) throw signal.reason;
            const source = image.currentSrc || requestedSource;
            const message = String(error && (error.message || error));
            throw new Error(
              `VELOCAST_IMAGE_DECODE_FAILED: ${source}: ${message}`,
              { cause: error },
            );
          }
        }),
      );
      signal?.throwIfAborted();
      if (selector) this.prepareTarget(selector);
      const raf = window.requestAnimationFrame
        ? window.requestAnimationFrame.bind(window)
        : (callback) =>
            window.setTimeout(() => callback(window.performance.now()), 16);
      const cancelPaint = window.requestAnimationFrame
        ? window.cancelAnimationFrame?.bind(window)
        : window.clearTimeout?.bind(window);
      await new Promise((resolve, reject) => {
        let handle;
        const cleanup = () => signal?.removeEventListener("abort", abort);
        const abort = () => {
          if (handle !== undefined) cancelPaint?.(handle);
          cleanup();
          reject(signal.reason);
        };
        signal?.addEventListener("abort", abort, { once: true });
        handle = raf(() => {
          if (signal?.aborted) return;
          handle = raf(() => {
            cleanup();
            resolve();
          });
        });
      });
      signal?.throwIfAborted();
      assertBoundSession();
      return value;
    },

    selectTarget(selector) {
      if (
        document.body &&
        document.documentElement.dataset.velocastCaptureTarget
      ) {
        document.body.style.transform = "";
      }
      if (selector) {
        document.documentElement.dataset.velocastCaptureTarget = selector;
      } else {
        delete document.documentElement.dataset.velocastCaptureTarget;
        if (document.body) document.body.style.overflow = "hidden";
      }
    },

    prepareTarget(selector) {
      const target = findTarget(selector);
      if (document.body) document.body.style.transform = "";
      const rect = bounds(target, selector);
      document.documentElement.dataset.velocastCaptureTarget = selector;
      document.documentElement.style.overflow = "hidden";
      if (document.body) {
        // The render environment hides overflow with !important. Override it
        // before translating so off-viewport content is not clipped by body.
        document.body.style.setProperty("overflow", "visible", "important");
        document.body.style.transformOrigin = "0 0";
        document.body.style.transform = `translate(${-rect.left}px, ${-rect.top}px)`;
      }
    },

    measureSelector(selector) {
      const rect = bounds(findTarget(selector), selector);
      return { width: rect.width, height: rect.height };
    },
  };
})();

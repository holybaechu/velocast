"use strict";

class TextureLease {
  #held = null;
  #inFlight = false;
  #idleWaiters = [];

  get occupied() {
    return this.#held !== null;
  }

  retain(id, texture, metadata = null) {
    if (this.#held)
      throw new Error("Electron host already retains a shared texture");
    if (!texture || typeof texture.release !== "function") {
      throw new Error(
        "Electron paint did not contain a releasable shared texture",
      );
    }
    this.#held = { id, texture, metadata };
  }

  async consume(id, work) {
    if (!this.#held || this.#held.id !== id || this.#inFlight) {
      throw new Error(
        "Electron host received an unknown or busy shared texture",
      );
    }
    this.#inFlight = true;
    try {
      return await work(this.#held.metadata);
    } finally {
      this.#inFlight = false;
      try {
        this.releaseAll();
      } finally {
        for (const resolve of this.#idleWaiters.splice(0)) resolve();
      }
    }
  }

  waitForIdle() {
    if (!this.#inFlight) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  release(id) {
    if (!this.#held || this.#held.id !== id) {
      throw new Error(
        "Electron host received an unknown shared texture release",
      );
    }
    if (this.#inFlight)
      throw new Error("Electron host shared texture is still in use");
    this.releaseAll();
  }

  releaseAll() {
    if (this.#inFlight) return;
    const held = this.#held;
    this.#held = null;
    held?.texture.release();
  }
}

module.exports = { TextureLease };

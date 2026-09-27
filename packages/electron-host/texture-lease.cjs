"use strict";

class TextureLease {
  #held = null;

  get occupied() {
    return this.#held !== null;
  }

  retain(id, texture) {
    if (this.#held)
      throw new Error("Electron host already retains a shared texture");
    if (!texture || typeof texture.release !== "function") {
      throw new Error(
        "Electron paint did not contain a releasable shared texture",
      );
    }
    this.#held = { id, texture };
  }

  release(id) {
    if (!this.#held || this.#held.id !== id) {
      throw new Error(
        "Electron host received an unknown shared texture release",
      );
    }
    this.releaseAll();
  }

  releaseAll() {
    const held = this.#held;
    this.#held = null;
    held?.texture.release();
  }
}

module.exports = { TextureLease };

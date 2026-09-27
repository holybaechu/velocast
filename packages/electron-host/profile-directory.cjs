"use strict";

const fs = require("node:fs");
const path = require("node:path");

function configureProfileDirectory(app, directory) {
  if (app.isReady()) throw new Error("Electron profile must be configured before readiness");
  if (typeof directory !== "string" || !path.isAbsolute(directory) ||
      !fs.lstatSync(directory).isDirectory()) {
    throw new Error("Electron profile directory must be an existing absolute directory");
  }
  // Native creates and owns this directory for exactly one host process. Both
  // paths matter: sessionData contains disk caches and compiled GPU shaders.
  app.setPath("userData", directory);
  app.setPath("sessionData", directory);
}

module.exports = { configureProfileDirectory };

"use strict";
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.PIPE_TEST_ROOT;
fs.writeFileSync(path.join(root, "started"), String(process.pid));
function finish() {
  fs.writeFileSync(path.join(root, "finished"), "done");
  process.exit(0);
}
setInterval(() => {
  if (fs.existsSync(path.join(root, "stop"))) finish();
  if (process.env.PIPE_TEST_OWNED_GROUP === "1")
    fs.appendFileSync(path.join(root, "heartbeat"), "x");
}, 10);
setTimeout(finish, 10000);

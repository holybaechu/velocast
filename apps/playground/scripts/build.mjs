import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { URL } from "node:url";

const root = new URL("../", import.meta.url);
const output = new URL("dist/", root);
await mkdir(new URL("src/", output), { recursive: true });
await mkdir(new URL("assets/", output), { recursive: true });
const html = (await readFile(new URL("index.html", root), "utf8"))
  .replace("./node_modules/gsap/dist/gsap.min.js", "./assets/gsap.min.js")
  .replace(
    "../../packages/gsap/browser/velocast-gsap.global.js",
    "./assets/velocast-gsap.global.js",
  );
await writeFile(new URL("index.html", output), html);
for (const name of ["main.js", "product-hero.js", "style.css"])
  await copyFile(new URL(`src/${name}`, root), new URL(`src/${name}`, output));
const require = createRequire(import.meta.url);
await copyFile(
  require.resolve("gsap/dist/gsap.min.js"),
  new URL("assets/gsap.min.js", output),
);
await copyFile(
  new URL("../../packages/gsap/browser/velocast-gsap.global.js", root),
  new URL("assets/velocast-gsap.global.js", output),
);

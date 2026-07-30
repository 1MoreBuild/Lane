import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { Resvg } from "@resvg/resvg-js";

await build({
  entryPoints: ["src/main/index.ts"],
  outdir: "dist/main",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // pi-ai intentionally loads Node-only OAuth modules relative to its own
  // import.meta.url. Keep the package external so bundling cannot relocate
  // that provider-owned loader.
  external: ["electron", "@earendil-works/pi-ai", "@earendil-works/pi-ai/*"],
  sourcemap: true,
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  logLevel: "info",
});

const traySvg = await readFile("build/tray-icon.svg", "utf8");
const trayPng = new Resvg(traySvg, {
  fitTo: { mode: "width", value: 18 },
}).render().asPng();
const trayPng2x = new Resvg(traySvg, {
  fitTo: { mode: "width", value: 36 },
}).render().asPng();
await writeFile("dist/main/trayTemplate.png", trayPng);
await writeFile("dist/main/trayTemplate@2x.png", trayPng2x);

const mainBundle = await readFile("dist/main/index.js", "utf8");
if (!mainBundle.includes("@earendil-works/pi-ai")) {
  throw new Error("pi-ai must remain external so its relative OAuth loader stays valid");
}

await build({
  entryPoints: ["src/main/preload.ts"],
  outfile: "dist/main/preload.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  sourcemap: true,
  logLevel: "info",
});

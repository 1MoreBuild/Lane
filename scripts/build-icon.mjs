import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Resvg } from "@resvg/resvg-js";

const projectDir = resolve(import.meta.dirname, "..");
const sourcePath = join(projectDir, "build", "icon.svg");
const macOutputPath = join(projectDir, "build", "icon.icns");
const windowsOutputPath = join(projectDir, "build", "icon.ico");
const workDir = mkdtempSync(join(tmpdir(), "lane-icon-"));
const iconsetDir = join(workDir, "Lane.iconset");

const macSizes = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
];
const windowsSizes = [16, 24, 32, 48, 64, 128, 256];

function renderPng(svg, size) {
  return new Resvg(svg, {
    fitTo: { mode: "width", value: size },
    imageRendering: 0,
    shapeRendering: 2,
  }).render().asPng();
}

function encodeIco(images) {
  const headerSize = 6;
  const entrySize = 16;
  let imageOffset = headerSize + entrySize * images.length;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = images.map(({ size, png }) => {
    const entry = Buffer.alloc(entrySize);
    entry.writeUInt8(size === 256 ? 0 : size, 0);
    entry.writeUInt8(size === 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(imageOffset, 12);
    imageOffset += png.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map(({ png }) => png)]);
}

function assertTransparentMargin(image) {
  const { width, height, pixels } = image;
  const alphaAt = (x, y) => pixels[(y * width + x) * 4 + 3];
  const samples = [
    alphaAt(0, 0),
    alphaAt(width - 1, 0),
    alphaAt(0, height - 1),
    alphaAt(width - 1, height - 1),
    alphaAt(32, Math.floor(height / 2)),
    alphaAt(width - 33, Math.floor(height / 2)),
    alphaAt(Math.floor(width / 2), 32),
    alphaAt(Math.floor(width / 2), height - 33),
  ];
  if (samples.some((alpha) => alpha !== 0)) {
    throw new Error(`Icon margin must be transparent; got alpha values ${samples.join(", ")}`);
  }
}

try {
  const svg = readFileSync(sourcePath, "utf8");
  const source = new Resvg(svg, {
    fitTo: { mode: "width", value: 1024 },
    imageRendering: 0,
    shapeRendering: 2,
  }).render();
  if (source.width !== 1024 || source.height !== 1024) {
    throw new Error(`Expected a 1024×1024 icon, got ${source.width}×${source.height}`);
  }
  assertTransparentMargin(source);

  const sourcePng = join(workDir, "icon-1024.png");
  writeFileSync(sourcePng, source.asPng());
  const windowsImages = windowsSizes.map((size) => ({
    size,
    png: renderPng(svg, size),
  }));
  writeFileSync(windowsOutputPath, encodeIco(windowsImages));
  console.log(`Built transparent Windows icon: ${windowsOutputPath}`);

  if (process.platform === "darwin") {
    mkdirSync(iconsetDir);
    for (const [filename, size] of macSizes) {
      execFileSync("/usr/bin/sips", [
        "-z",
        String(size),
        String(size),
        sourcePng,
        "--out",
        join(iconsetDir, filename),
      ], { stdio: "ignore" });
    }
    const generatedPath = join(workDir, "Lane.icns");
    execFileSync("/usr/bin/iconutil", ["-c", "icns", iconsetDir, "-o", generatedPath]);
    cpSync(generatedPath, macOutputPath);
    console.log(`Built transparent macOS icon: ${macOutputPath}`);
  }
} finally {
  rmSync(workDir, { force: true, recursive: true });
}

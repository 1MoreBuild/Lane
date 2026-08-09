import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";

const projectRoot = new URL("../", import.meta.url);
const pkg = JSON.parse(await readFile(new URL("package.json", projectRoot), "utf8"));
const metadataUrl = new URL("release/latest-mac.yml", projectRoot);
const artifactNames = [
  `Lane-${pkg.version}-mac-arm64.dmg`,
  `Lane-${pkg.version}-mac-x64.dmg`,
];

let metadata = (await readFile(metadataUrl, "utf8")).replace(/\r\n/g, "\n");

for (const artifactName of artifactNames) {
  const artifactUrl = new URL(`release/${artifactName}`, projectRoot);
  const artifact = await readFile(artifactUrl);
  const artifactStat = await stat(artifactUrl);
  const sha512 = createHash("sha512").update(artifact).digest("base64");
  const escapedName = artifactName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const entryPattern = new RegExp(
    `(^  - url: ${escapedName}\\n    sha512: )[^\\n]+(\\n    size: )\\d+$`,
    "m",
  );

  if (!entryPattern.test(metadata)) {
    throw new Error(`Update metadata is missing ${artifactName}`);
  }
  metadata = metadata.replace(
    entryPattern,
    `$1${sha512}$2${artifactStat.size}`,
  );
}

for (const arch of ["arm64", "x64"]) {
  if (!metadata.includes(`url: Lane-${pkg.version}-mac-${arch}.zip`)) {
    throw new Error(`Update metadata is missing the ${arch} ZIP`);
  }
}

await writeFile(metadataUrl, metadata, "utf8");
console.log("Finalized macOS update metadata after DMG stapling.");

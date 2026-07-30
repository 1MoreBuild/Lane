import { readFile } from "node:fs/promises";
import process from "node:process";

const pkg = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
const expected = `v${pkg.version}`;

if (!tag) {
  throw new Error("Release tag is required");
}
if (!/^v\d+\.\d+\.\d+-test\.\d+$/.test(tag)) {
  throw new Error(`Test release tag must match v<major>.<minor>.<patch>-test.<number>: ${tag}`);
}
if (tag !== expected) {
  throw new Error(`Release tag ${tag} does not match package version ${expected}`);
}

console.log(`Release tag verified: ${tag}`);

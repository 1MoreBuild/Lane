import { readFile } from "node:fs/promises";
import process from "node:process";

const pkg = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
const channel = process.argv[3] ?? "test";
const expected = `v${pkg.version}`;

if (!tag) {
  throw new Error("Release tag is required");
}
if (channel !== "test" && channel !== "preview" && channel !== "stable") {
  throw new Error(`Release channel must be test, preview, or stable: ${channel}`);
}
const valid =
  channel === "stable" || channel === "preview"
    ? /^v\d+\.\d+\.\d+$/.test(tag)
    : /^v\d+\.\d+\.\d+-test\.\d+$/.test(tag);
if (!valid) {
  const format =
    channel === "stable" || channel === "preview"
      ? "v<major>.<minor>.<patch>"
      : "v<major>.<minor>.<patch>-test.<number>";
  throw new Error(`${channel} release tag must match ${format}: ${tag}`);
}
if (tag !== expected) {
  throw new Error(`Release tag ${tag} does not match package version ${expected}`);
}

console.log(`${channel} release tag verified: ${tag}`);

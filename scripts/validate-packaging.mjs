import { readFile } from "node:fs/promises";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const releaseWorkflow = await readFile(
  new URL("../.github/workflows/release-macos-test.yml", import.meta.url),
  "utf8",
);

const failures = [];
if (pkg.build?.appId !== "works.earendil.lane") failures.push("missing stable appId");
if (pkg.build?.asar !== true) failures.push("ASAR packaging must remain enabled");
if (pkg.license !== "0BSD") failures.push("project license must be 0BSD");
if (!pkg.build?.files?.includes("LICENSE")) failures.push("package omits project license");
if (!pkg.build?.files?.includes("THIRD_PARTY_NOTICES.md")) {
  failures.push("package omits third-party notices");
}
if (pkg.build?.disableAsarIntegrity === true) {
  failures.push("ASAR integrity hash computation must not be disabled");
}
if (!pkg.build?.mac?.target?.includes("dmg")) failures.push("missing macOS DMG target");
if (pkg.build?.mac?.identity !== null) {
  failures.push("test builds must explicitly remain unsigned");
}
if (!pkg.scripts?.["package:mac:arm64"]?.includes("--arm64")) {
  failures.push("missing Apple Silicon macOS test package script");
}
if (!pkg.scripts?.["package:mac:x64"]?.includes("--x64")) {
  failures.push("missing Intel macOS test package script");
}
if (pkg.scripts?.["package:mac:test"]?.includes("--universal")) {
  failures.push("test builds must not combine architectures into a universal app");
}
if (!pkg.scripts?.["smoke:dmg:mac"]) failures.push("missing DMG install smoke test");
const winTarget = pkg.build?.win?.target?.[0];
if (winTarget?.target !== "nsis") failures.push("missing Windows NSIS target");
if (!winTarget?.arch?.includes("x64") || !winTarget?.arch?.includes("arm64")) {
  failures.push("Windows x64 and arm64 must both be configured");
}
if (!workflow.includes("windows-latest")) failures.push("CI lacks a Windows job");
if (!workflow.includes("npm run validate:packaging")) failures.push("CI does not validate packaging");
if (!workflow.includes("permissions:\n  contents: read")) {
  failures.push("CI permissions are not read-only");
}
if (/uses:\s+actions\/[^@\s]+@v\d+/.test(`${workflow}\n${releaseWorkflow}`)) {
  failures.push("GitHub Actions must be pinned to full commit SHAs");
}
if (!releaseWorkflow.includes('tags: ["v*-test.*"]')) {
  failures.push("test release workflow lacks a narrow tag trigger");
}
if (!releaseWorkflow.includes("publish:\n") || !releaseWorkflow.includes("      contents: write")) {
  failures.push("release publish job cannot create GitHub Releases");
}
if (!releaseWorkflow.includes("npm run smoke:dmg:mac")) {
  failures.push("test release workflow does not install-smoke the DMG");
}
if (!releaseWorkflow.includes("macos-latest") || !releaseWorkflow.includes("macos-15-intel")) {
  failures.push("test release workflow must build on native Apple Silicon and Intel runners");
}
if (!releaseWorkflow.includes("gh release create")) {
  failures.push("test release workflow does not publish a GitHub prerelease");
}
if (failures.length > 0) {
  throw new Error(`Packaging validation failed: ${failures.join(", ")}`);
}
console.log("Packaging config valid: macOS DMG/dir and Windows NSIS x64+arm64; Windows CI present.");

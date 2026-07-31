import { readFile } from "node:fs/promises";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const releaseWorkflow = await readFile(
  new URL("../.github/workflows/release-macos-test.yml", import.meta.url),
  "utf8",
);
const stableReleaseWorkflow = await readFile(
  new URL("../.github/workflows/release.yml", import.meta.url),
  "utf8",
);

const failures = [];
if (Object.keys(pkg.scripts ?? {}).some((name) => name.startsWith("smoke"))) {
  failures.push("release validation must use product E2E instead of smoke scripts");
}
if (/\bsmoke\b/i.test(`${workflow}\n${releaseWorkflow}\n${stableReleaseWorkflow}`)) {
  failures.push("GitHub workflows must not use smoke tests as release gates");
}
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
if (!pkg.build?.mac?.target?.includes("zip")) failures.push("macOS auto-update ZIP target missing");
if (pkg.build?.mac?.electronUpdaterCompatibility !== ">=2.16") {
  failures.push("macOS updater metadata must use the architecture-aware files format");
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
if (!pkg.scripts?.["package:mac:arm64"]?.includes("CSC_IDENTITY_AUTO_DISCOVERY=false")) {
  failures.push("Apple Silicon test build may select an unintended signing identity");
}
if (!pkg.scripts?.["package:mac:x64"]?.includes("CSC_IDENTITY_AUTO_DISCOVERY=false")) {
  failures.push("Intel test build may select an unintended signing identity");
}
if (
  !pkg.scripts?.["package:mac:release"]?.includes("--arm64 --x64") ||
  !pkg.scripts?.["package:mac:release"]?.includes("forceCodeSigning=true") ||
  !pkg.scripts?.["package:mac:release"]?.includes("build:release")
) {
  failures.push("stable macOS release lacks signing, updater, or per-architecture builds");
}
if (
  pkg.build?.publish?.[0]?.provider !== "github" ||
  pkg.build?.publish?.[0]?.owner !== "1MoreBuild" ||
  pkg.build?.publish?.[0]?.repo !== "Lane"
) {
  failures.push("GitHub auto-update provider is not configured");
}
if (!pkg.scripts?.e2e || !pkg.devDependencies?.["@playwright/test"]) {
  failures.push("missing Playwright product E2E suite");
}
for (const script of ["e2e:mac:arm64", "e2e:mac:x64", "e2e:win:x64", "e2e:dmg:mac"]) {
  if (!pkg.scripts?.[script]) failures.push(`missing ${script} product E2E command`);
}
if (
  !pkg.scripts?.["e2e:mac:arm64"]?.includes(
    "release/mac-arm64/Lane.app/Contents/MacOS/Lane",
  ) ||
  !pkg.scripts?.["e2e:mac:x64"]?.includes(
    "release/mac/Lane.app/Contents/MacOS/Lane",
  ) ||
  !pkg.scripts?.["e2e:win:x64"]?.includes("release/win-unpacked/Lane.exe")
) {
  failures.push("packaged E2E commands do not select explicit architecture outputs");
}
const winTarget = pkg.build?.win?.target?.[0];
if (winTarget?.target !== "nsis") failures.push("missing Windows NSIS target");
if (!winTarget?.arch?.includes("x64") || !winTarget?.arch?.includes("arm64")) {
  failures.push("Windows x64 and arm64 must both be configured");
}
if (!workflow.includes("windows-latest")) failures.push("CI lacks a Windows job");
if (!workflow.includes("npm run check")) failures.push("CI does not run the full validation suite");
if (!workflow.includes("e2e:mac:arm64") || !workflow.includes("e2e:win:x64")) {
  failures.push("CI does not run packaged product E2E on macOS and Windows");
}
if (!workflow.includes("permissions:\n  contents: read")) {
  failures.push("CI permissions are not read-only");
}
if (
  /uses:\s+actions\/[^@\s]+@v\d+/.test(
    `${workflow}\n${releaseWorkflow}\n${stableReleaseWorkflow}`,
  )
) {
  failures.push("GitHub Actions must be pinned to full commit SHAs");
}
if (!releaseWorkflow.includes('tags: ["v*-test.*"]')) {
  failures.push("test release workflow lacks a narrow tag trigger");
}
if (!releaseWorkflow.includes("publish:\n") || !releaseWorkflow.includes("      contents: write")) {
  failures.push("release publish job cannot create GitHub Releases");
}
if (!releaseWorkflow.includes("npm run e2e:dmg:mac")) {
  failures.push("test release workflow does not run installed DMG E2E");
}
if (!releaseWorkflow.includes("macos-latest") || !releaseWorkflow.includes("macos-15-intel")) {
  failures.push("test release workflow must build on native Apple Silicon and Intel runners");
}
if (!releaseWorkflow.includes("gh release create")) {
  failures.push("test release workflow does not publish a GitHub prerelease");
}
if (!stableReleaseWorkflow.includes("npm run package:mac:release")) {
  failures.push("stable release workflow does not build updater artifacts");
}
if (
  !stableReleaseWorkflow.includes(
    'node scripts/verify-release-tag.mjs "$GITHUB_REF_NAME" stable',
  )
) {
  failures.push("stable release workflow does not enforce a stable version tag");
}
if (
  !stableReleaseWorkflow.includes("release/latest-mac.yml") ||
  !stableReleaseWorkflow.includes("release/Lane-*-mac-*.zip")
) {
  failures.push("stable release workflow omits macOS updater metadata or ZIP");
}
if (
  !stableReleaseWorkflow.includes("codesign --verify") ||
  !stableReleaseWorkflow.includes("xcrun stapler validate")
) {
  failures.push("stable release workflow does not verify signing and notarization");
}
for (const secret of [
  "MAC_CSC_LINK",
  "MAC_CSC_KEY_PASSWORD",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
]) {
  if (!stableReleaseWorkflow.includes(`secrets.${secret}`)) {
    failures.push(`stable release workflow is missing ${secret}`);
  }
}
if (
  !stableReleaseWorkflow.includes("runs-on: macos-15-intel") ||
  !stableReleaseWorkflow.includes("LANE_E2E_ARCH: x64") ||
  !stableReleaseWorkflow.includes("needs: [build, intel-e2e]")
) {
  failures.push("stable release can publish without product E2E on real Intel hardware");
}
const stablePublish = stableReleaseWorkflow.indexOf("gh release create");
for (const requiredGate of [
  "codesign --verify",
  "xcrun stapler validate",
  "npm run e2e:dmg:mac",
  "shasum -a 256",
]) {
  const gateIndex = stableReleaseWorkflow.indexOf(requiredGate);
  if (gateIndex === -1 || stablePublish === -1 || gateIndex > stablePublish) {
    failures.push(`stable release publishes before ${requiredGate}`);
  }
}
if (failures.length > 0) {
  throw new Error(`Packaging validation failed: ${failures.join(", ")}`);
}
console.log("Packaging config valid: macOS DMG/dir and Windows NSIS x64+arm64; Windows CI present.");

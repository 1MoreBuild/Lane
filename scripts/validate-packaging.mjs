import { readFile } from "node:fs/promises";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
async function readWorkflow(path) {
  return (await readFile(new URL(path, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
}

const workflow = await readWorkflow("../.github/workflows/ci.yml");
const releaseWorkflow = await readWorkflow("../.github/workflows/release-macos-test.yml");
const stableReleaseWorkflow = await readWorkflow("../.github/workflows/release.yml");
const windowsPreviewWorkflow = await readWorkflow("../.github/workflows/windows-preview.yml");
const productE2E = await readWorkflow("../e2e/lane.e2e.spec.ts");
const dmgE2E = await readWorkflow("./e2e-dmg.mjs");
const nsisE2E = await readWorkflow("./e2e-nsis-windows.mjs");
const nativeHostBuild = await readWorkflow("./build-native-host.mjs");
const nativeHostSource = await readWorkflow("../native-host/lane-native-host.go");
const windowsInstallerInclude = await readWorkflow("../build/installer.nsh");
const windowsSignatureVerification = await readWorkflow("./verify-signed-windows.ps1");
const windowsReleaseConfig = await readWorkflow("./electron-builder.windows-release.mjs");

const failures = [];
if (/\.\.\.process\.env/.test(`${productE2E}\n${dmgE2E}\n${nsisE2E}`)) {
  failures.push("product E2E must not copy arbitrary host secrets into child processes");
}
if (Object.keys(pkg.scripts ?? {}).some((name) => name.startsWith("smoke"))) {
  failures.push("release validation must use product E2E instead of smoke scripts");
}
if (
  /\bsmoke\b/i.test(
    `${workflow}\n${releaseWorkflow}\n${stableReleaseWorkflow}\n${windowsPreviewWorkflow}`,
  )
) {
  failures.push("GitHub workflows must not use smoke tests as release gates");
}
if (pkg.build?.appId !== "works.earendil.lane") failures.push("missing stable appId");
if (pkg.build?.asar !== true) failures.push("ASAR packaging must remain enabled");
if (pkg.license !== "MIT") failures.push("project license must be MIT");
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
if (pkg.build?.mac?.hardenedRuntime !== true || pkg.build?.mac?.notarize !== true) {
  failures.push("stable macOS packages must enable hardened runtime and notarization");
}
if (
  pkg.build?.mac?.entitlements !== "build/entitlements.mac.plist" ||
  pkg.build?.mac?.entitlementsInherit !== "build/entitlements.mac.inherit.plist"
) {
  failures.push("macOS signing must use the reviewed Lane entitlements");
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
for (const script of [
  "package:mac",
  "package:mac:arm64",
  "package:mac:x64",
  "package:e2e:mac:arm64",
  "package:e2e:mac:x64",
]) {
  if (!pkg.scripts?.[script]?.includes("-c.mac.identity=-")) {
    failures.push(`${script} must create a complete ad-hoc bundle signature`);
  }
}
if (
  !pkg.scripts?.["package:mac:release:dist"]?.includes("--arm64 --x64") ||
  !pkg.scripts?.["package:mac:release:dist"]?.includes("forceCodeSigning=true") ||
  !pkg.scripts?.["package:mac:release:prepare"]?.includes("build:release") ||
  !pkg.scripts?.["package:mac:release"]?.includes("package:mac:release:prepare") ||
  !pkg.scripts?.["package:mac:release"]?.includes("package:mac:release:dist")
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
if (winTarget?.arch?.length !== 1 || winTarget.arch[0] !== "x64") {
  failures.push("Windows stable installer must target the verified x64 architecture");
}
if (pkg.build?.win?.icon !== "build/icon.ico") {
  failures.push("Windows package does not use the reviewed Lane icon");
}
if (pkg.build?.win?.artifactName !== "${productName}-${version}-windows-setup.${ext}") {
  failures.push("Windows installer name is not stable or updater-safe");
}
if (
  pkg.build?.win?.extraResources?.[0]?.from !==
    "build/native-host/${arch}/lane-native-host.exe" ||
  pkg.build?.win?.extraResources?.[0]?.to !== "bin/lane-native-host.exe" ||
  pkg.build?.win?.extraResources?.[1]?.from !==
    "build/native-host/${arch}/lane-cli.exe" ||
  pkg.build?.win?.extraResources?.[1]?.to !== "bin/lane-cli.exe" ||
  pkg.build?.nsis?.include !== "build/installer.nsh"
) {
  failures.push("Windows package does not include its native host and CLI launcher");
}
if (
  !pkg.scripts?.["package:win:prepare"]?.includes("npm run build:icon") ||
  !pkg.scripts?.["package:win:prepare"]?.includes("npm run build:native-host") ||
  !pkg.scripts?.["package:win:dist"]?.includes("--x64") ||
  pkg.scripts?.["package:win:dist"]?.includes("--arm64") ||
  !pkg.scripts?.["package:win"]?.includes("package:win:prepare") ||
  !pkg.scripts?.["package:win"]?.includes("package:win:dist")
) {
  failures.push("Windows preview package does not build the icon and verified x64 NSIS");
}
if (
  !pkg.scripts?.["package:win:release:prepare"]?.includes("build:release") ||
  !pkg.scripts?.["package:win:release:prepare"]?.includes("build:native-host") ||
  !pkg.scripts?.["package:win:release:dist"]?.includes("--x64") ||
  pkg.scripts?.["package:win:release:dist"]?.includes("--arm64") ||
  !pkg.scripts?.["package:win:release:dist"]?.includes("forceCodeSigning=true") ||
  !pkg.scripts?.["package:win:release"]?.includes("package:win:release:prepare") ||
  !pkg.scripts?.["package:win:release"]?.includes("package:win:release:dist")
) {
  failures.push("Windows stable release is not updater-enabled, signed, and x64");
}
if (!pkg.scripts?.["e2e:nsis:win"]) {
  failures.push("missing installed Windows NSIS product E2E command");
}
if (!nsisE2E.includes('"reg.exe"') || nsisE2E.includes('"powershell.exe"')) {
  failures.push("Windows NSIS E2E must inspect installed products without PowerShell startup");
}
if (!nsisE2E.includes('stdio: "ignore"') || !nsisE2E.includes("timeout: 300_000")) {
  failures.push("Windows NSIS E2E must tolerate signed installer scanning without pipe leaks");
}
if (!nsisE2E.includes('setTimeout as delay') || !nsisE2E.includes('"EBUSY"')) {
  failures.push("Windows NSIS E2E must wait for the asynchronous uninstaller to release files");
}
if (!nsisE2E.includes('`_?=${installedDirectory}`')) {
  failures.push("Windows NSIS E2E must wait for the real uninstaller process");
}
if (
  !windowsSignatureVerification.includes("Get-AuthenticodeSignature") ||
  !windowsSignatureVerification.includes("AZURE_SIGNING_PUBLISHER_NAME") ||
  !windowsSignatureVerification.includes("GetNameInfo") ||
  !windowsSignatureVerification.includes("TimeStamperCertificate") ||
  !windowsSignatureVerification.includes("release\\latest.yml") ||
  !windowsSignatureVerification.includes("$installerName.blockmap")
) {
  failures.push("Windows stable release does not verify signatures and updater metadata");
}
for (const option of [
  "azureSignOptions",
  "afterPack",
  "signIf",
  "lane-cli.exe",
  "lane-native-host.exe",
  "AZURE_SIGNING_PUBLISHER_NAME",
  "AZURE_SIGNING_ENDPOINT",
  "AZURE_SIGNING_CERTIFICATE_PROFILE_NAME",
  "AZURE_SIGNING_ACCOUNT_NAME",
]) {
  if (!windowsReleaseConfig.includes(option)) {
    failures.push(`Windows Azure Artifact Signing configuration is missing ${option}`);
  }
}
if (
  !windowsInstallerInclude.includes("${ifNot} ${isUpdated}") ||
  !windowsInstallerInclude.includes("@rem Lane CLI launcher v1")
) {
  failures.push("Windows upgrades can remove an enabled Lane CLI launcher");
}
if (
  !pkg.scripts?.["build:native-host"] ||
  !pkg.scripts?.["package:e2e:win:x64"]?.includes("build:native-host") ||
  !nativeHostBuild.includes("GOARCH") ||
  !nativeHostBuild.includes("GO_ARCHIVE_SHA256") ||
  !nativeHostSource.includes("mdjfkiddlpdgchddcckhcmdjekmmhcgp") ||
  !nativeHostSource.includes(`userDataDirName     = "${pkg.name}"`) ||
  productE2E.includes("Windows Native Messaging requires a dedicated binary host")
) {
  failures.push("Windows Native Messaging host is not built, pinned, allowlisted, and tested");
}
if (
  !windowsPreviewWorkflow.includes("runs-on: windows-latest") ||
  !windowsPreviewWorkflow.includes("npm run package:win") ||
  (windowsPreviewWorkflow.match(/npm run e2e:nsis:win/g) ?? []).length !== 1
) {
  failures.push("Windows preview workflow lacks installed x64 product E2E");
}
if (!windowsPreviewWorkflow.includes("permissions:\n  contents: read")) {
  failures.push("Windows preview workflow permissions are not read-only");
}
for (const artifact of [
  "release/Lane-*-windows-setup.exe",
  "release/Lane-*-windows-setup.exe.blockmap",
  "release/latest.yml",
  "release/SHA256SUMS-windows",
]) {
  if (!windowsPreviewWorkflow.includes(artifact)) {
    failures.push(`Windows preview workflow omits ${artifact}`);
  }
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
    `${workflow}\n${releaseWorkflow}\n${stableReleaseWorkflow}\n${windowsPreviewWorkflow}`,
  )
) {
  failures.push("GitHub Actions must be pinned to full commit SHAs");
}
if (!releaseWorkflow.includes('tags: ["v*-test.*"]')) {
  failures.push("test release workflow lacks a narrow tag trigger");
}
if (
  !releaseWorkflow.includes("confirm_unsigned:") ||
  !releaseWorkflow.includes('test "$CONFIRM_UNSIGNED" = "UNSIGNED"') ||
  !releaseWorkflow.includes('verify-release-tag.mjs "$RELEASE_TAG" preview')
) {
  failures.push("manual unsigned preview publishing lacks an explicit confirmation gate");
}
if (!releaseWorkflow.includes("publish:\n") || !releaseWorkflow.includes("      contents: write")) {
  failures.push("release publish job cannot create GitHub Releases");
}
if (!releaseWorkflow.includes("npm run e2e:dmg:mac")) {
  failures.push("test release workflow does not run installed DMG E2E");
}
if (
  !releaseWorkflow.includes("codesign --verify --deep --strict") ||
  !releaseWorkflow.includes("Signature=adhoc")
) {
  failures.push("test release workflow does not reject malformed app bundle signatures");
}
if (!releaseWorkflow.includes("macos-latest") || !releaseWorkflow.includes("macos-15-intel")) {
  failures.push("test release workflow must build on native Apple Silicon and Intel runners");
}
if (!releaseWorkflow.includes("gh release create")) {
  failures.push("test release workflow does not publish a GitHub prerelease");
}
if (!releaseWorkflow.includes("--prerelease")) {
  failures.push("unsigned macOS releases must remain GitHub prereleases");
}
if (
  !stableReleaseWorkflow.includes("npm run package:mac:release:prepare") ||
  !stableReleaseWorkflow.includes("npm run package:mac:release:dist")
) {
  failures.push("stable release workflow does not build updater artifacts");
}
if (
  !stableReleaseWorkflow.includes("npm run package:win:release:prepare") ||
  !stableReleaseWorkflow.includes("npm run package:win:release:dist") ||
  !stableReleaseWorkflow.includes("./scripts/verify-signed-windows.ps1")
) {
  failures.push("stable release workflow does not build and verify Windows updater artifacts");
}
if (
  !stableReleaseWorkflow.includes("workflow_dispatch:") ||
  !stableReleaseWorkflow.includes("if: github.event_name == 'push'")
) {
  failures.push("stable release workflow lacks a non-publishing signed release-candidate run");
}
const stableBuildHeader = stableReleaseWorkflow.slice(
  stableReleaseWorkflow.indexOf("  build:"),
  stableReleaseWorkflow.indexOf("    steps:"),
);
if (/^ {4}env:/m.test(stableBuildHeader)) {
  failures.push("signing credentials must not be available to the entire release job");
}
if (
  stableReleaseWorkflow.indexOf("npm run package:mac:release:prepare") >
  stableReleaseWorkflow.indexOf("secrets.MAC_CSC_LINK")
) {
  failures.push("release preparation must run before signing credentials enter scope");
}
if (
  stableReleaseWorkflow.indexOf("npm run package:win:release:prepare") >
  stableReleaseWorkflow.indexOf("secrets.AZURE_CLIENT_SECRET")
) {
  failures.push("Windows release preparation must run before signing credentials enter scope");
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
  !stableReleaseWorkflow.includes("release/Lane-*-mac-*.zip") ||
  !stableReleaseWorkflow.includes("release/Lane-*-mac-*.zip.blockmap")
) {
  failures.push("stable release workflow omits macOS updater metadata, ZIP, or ZIP blockmap");
}
for (const artifact of [
  "release/Lane-*-windows-setup.exe",
  "release/Lane-*-windows-setup.exe.blockmap",
  "release/latest.yml",
  "release/SHA256SUMS-windows",
]) {
  if (!stableReleaseWorkflow.includes(artifact)) {
    failures.push(`stable release workflow omits Windows updater artifact ${artifact}`);
  }
}
if (stableReleaseWorkflow.includes("release/*.blockmap")) {
  failures.push("stable release workflow publishes unused DMG blockmaps");
}
if (
  !stableReleaseWorkflow.includes("bash scripts/verify-signed-macos.sh")
) {
  failures.push("stable release workflow does not verify signing and notarization");
}
if (
  !stableReleaseWorkflow.includes("xcrun notarytool submit") ||
  !stableReleaseWorkflow.includes("xcrun stapler staple")
) {
  failures.push("stable release workflow does not notarize and staple final DMGs");
}
if (!stableReleaseWorkflow.includes("npm run finalize:mac:update-metadata")) {
  failures.push("stable release workflow leaves stale DMG checksums in update metadata");
}
for (const secret of [
  "MAC_CSC_LINK",
  "MAC_CSC_KEY_PASSWORD",
  "APPLE_API_KEY_P8_BASE64",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
  "APPLE_TEAM_ID",
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
]) {
  if (!stableReleaseWorkflow.includes(`secrets.${secret}`)) {
    failures.push(`stable release workflow is missing ${secret}`);
  }
}
for (const variable of [
  "AZURE_SIGNING_ENDPOINT",
  "AZURE_SIGNING_ACCOUNT_NAME",
  "AZURE_SIGNING_CERTIFICATE_PROFILE_NAME",
  "AZURE_SIGNING_PUBLISHER_NAME",
]) {
  if (!stableReleaseWorkflow.includes(`vars.${variable}`)) {
    failures.push(`stable release workflow is missing ${variable}`);
  }
}
if (
  !stableReleaseWorkflow.includes("runs-on: macos-15-intel") ||
  !stableReleaseWorkflow.includes("LANE_E2E_ARCH: x64") ||
  !stableReleaseWorkflow.includes(
    "needs: [build, intel-e2e, windows-build]",
  )
) {
  failures.push("stable release can publish without product E2E on real Intel hardware");
}
if (
  !stableReleaseWorkflow.includes("runs-on: windows-latest") ||
  (stableReleaseWorkflow.match(/npm run e2e:nsis:win/g) ?? []).length !== 1 ||
  !stableReleaseWorkflow.includes("needs: [build, intel-e2e, windows-build]")
) {
  failures.push("stable release can publish without Windows x64 product E2E");
}
const stablePublish = stableReleaseWorkflow.indexOf("gh release create");
for (const requiredGate of [
  "bash scripts/verify-signed-macos.sh",
  "npm run e2e:dmg:mac",
  "npm run e2e:nsis:win",
  "shasum -a 256",
  "Get-FileHash -Algorithm SHA256",
]) {
  const gateIndex = stableReleaseWorkflow.indexOf(requiredGate);
  if (gateIndex === -1 || stablePublish === -1 || gateIndex > stablePublish) {
    failures.push(`stable release publishes before ${requiredGate}`);
  }
}
if (failures.length > 0) {
  throw new Error(`Packaging validation failed: ${failures.join(", ")}`);
}
console.log("Packaging config valid: signed dual-architecture macOS and verified x64 Windows updater releases; unsigned previews remain isolated.");

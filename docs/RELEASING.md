# Releasing Lane

Lane is not ready for public distribution merely because a local package opens.
Treat a release as a signed, reproducible artifact with a tested upgrade and
rollback path.

## Current release boundary

- macOS arm64 builds and launch/CLI smoke tests run on the current Mac.
- macOS output is unsigned. It is suitable for local testing, not public
  download.
- Windows NSIS x64 and arm64 configuration and CI checks exist. Windows runtime
  behavior has not been verified on a Windows host.
- ChatGPT / Codex login requires interactive acceptance with an eligible account.
  Automated tests do not claim that a real account can log in.
- Automated tests use mock providers and never make a paid generation request.
- No automatic updater or telemetry service is included.

## Before the first public beta

1. Decide when the source repository should become public. Lane is licensed
   under MIT; repository visibility remains a separate release decision.
2. Confirm the product name, `works.earendil.lane` application identifier,
   versioning policy, support address, privacy statement, and release owner.
3. Protect `main` and require the CI workflow for pull requests.
4. Add a release workflow that builds only from a version tag and publishes
   immutable artifacts, SHA-256 checksums, and release notes.
5. Keep signing credentials in the release environment's secret store. Never
   commit certificates, private keys, API keys, or notarization credentials.

## macOS direct distribution

Public downloads outside the Mac App Store need:

- Apple Developer Program membership and a Developer ID Application
  certificate;
- hardened runtime and the narrowest possible entitlements;
- signing for the app and every nested executable, including the packaged
  `lane` launcher;
- Apple notarization for the final DMG and a stapled notarization ticket;
- verification on a clean Mac with Gatekeeper enabled.

The unsigned local build keeps `build.mac.identity` disabled so ordinary CI and
contributors do not accidentally select an unrelated local certificate. The
release workflow must supply the intended identity and notarization credentials
explicitly.

Verify a release candidate with:

```bash
codesign --verify --deep --strict --verbose=2 Lane.app
spctl --assess --type execute --verbose=4 Lane.app
xcrun stapler validate Lane.dmg
```

Apple guidance:

- [Signing Mac software with Developer ID](https://developer.apple.com/developer-id/)
- [Notarizing macOS software](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)

## Windows distribution

Run the NSIS installer on clean x64 and arm64 Windows hosts before making a
Windows runtime claim. Test install, launch, secure storage, loopback binding,
CLI/control behavior, upgrade, uninstall, and rollback.

Sign the application binaries and installer with a certificate trusted by
Windows. A self-signed certificate is for local testing only and does not make a
public download trustworthy.

Microsoft guidance:

- [Code signing options for Windows app developers](https://learn.microsoft.com/windows/apps/package-and-deploy/code-signing-options)

## Release candidate checks

Run from a clean checkout:

```bash
npm ci
npm audit
npm run check
npm run build
npm run package:mac
npm run smoke:mac
npm run smoke:cli:mac
```

Then verify:

- the Git tag, app version, release notes, checksums, and artifacts agree;
- the macOS ASAR hash exists in `ElectronAsarIntegrity`;
- no secret, local path, temporary file, or development server URL is packaged;
- the gateway still binds only to `127.0.0.1`;
- missing or incorrect Lane keys return `401`, and disallowed origins are
  rejected;
- removing a provider clears its secret;
- restart restores provider settings, default models, logs, and gateway state;
- port conflicts and expired credentials produce redacted diagnostics;
- real OAuth login is performed only as an explicit interactive acceptance
  step;
- a manual generation smoke request uses a test account/budget and is never
  hidden inside automated CI.

Publish a beta only after the signed artifacts pass these checks on clean target
machines. Keep the previous signed release available until the upgrade path has
been exercised.

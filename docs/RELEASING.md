# Releasing Lane

Lane is not ready for public distribution merely because a local package opens.
Treat a release as a signed, reproducible artifact with a tested upgrade and
rollback path.

## Current release boundary

- The source repository is public under the permissive MIT license.
- Packaged macOS product E2E runs against a local mock provider on the current
  Mac.
- macOS output is unsigned. It is suitable for local testing, not public
  download.
- Tags matching `v*-test.*` create separate unsigned Apple Silicon and Intel
  DMGs as a GitHub prerelease. Each DMG is installed and driven through the
  complete provider, gateway, API, security, and restart journey on a native
  runner before publishing. These builds are for early feedback only.
- While signing is unavailable, the same workflow can be dispatched manually
  with a stable SemVer tag and the explicit confirmation `UNSIGNED`. It still
  publishes a GitHub prerelease, never enables automatic updates, and must not
  be described as signed, notarized, or Apple-trusted.
- Windows NSIS x64 packaging and packaged-product E2E run on a Windows host for
  the UI, API, security, persistence, port-conflict, and CLI journeys. Windows
  Native Messaging is not shipped until Lane has a dedicated binary host.
- ChatGPT / Codex login requires interactive acceptance with an eligible account.
  Automated tests do not claim that a real account can log in.
- Automated tests use mock providers and never make a paid generation request.
- Stable builds use `electron-updater` with public GitHub Releases. Unsigned
  previews cannot auto-update. No telemetry service is included.

## Before the first public beta

1. Confirm the product name, `works.earendil.lane` application identifier,
   versioning policy, support address, privacy statement, and release owner.
2. Protect `main` and require the CI workflow for pull requests.
3. Add the required GitHub Actions secrets for Developer ID signing and Apple
   notarization. The stable release workflow refuses an unsigned build.
4. Keep signing credentials in the release environment's secret store. Never
   commit certificates, private keys, API keys, or notarization credentials.

### Chrome Web Store integration gate

Transly's Chrome Web Store draft and public key have been verified. Its
production extension ID is:

```text
mdjfkiddlpdgchddcckhcmdjekmmhcgp
```

Transly's checked-in Web Store public key gives local unpacked and store builds
this same production ID.

Before each public Lane release:

1. Confirm Transly's manifest still contains the verified Web Store public key.
2. Confirm the unpacked extension ID and Dashboard item ID still match the
   production ID above.
3. Confirm Lane's Native Messaging and CORS allowlists contain exactly the
   production ID.
4. Run the Native Messaging allowlist and packaged launch tests.

Never replace the allowlist with a wildcard.

## macOS direct distribution

Public downloads outside the Mac App Store need:

- Apple Developer Program membership and a Developer ID Application
  certificate;
- hardened runtime and the narrowest possible entitlements;
- signing for the app and every nested executable, including the packaged
  `lane` launcher;
- Apple notarization for the final DMG and a stapled notarization ticket;
- verification on a clean Mac with Gatekeeper enabled.

Unsigned test scripts disable signing identity discovery so ordinary CI and
contributors do not accidentally select an unrelated local certificate. The
stable release workflow supplies the intended identity and notarization
credentials explicitly and sets `forceCodeSigning`.

Stable version tags such as `v0.1.0` build separate Apple Silicon and Intel DMG
and ZIP artifacts, `latest-mac.yml`, checksums, and a GitHub Release. The ZIP and
metadata are required by the standard Squirrel.Mac update path. Publishing waits
for signature/notarization checks and installed-product E2E on both Apple
Silicon and a real Intel runner. Prerelease tags such as
`v0.1.1-test.1` remain unsigned, manual-install feedback builds.

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
npm run package:mac:arm64
LANE_E2E_ARCH=arm64 npm run e2e:dmg:mac
```

Then verify:

- the Git tag, app version, release notes, checksums, and artifacts agree;
- update from the previous signed release downloads, restarts, preserves
  settings, and can be rolled back manually;
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
- a manual generation acceptance request uses a test account/budget and is never
  hidden inside automated CI.

Publish a beta only after the signed artifacts pass these checks on clean target
machines. Keep the previous signed release available until the upgrade path has
been exercised.

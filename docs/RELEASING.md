# Releasing Lane

Lane is not ready for public distribution merely because a local package opens.
Treat a release as a signed, reproducible artifact with a tested upgrade and
rollback path.

## Current release boundary

- The source repository is public under the permissive MIT license.
- Stable macOS releases are Developer ID signed, notarized, stapled, and
  published as separate Apple Silicon and Intel artifacts.
- Stable publication waits for signature and notarization verification plus
  installed-product E2E on native Apple Silicon and Intel GitHub runners.
- Packaged-product E2E uses a deterministic local mock provider and isolated
  user data. It never sends a paid or subscription model request.
- Preview macOS output has a complete ad-hoc bundle signature so Gatekeeper does
  not misreport it as damaged. It is still not Developer ID signed or notarized
  and is suitable only for explicitly trusted early testers.
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
- Stable builds use `electron-updater` with public GitHub Releases and install
  only after user confirmation. Unsigned previews cannot auto-update. No
  telemetry service is included.

## Release invariants

1. Keep `works.earendil.lane`, the product name, version, release notes, update
   metadata, and downloadable artifacts consistent.
2. Protect `main` and require the CI workflow for pull requests.
3. Keep Developer ID and App Store Connect credentials in GitHub Actions
   secrets. The stable workflow must refuse an unsigned build.
4. Never commit certificates, private keys, API keys, or notarization
   credentials.
5. Add one `.changes` fragment for every user-visible pull request. During an
   explicitly authorized release, curate those fragments into `CHANGELOG.md`
   and remove the consumed files before tagging.

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

Preview scripts disable signing identity discovery so ordinary CI and
contributors do not accidentally select an unrelated local certificate. They
explicitly select electron-builder's `identity=-` ad-hoc signing path, then
require strict bundle-signature verification before product E2E or publishing.
The stable release workflow supplies the intended identity and notarization
credentials explicitly and sets `forceCodeSigning`.

Stable version tags such as `v0.1.0` build separate Apple Silicon and Intel DMG
and ZIP artifacts, ZIP blockmaps, `latest-mac.yml`, checksums, and a GitHub
Release. The ZIP, its blockmap, and metadata support the standard Squirrel.Mac
update path and differential downloads. DMG blockmaps are not published because
Lane's updater never consumes them. Publishing waits for signature/notarization
checks and installed-product E2E on both Apple Silicon and a real Intel runner.
Prerelease tags such as `v0.1.1-test.1` remain unsigned, manual-install feedback
builds.

Before creating a stable tag, run the `Release` workflow manually from `main`.
The manual run uses the same signing, notarization, stapling, verification, and
two-architecture product E2E path, but it does not create a GitHub Release. This
proves the hosted-runner credentials and release artifacts without publishing a
version that cannot be replaced.

Then review `CHANGELOG.md`, bump `package.json` and `package-lock.json` together,
merge the release change, and create an immutable `vX.Y.Z` tag at that exact
commit. Ordinary commits and merges must never publish a release.

The stable workflow recalculates the DMG entries in `latest-mac.yml` after Apple
staples the notarization tickets. This ordering matters because stapling changes
the DMG bytes; metadata generated before stapling contains stale checksums.

### GitHub release secrets

The stable workflow requires these repository secrets:

| Secret | Value |
| --- | --- |
| `MAC_CSC_LINK` | Base64-encoded `.p12` export of the Developer ID Application certificate and private key |
| `MAC_CSC_KEY_PASSWORD` | Password used when exporting the `.p12` |
| `APPLE_API_KEY_P8_BASE64` | Base64-encoded App Store Connect API key `.p8` file |
| `APPLE_API_KEY_ID` | App Store Connect API key ID |
| `APPLE_API_ISSUER` | App Store Connect API issuer ID |
| `APPLE_TEAM_ID` | Apple Developer team ID used to verify the final signature |

The workflow writes the API key to a permission-restricted temporary file only
for notarization, removes it when the build step exits, and never uploads the
key or signing certificate as an artifact. The public release job receives only
already verified DMG, ZIP, ZIP blockmaps, update metadata, and checksums.

Verify a release candidate with:

```bash
codesign --verify --deep --strict --verbose=2 Lane.app
spctl --assess --type execute --verbose=4 Lane.app
xcrun stapler validate Lane.app
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

Publish only after the signed artifacts pass these checks on clean target
machines. Keep the previous signed release available until the upgrade path has
been exercised.

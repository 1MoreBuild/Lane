# Changelog

Notable user-visible changes are recorded here. Lane follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.12] - 2026-08-15

### Fixed

- Fixed provider reconnection when a stored credential is missing or unreadable,
  including in-place repair through the Lane CLI.
- Fixed macOS updates that could download successfully but fail to install or
  relaunch while a Lane CLI or Native Messaging helper was still running.

## [0.1.11] - 2026-08-15

### Added

- Added an About Lane section with the installed version, update status, and
  manual update and download controls.

### Changed

- Checks for updates when the main window is reopened, with concurrent checks
  shared and rate-limited to avoid redundant update-feed requests.

## [0.1.10] - 2026-08-15

### Added

- Added an end-to-end connection test that verifies the local gateway,
  provider credentials, and default model with one explicit minimal request,
  plus Windows WSL reachability diagnostics and ready-to-copy fixes.
- Added clear copy actions for every supported API endpoint.

## [0.1.9] - 2026-08-14

### Added

- Added an Authenticode-signed Windows x64 installer with user-confirmed
  automatic updates through stable GitHub Releases.
- Added a dedicated Windows Chrome Native Messaging host so the approved
  Transly extension can discover and connect to Lane.
- Added an unsigned Windows x64 preview installer with installed-product
  verification on a native x64 runner.

### Changed

- Moved stable Windows signing to Azure Artifact Signing with managed keys,
  publisher verification, and trusted timestamps.
- Hid the Windows application menu bar by default; press Alt to show it
  temporarily.
- Kept Lane in the Windows system tray without showing a taskbar button by
  default.
- Improved the Windows layout for compact, full-screen, and long Activity
  views.

### Fixed

- Fixed duplicate and overlapping Settings panels on Windows and Linux.
- Fixed installing and detecting the `lane` command on Windows without
  administrator privileges.
- Increased the default Windows window height and restored scrolling on long
  pages.

## [0.1.7] - 2026-08-11

### Changed

- Replaced Electron's generated macOS app menu with a Lane-native menu for
  About, Settings, manual update checks, and standard app commands.
- Removed unused DMG blockmaps from GitHub Releases while preserving the ZIP
  blockmaps required for differential automatic updates.

### Fixed

- Prevented legacy development Keychain entries from triggering a password
  prompt in signed releases, and kept Lane usable with recovery guidance when
  secure-storage access is denied.
- Kept the active Lane window in front when **Show in Dock** is toggled.

## [0.1.6] - 2026-08-11

### Fixed

- Prevented CLI broken-pipe errors from showing Electron crash dialogs or
  leaving a Dock process behind when an agent closes command output early.

## [0.1.5] - 2026-08-09

### Added

- Added opt-in, session-only request and response body capture with formatted
  JSON and readable streaming-event views.
- Added Developer ID signed and Apple-notarized macOS releases for Apple
  Silicon and Intel, with user-confirmed automatic updates.

### Security

- Bounded raw capture memory, kept captured bodies out of persistent logs, and
  published stable artifacts only after signature, notarization, and installed
  product checks passed on both Mac architectures.

## [0.1.3] - 2026-08-08

### Added

- Added persistent redacted request traces, model usage, activity clearing, and
  copyable test cURL commands for the local API.

### Changed

- Improved menu bar controls, gateway diagnostics, model capability handling,
  and the default-window layout.

## [0.1.2] - 2026-08-02

### Added

- Added image inputs, image-model defaults, model-aware reasoning effort, and
  Standard and Fast response modes.

### Security

- Isolated packaged E2E credentials and prevented release jobs from inheriting
  unrelated local secrets.

## [0.1.1] - 2026-08-01

### Fixed

- Fixed the macOS preview bundle signature so Gatekeeper no longer reported the
  app as damaged.

## [0.1.0] - 2026-07-31

### Added

- Initial macOS preview with multiple providers, OpenAI-compatible Responses
  and Chat Completions APIs, streaming, secure credential storage, menu bar
  controls, CLI control, and packaged-product E2E.

### Security

- Restricted the gateway to IPv4 loopback, required a separate Lane client
  key, and enforced explicit browser-origin allowlists.

[Unreleased]: https://github.com/1MoreBuild/Lane/compare/v0.1.12...HEAD
[0.1.12]: https://github.com/1MoreBuild/Lane/compare/v0.1.11...v0.1.12
[0.1.11]: https://github.com/1MoreBuild/Lane/compare/v0.1.10...v0.1.11
[0.1.10]: https://github.com/1MoreBuild/Lane/compare/v0.1.9...v0.1.10
[0.1.9]: https://github.com/1MoreBuild/Lane/compare/v0.1.7...v0.1.9
[0.1.7]: https://github.com/1MoreBuild/Lane/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/1MoreBuild/Lane/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/1MoreBuild/Lane/compare/v0.1.3...v0.1.5
[0.1.3]: https://github.com/1MoreBuild/Lane/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/1MoreBuild/Lane/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/1MoreBuild/Lane/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/1MoreBuild/Lane/releases/tag/v0.1.0

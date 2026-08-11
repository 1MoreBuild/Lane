# Changelog

Notable user-visible changes are recorded here. Lane follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/1MoreBuild/Lane/compare/v0.1.7...HEAD
[0.1.7]: https://github.com/1MoreBuild/Lane/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/1MoreBuild/Lane/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/1MoreBuild/Lane/compare/v0.1.3...v0.1.5
[0.1.3]: https://github.com/1MoreBuild/Lane/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/1MoreBuild/Lane/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/1MoreBuild/Lane/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/1MoreBuild/Lane/releases/tag/v0.1.0

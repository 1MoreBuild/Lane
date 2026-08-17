# Changelog

Notable user-visible changes are recorded here. Lane follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.14] - 2026-08-16

### Changed

- Activity now shows only model inference requests, keeping startup,
  integration, model-list, and updater diagnostics out of the request
  inspector, and keeps its own retention budget so a burst of diagnostics
  cannot push recent requests out of view.
- Moved the available-update control into the window toolbar, immediately
  before Activity, so update progress and downloads stay visible with the
  primary app controls.

### Fixed

- Automatic updates on macOS complete again: 0.1.11 through 0.1.13 could
  download an update and then wait at 100% forever because the installer
  handoff was never triggered. Updating from those versions to 0.1.14 still
  requires one manual install.
- Reported prompt tokens now include tokens served from a provider's prompt
  cache, so usage adds up and cost tracking no longer under-counts cached
  requests; responses also carry the cached-token breakdown.
- Each item in a streamed Responses reply now carries its own output index and
  is properly completed, so clients that assemble parallel tool calls by index
  no longer collapse them into one.
- A streaming request for a model that does not exist, or to a provider that
  cannot be reached, now returns the real error status instead of a 200 stream
  carrying an error event.
- Agent loops that replay a previous turn's reasoning or item references back
  to the Responses API no longer fail on the second turn.
- Image responses are read against their size limit as they arrive rather than
  after being held in memory, and each generated image keeps its own revised
  prompt when more than one is requested.
- Connecting a provider whose endpoint accepts the connection and then stalls
  now fails after 30 seconds instead of leaving the dialog waiting forever.
- Clearing Activity now removes only model requests from the stored logs,
  keeping the diagnostic history that used to be discarded along with them.
- Rejected client keys, denied browser origins, and unknown routes are recorded
  again, so a refused request still leaves a trace even though it stays out of
  Activity.
- Inspecting a captured response no longer blanks the window when the upstream
  provider streams an event whose name collides with a built-in object key.
- Failures from clearing Activity, toggling body capture, and changing settings
  are now shown instead of leaving a control that silently snaps back.
- Settings changed at the same moment from more than one place are written in
  order, so neither one silently replaces the other or leaves settings
  unreadable at the next launch.
- A provider whose stored credential can no longer be decrypted can now be
  removed instead of failing with "Invalid stored credential".
- Reconnecting an already-connected provider kind with a different key now
  clears a default model that key cannot serve.
- A failed ChatGPT sign-in now clears its code prompt, the provider type cannot
  be switched mid-sign-in, and submitting a code once the flow has ended
  reports it rather than appearing to work; starting a second sign-in while one
  is running is refused instead of orphaning the first.
- Command-line installation can safely replace a link created by an older Lane
  app while continuing to protect unrelated commands.
- `--plain` output keeps one column per field, so rows missing an optional
  value no longer shift every later column.
- `lane open` on a cold start now waits for the window instead of reporting
  success while Lane stays hidden.

### Security

- Released builds can no longer be re-used as a general Node interpreter by
  another local process, so Lane's code-signing identity and its access to
  stored credentials cannot be borrowed that way. The signed release also no
  longer disables macOS library validation; only ad-hoc test bundles retain
  that entitlement.
- The test-only credential backend can no longer be selected against a real
  Lane profile by launching the app with an empty test profile path, so stored
  provider keys and OAuth tokens stay under the operating system's protection.

## [0.1.13] - 2026-08-15

### Changed

- Maintenance release with no user-visible application changes. Release
  preparation now refreshes and verifies the latest remote `main`, stable tag,
  and GitHub Release before versioning or publication.

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

[Unreleased]: https://github.com/1MoreBuild/Lane/compare/v0.1.13...HEAD
[0.1.13]: https://github.com/1MoreBuild/Lane/compare/v0.1.12...v0.1.13
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

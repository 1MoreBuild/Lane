# Lane unsigned test builds

These builds are for early feedback and must be installed only when you trust
the workflow run or person that produced them.

## macOS

The macOS app bundle has an ad-hoc integrity signature, but it is not signed
with an Apple Developer ID or notarized by Apple. Download the Apple Silicon
DMG for M-series Macs. Use the Intel DMG only for an Intel Mac.

1. Download the DMG and open it.
2. Drag Lane to Applications.
3. In Applications, Control-click Lane and choose **Open**.
4. If macOS still blocks it, open **System Settings → Privacy & Security** and
   choose **Open Anyway** for Lane.

Do not disable Gatekeeper globally. A future public release will use Developer
ID signing and Apple notarization.

## Windows

The Windows preview contains native x64 and ARM64 applications in one NSIS
installer. It is not Authenticode signed, so Windows identifies its publisher
as unknown.

1. Download the `Lane-…-windows-setup.exe` workflow artifact.
2. Verify its SHA-256 value against `SHA256SUMS-windows` from the same run.
3. Open the installer only if you trust that workflow run.
4. Keep **Launch Lane** selected after installation to open the app.

Do not disable Microsoft Defender or SmartScreen globally. The preview includes
the dedicated Chrome Native Messaging host and the Settings action that installs
the user-level `lane` command. Preview builds never check the stable update feed.

## Send feedback

Please include:

- computer architecture and operating-system version;
- whether installation and first launch worked;
- which provider and model you connected;
- the action you were taking and the visible error message;
- a screenshot when it does not contain a Lane client key or provider secret.

Lane activity logs are redacted and stored in the operating system's standard
application log directory.

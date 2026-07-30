# Lane unsigned test build

This prerelease is for early feedback. It is not signed or notarized by Apple.
Download the Apple Silicon DMG for M-series Macs. Use the Intel DMG only for an
Intel Mac.

## Install

1. Download the DMG and open it.
2. Drag Lane to Applications.
3. In Applications, Control-click Lane and choose **Open**.
4. If macOS still blocks it, open **System Settings → Privacy & Security** and
   choose **Open Anyway** for Lane.

Do not disable Gatekeeper globally. A future public release will use Developer
ID signing and Apple notarization.

## Send feedback

Please include:

- Mac model and macOS version;
- whether installation and first launch worked;
- which provider and model you connected;
- the action you were taking and the visible error message;
- a screenshot when it does not contain a Lane client key or provider secret.

Lane activity logs are redacted and stored under `~/Library/Logs/Lane`.

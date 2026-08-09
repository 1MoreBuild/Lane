<p align="center">
  <img src="./build/icon.svg" width="112" height="112" alt="Lane app icon">
</p>

<h1 align="center">Lane</h1>

<p align="center">
  <strong>Your AI providers. One private local API.</strong>
</p>

<p align="center">
  Connect apps, scripts, and agents to the AI accounts you already use.
</p>

<p align="center">
  <a href="https://github.com/1MoreBuild/Lane/releases"><img src="https://img.shields.io/github/v/release/1MoreBuild/Lane?include_prereleases&style=flat-square&color=171717" alt="Latest release"></a>
  <a href="https://github.com/1MoreBuild/Lane/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/1MoreBuild/Lane/ci.yml?branch=main&style=flat-square&label=checks" alt="Build status"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-171717?style=flat-square" alt="MIT license"></a>
</p>

<p align="center">
  <a href="https://github.com/1MoreBuild/Lane/releases"><strong>Download the macOS preview →</strong></a>
</p>

<p align="center">
  <img src="./docs/assets/lane-hero.png" width="900" alt="Lane running as a private local AI gateway on macOS">
</p>

Lane is a local AI gateway for macOS. Connect ChatGPT / Codex with OAuth or add
a provider API key, then use one OpenAI-compatible endpoint from any local
client.

Lane is a gateway, not an agent. It never adds hidden instructions, runs an
agent loop, or executes tool calls.

## Why Lane

- Chat, Responses, and image generation through one API.
- Standard and Fast response modes for OpenAI and ChatGPT / Codex.
- ChatGPT / Codex, OpenAI, Anthropic, OpenRouter, and custom endpoints.
- Credentials stay in Keychain-backed secure storage.
- Inspect request traces as formatted JSON and response events, with the exact
  raw bodies available through opt-in, session-only capture.
- The gateway listens only on `127.0.0.1` and requires a separate Lane key.
- Desktop, menu bar, CLI, and automatic Transly connection.
- Signed releases update through GitHub Releases after user confirmation.

## Download

Install the current preview with Homebrew:

```bash
brew install --cask 1MoreBuild/tap/lane
```

Or download a DMG from
[GitHub Releases](https://github.com/1MoreBuild/Lane/releases):

| Mac | Build |
| --- | --- |
| Apple Silicon (M1 or newer) | `Lane-…-mac-arm64.dmg` |
| Intel | `Lane-…-mac-x64.dmg` |

Lane is currently an unsigned developer preview. Homebrew and direct downloads
install the same build and do not bypass Gatekeeper. Follow the
[installation guide](docs/TEST_BUILDS.md); never disable Gatekeeper globally.

Unsigned previews update manually. Signed releases show an update control in
the window; click it to download in place and restart into the new version.

## Start in three steps

1. Open Lane and add a provider.
2. Choose the default model, reasoning effort, speed, and image model.
3. Copy the API base URL and Lane client key into your client.

Test the connection:

```bash
curl http://127.0.0.1:3210/v1/models \
  -H "Authorization: Bearer $LANE_CLIENT_KEY"
```

Lane supports `/v1/responses`, `/v1/chat/completions`, and
`/v1/images/generations`, including streaming text responses and base64 data
URL image inputs for vision-capable models. Tool calls are returned to the
client; Lane never executes them. Lane defaults reasoning effort to High and
speed to Standard. A request can override either default with
`reasoning.effort` / `reasoning_effort` and `service_tier`.

| Provider | Sign in |
| --- | --- |
| ChatGPT / Codex | Browser OAuth |
| OpenAI | API key |
| Anthropic | API key |
| OpenRouter | API key |
| Custom OpenAI-compatible endpoint | Base URL and API key |

ChatGPT / Codex is a community integration built on
[`pi-ai`](https://github.com/earendil-works/pi/tree/main/packages/ai).
Upstream scopes, endpoints, models, and subscription policy can change.

## CLI for local agents

Install the `lane` command from **Settings**. Agents can inspect and control the
gateway with stable JSON output without reading provider OAuth tokens.

```bash
lane status --json --no-input
lane connection --json --no-input
lane models
lane models set-effort --effort high
lane models set-speed --speed fast
lane start
lane stop
```

Run `lane schema --json --no-input` for the complete command contract.

## Develop

Requires Node.js 24 LTS and npm.

```bash
git clone https://github.com/1MoreBuild/Lane.git
cd Lane
npm install
npm run dev
```

```bash
npm run check
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Unsigned test builds](docs/TEST_BUILDS.md)
- [Release checklist](docs/RELEASING.md)

## License

[MIT](LICENSE) • Haitian ([1MoreBuild](https://github.com/1MoreBuild))

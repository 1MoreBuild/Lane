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
  <a href="https://github.com/1MoreBuild/Lane/releases"><strong>Download the macOS preview →</strong></a>
</p>

<p align="center">
  <img src="./docs/assets/lane-hero.png" width="900" alt="Lane running as a private local AI gateway on macOS">
</p>

Lane is a local AI gateway for macOS. Connect ChatGPT / Codex with OAuth or add
a provider API key, then use one OpenAI-compatible endpoint from any local
client.

Lane is a gateway, not an agent. It does not add hidden instructions, run an
agent loop, or execute tool calls.

## One connection, any local client

- Chat, Responses, and image generation through one API.
- ChatGPT / Codex, OpenAI, Anthropic, OpenRouter, and custom endpoints.
- Credentials stay in Keychain-backed secure storage.
- The gateway listens only on `127.0.0.1` and requires a separate Lane key.
- Desktop, menu bar, CLI, and automatic Transly connection.

## Download

Lane is an unsigned developer preview for early testing.

| Mac | Build |
| --- | --- |
| Apple Silicon (M1 or newer) | `Lane-…-mac-arm64.dmg` |
| Intel | `Lane-…-mac-x64.dmg` |

Get the right DMG from [GitHub Releases](https://github.com/1MoreBuild/Lane/releases)
and follow the [installation guide](docs/TEST_BUILDS.md). Never disable
Gatekeeper globally.

## Start in three steps

1. Open Lane and add a provider.
2. Choose the default chat and image models.
3. Copy the API base URL and Lane client key into your client.

Test the connection:

```bash
curl http://127.0.0.1:3210/v1/models \
  -H "Authorization: Bearer $LANE_CLIENT_KEY"
```

Lane supports `/v1/responses`, `/v1/chat/completions`, and
`/v1/images/generations`, including streaming text responses. Tool calls are
returned to the client; Lane never executes them.

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

Lane is independent and is not part of Transly.

## License

[0BSD](LICENSE) © 2026 Lane contributors

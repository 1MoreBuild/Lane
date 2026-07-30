# Lane

Lane gives desktop apps one local endpoint for the AI providers you already use.

It runs on your Mac, keeps provider credentials in the operating system's secure
storage, and exposes an OpenAI-compatible API on `127.0.0.1`. Transly and other
clients talk to Lane; they do not need your OpenAI, Anthropic, OpenRouter, or
ChatGPT credentials.

Lane is a gateway, not an AI agent. It does not add a hidden system prompt, run
an agent loop, or execute model tool calls.

## Use Lane

1. Open Lane.
2. Connect a provider:
   - **ChatGPT / Codex** opens a browser OAuth flow.
   - **OpenAI**, **Anthropic**, and **OpenRouter** accept an API key.
   - **Custom OpenAI-compatible** accepts a base URL and API key.
3. Pick a default chat model and, when available, an image model.
4. Start the gateway.
5. Copy the API base URL and Lane client key into your client app.

Lane tests API-key connections by loading the provider's model list. This does
not send a paid model-generation request.

In **Settings**, Dock/taskbar visibility and menu bar/system tray visibility are
independent. You can keep either surface, both, or neither. If both are hidden,
Lane continues running in the background and can be reopened from Applications.

### Let local agents control Lane

The packaged macOS app can install a small `lane` command. Open **Settings**,
find **Command line**, and choose **Install…**. macOS asks for administrator
authorization once so Lane can add the launcher to your command path. Later
commands do not show an approval prompt.

For people:

```bash
lane status
lane start
lane stop
lane connection
lane providers list
lane models
lane open
```

For agents and scripts:

```bash
lane status --json --no-input
lane start --json --no-input
lane connection --json --no-input
lane schema --json --no-input
```

The command wakes Lane in the background when needed. It covers Lane's gateway
functions without exposing UI-only preferences:

```bash
# Connect an API-key provider without putting the secret in argv or shell history.
printf '%s\n' "$OPENAI_API_KEY" |
  lane providers add --kind openai --name OpenAI --api-key-stdin --json --no-input

lane providers remove --id PROVIDER_ID --force --json --no-input
lane models set-default --id PROVIDER_ID/MODEL_ID --json --no-input
lane models set-default-image --id PROVIDER_ID/IMAGE_MODEL_ID --json --no-input
lane activity --json --no-input
```

`lane connection` deliberately returns the API base URL, endpoint list, and Lane
client key so an authorized local agent can call the gateway. Provider API keys
are write-only: the CLI accepts them through stdin but never returns stored
values. OAuth tokens are never exposed. ChatGPT / Codex sign-in can be initiated
with `lane providers login`; it still requires the user to finish the provider's
browser flow.

Example:

```bash
curl http://127.0.0.1:3210/v1/models \
  -H "Authorization: Bearer $LANE_CLIENT_KEY"
```

Use the same key with:

- `GET /health`
- `GET /v1/models`
- `POST /v1/images/generations`
- `POST /v1/responses`
- `POST /v1/chat/completions`

Responses and Chat Completions support JSON responses and server-sent event
streams.
The first release supports text conversations, system/developer instructions,
function definitions, function calls, and function outputs. It passes tool calls
back to the client; Lane never executes them.

Image generation is a separate one-shot API. GPT Image responses are returned as
base64 data, matching the OpenAI Images API:

```bash
curl http://127.0.0.1:3210/v1/images/generations \
  -H "Authorization: Bearer $LANE_CLIENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai-codex/gpt-image-2",
    "prompt": "A minimal black and white lane icon",
    "quality": "low",
    "size": "1024x1024"
  }'
```

ChatGPT / Codex OAuth exposes `gpt-image-2`. OpenAI API-key connections expose
the GPT Image models returned by that account's model list. OpenRouter image
generation uses pi-ai's image-provider implementation. Custom
OpenAI-compatible endpoints expose image models when their model IDs identify
them as image models. Image editing and partial-image streaming are not yet
supported. `gpt-image-2` does not support native transparent backgrounds, so
Lane rejects `background: "transparent"` for that model instead of returning an
opaque image that merely looks transparent. Use an OpenAI API-key connection
with a transparency-capable model such as `gpt-image-1.5` for native alpha
output. The ChatGPT / Codex image endpoint is a community integration: image
generation works, but exact pixel size remains best effort. Audio, file, and
hosted-tool semantics are also outside the current compatibility promise.

### ChatGPT OAuth boundary

ChatGPT / Codex access uses the provider-owned OAuth implementation in
[`@earendil-works/pi-ai`](https://github.com/earendil-works/pi/tree/main/packages/ai).
It requires an eligible ChatGPT subscription. Lane enforces a loopback callback,
PKCE, and state validation before opening the authorization URL.

This is a community integration, not a stability guarantee from OpenAI.
Authentication scopes, endpoints, available models, and subscription policy can
change upstream. A successful automated build does not prove that a real account
can log in. Real login is an explicit user acceptance step, and Lane's tests never
send a paid model request.

## Privacy and safety

- The gateway always binds to `127.0.0.1`; no setting can expose it on the LAN.
- Every request needs a random Lane client key.
- Browser origins must match an explicit allowlist. `Access-Control-Allow-Origin:
  *` is never used.
- Provider credentials and OAuth tokens stay in the Electron main process.
- Credentials are encrypted with Electron `safeStorage`, backed by Keychain on
  macOS and the equivalent OS facility on supported platforms. Lane refuses
  credential storage if a secure backend is unavailable.
- Activity survives restarts in daily JSONL files under the operating system's
  app-log directory (`~/Library/Logs/Lane` on macOS). Lane keeps the newest 200
  entries in the UI, removes files older than 7 days, and caps the directory at
  5 MiB with 1 MiB file rotation.
- Activity is redacted before it reaches disk. Lane does not record prompts,
  model responses, request bodies, request headers, client keys, provider API
  keys, or OAuth tokens. The log directory is mode `0700` and files are `0600`
  on platforms that support POSIX permissions.

The Lane client key is intentionally visible in the app because users must give
it to local clients. Treat it like a password. See
[the threat model](docs/THREAT_MODEL.md) for the full boundary.

## Develop Lane

Requirements:

- Node.js 22.19 or newer
- npm
- macOS for the local packaging smoke test

```bash
git clone https://github.com/1MoreBuild/lane.git
cd lane
npm install
npm run dev
```

Quality checks:

```bash
npm run lint
npm run typecheck
npm test
npm run validate:packaging
npm run build
```

Build and smoke-test the current Mac:

```bash
npm run package:mac
npm run smoke:mac
npm run smoke:cli:mac
```

Windows NSIS targets for x64 and arm64 are configured in `package.json`, and CI
runs static/build checks on `windows-latest`. A Windows runtime claim requires a
real Windows host; the macOS smoke test is not a substitute.

## Design notes

Lane uses `@earendil-works/pi-ai` directly as its model/provider layer. It uses
the current `Models`, provider factories, provider-owned OAuth, and
`CredentialStore` APIs. It does not depend on `pi-coding-agent`.

See:

- [Architecture](docs/ARCHITECTURE.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Release checklist](docs/RELEASING.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

The project is intentionally standalone. It does not modify or depend on Transly.

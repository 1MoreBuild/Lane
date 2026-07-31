# Lane threat model

## Assets

- Upstream API keys
- OAuth access and refresh tokens
- The Lane client key
- User prompts and model output in flight
- Public provider and model configuration

## Trust boundaries

The Electron main process is trusted. The renderer, browser extensions, web
pages, and API clients are less trusted. Upstream providers are external
services. Other processes running as the same operating-system user may be able
to inspect that user's memory, automate the UI, or use their Keychain access;
Lane does not claim to defend against a fully compromised user account.

## Controls

### Network exposure

The gateway calls `listen` with the literal host `127.0.0.1`. The configuration
format has no bind-host field. Tests verify that the host cannot be changed.
Every API route, including health and model listing, requires the random Lane
client key. Key comparison is constant-time for equal-length inputs.

Requests with an `Origin` header must match an explicit allowlist. Preflight
requests are allowed only for approved origins. Lane never emits wildcard CORS.

### Credential containment

Provider secrets are encrypted with Electron `safeStorage` before they touch
disk. Public JSON settings contain no secrets. The renderer preload exposes
provider actions and public status, not credential reads. Upstream secrets are
never written into HTTP responses.

The Lane client key is different: local clients need it, so the renderer can show
and copy it. It is still encrypted at rest. Anyone who obtains it can use the
local gateway while Lane is running.

### Agent and CLI control

The control socket lives below Lane's private user-data directory and is set to
mode `0600`; its parent is mode `0700`. The versioned protocol accepts only
documented gateway, provider, model, connection, browser-integration, and
diagnostic commands. Requests have a size limit and bounded timeouts. Installing
the optional shell command is a separate user action.

`lane connection` deliberately returns the Lane client key because an authorized
agent needs it to call the gateway. Provider API keys are accepted only over
stdin and are write-only after storage. CLI responses omit stored provider API
keys, OAuth tokens, prompt content, and arbitrary UI settings. Destructive
provider removal requires `--force`. Activity output uses Lane's existing
redacted log. The command schema identifies secrets and mutations so agents do
not need to infer them.

### Browser integration

The packaged app registers a Chrome Native Messaging manifest containing an
explicit Transly extension-ID allowlist; wildcards are not accepted. The
allowlist contains the verified production Web Store ID
`mdjfkiddlpdgchddcckhcmdjekmmhcgp` and the intentionally retained unpacked
development ID `lmpgipgoelkfcbdpboffkbhniifhicdd`. Native-host mode checks
Chrome's caller-origin argument again before using the private control socket.
On connection, Lane forwards that exact verified origin, adds its canonical
form to the CORS allowlist, and returns only the Lane API URL, Lane client key,
and public model IDs. Provider API keys and OAuth tokens never cross this
boundary.

For each production release, the Transly manifest public key, unpacked extension
ID, Dashboard item ID, Native Messaging manifest, and Lane allowlist must still
agree.

### OAuth

Lane delegates token exchange and refresh to pi-ai's provider-owned OpenAI Codex
OAuth implementation. Before opening an authorization URL, Lane independently
requires:

- an HTTPS authorization URL;
- a loopback HTTP `redirect_uri`;
- a nontrivial `state`;
- a PKCE challenge using `S256`.

Lane forces the callback bind override to `127.0.0.1`. pi-ai validates the callback
path, state, authorization code, and PKCE verifier. Real login remains an
interactive acceptance test.

### Logs and errors

Logs and client-facing provider errors pass through redaction for bearer values,
common API-key shapes, JWTs, and token/key fields. Lane does not log request
bodies or headers. Port conflicts, token refresh failures, and provider failures
remain distinguishable without including secret material.

Activity is persisted only after redaction. It excludes prompts, model output,
request headers and bodies, the Lane client key, provider API keys, and OAuth
tokens. Files use mode `0600` inside a mode `0700` directory where POSIX
permissions are available. Daily files rotate at 1 MiB; files older than 7 days
are removed; the directory is capped at 5 MiB by deleting the oldest files
first. Corrupt or partial lines are ignored during recovery. A persistence
failure degrades to in-memory activity and does not stop the gateway.

### Request handling

Bodies are limited to 2 MiB. Image-provider responses are capped at 128 MiB
before they are returned as base64 JSON. Closing or aborting a downstream
request aborts the pi-ai upstream request. Lane does not execute model-requested
tools. Automated tests use a local mock provider and do not send paid requests.

## Residual risks

- A malicious local process with the Lane client key can spend against connected
  providers.
- Once CLI integration is enabled, another process running as the same user can
  retrieve the Lane client key, configure or remove providers, change the default
  model, start or stop the gateway, and open Lane. It still cannot retrieve stored
  provider API keys or OAuth tokens through the CLI protocol.
- Provider and OAuth behavior can change upstream.
- A renderer vulnerability could reveal the intentionally exposed Lane client
  key, though not upstream credentials.
- Model output is untrusted content. Client apps must apply their own escaping,
  authorization, and tool-execution policy.
- Code signing and notarization are distribution concerns beyond the unsigned
  local smoke artifact.

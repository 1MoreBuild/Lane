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

macOS development builds use a separate `safeStorage` identity from public
builds. A signed release does not read Keychain material left by an older
ad-hoc build, because doing so produces a misleading system password prompt.
Public settings survive that boundary, while providers must be reconnected
once. Lane marks only the affected provider for reconnection. If secure storage
is locked or access is denied, Lane opens without provider credentials and shows
recovery guidance instead of terminating.

Packaged E2E runs use an isolated AES-GCM backend so unsigned automation never
prompts for or opens a user's Keychain. That backend is accepted only when the
test profile resolves inside the operating system temporary directory and a
fresh 32-byte run key is supplied. It cannot be selected for Lane's normal user
profile.

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
stdin and are write-only after storage. On Windows, the native console launcher
forwards that input through a random one-shot named pipe whose ACL permits only
the current user and Windows SYSTEM, because GUI-subsystem executables do not
reliably inherit the console's stdin handle. The key remains in memory and is
never placed in a file, environment variable, or argument. CLI
responses omit stored provider API keys, OAuth tokens, prompt content, and
arbitrary UI settings. Destructive
provider removal requires `--force`. Activity output uses Lane's existing
redacted log. The command schema identifies secrets and mutations so agents do
not need to infer them.

### Browser integration

The packaged app registers a Chrome Native Messaging manifest containing an
explicit Transly extension-ID allowlist; wildcards are not accepted. The
allowlist contains the verified production Web Store ID
`mdjfkiddlpdgchddcckhcmdjekmmhcgp`. Transly's checked-in Web Store public key
gives local unpacked and store builds this same ID. Native-host mode checks
Chrome's caller-origin argument again before using the private control socket.
On connection, Lane forwards that exact verified origin, adds its canonical
form to the CORS allowlist, and returns only the Lane API URL, Lane client key,
and public model IDs. Provider API keys and OAuth tokens never cross this
boundary. Lane removes persisted browser-extension origins that are no longer
allowlisted when it loads configuration.

Lane registers its packaged executable as the host on macOS. On Windows it
registers a separate, minimal `lane-native-host.exe`; Chrome never launches the
Electron GUI as a native host. The helper repeats the fixed-origin check, sends
only `browser-client-connect` over Lane's same-user named pipe, and emits only a
valid Native Messaging frame. It can wake Lane but cannot read provider
credentials or proxy model requests. Linux support remains gated on equivalent
packaged-product E2E.

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
common API-key shapes, JWTs, and token/key fields. Metadata logging does not
include request bodies or headers. Port conflicts, token refresh failures, and provider failures
remain distinguishable without including secret material. Lane retries a
short-lived port conflict on the configured port. If the conflict persists, the
desktop UI can move to an available port only after confirmation; Lane does not
terminate the unknown process holding the old port.

Activity is persisted only after redaction. Gateway traces contain a random
request ID, method, route, streaming mode, resolved model/provider, HTTP status,
latency, token or image counts, cancellation state, and a bounded error code.
By default they exclude prompts, model output, request headers and bodies, the Lane client
key, provider API keys, and OAuth tokens. Files use mode `0600` inside a mode `0700` directory where POSIX
permissions are available. Daily files rotate at 1 MiB; files older than 7 days
are removed; the directory is capped at 5 MiB by deleting the oldest files
first. Corrupt or partial lines are ignored during recovery. A persistence
failure degrades to in-memory activity and does not stop the gateway.

The user can explicitly enable raw body capture for debugging. Capture records
the downstream request and response bodies exactly as Lane receives and emits
them; it does not redact, parse, or rewrite their content. Bodies can therefore
contain prompts, outputs, or application secrets. Authorization and other HTTP
headers are never added to the capture structure, so Lane and upstream
credentials are not captured merely because they authenticate a request. Raw
captures are held only in memory, disappear on restart or Clear, and are never
written to the activity JSONL files. Each side is capped at 1 MiB; the UI states
the captured and total byte counts when the tail is omitted. The session keeps
at most 32 MiB of raw bodies and evicts the oldest bodies first while retaining
their metadata traces.

### Request handling

Bodies are limited to 30 MiB. Image-provider responses are capped at 128 MiB
before they are returned as base64 JSON. Closing or aborting a downstream
request aborts the pi-ai upstream request. Lane does not execute model-requested
tools. Automated tests use a local mock provider and do not send paid requests.

### Updates

Stable packages use `electron-updater` and an explicit public GitHub Releases
feed. The updater is compiled on only when the signed release workflow sets its
build marker. Development, E2E, local packages, and unsigned prereleases do
not check for updates. The client never embeds a GitHub token. The user starts
the download from Lane's update control; progress is shown in place, and the
signed update installs and restarts Lane when the download completes.
On macOS, the install window blocks new Lane CLI and Native Messaging helpers
and stops only processes whose command exactly matches the current Lane app
executable. It never invokes a shell, matches a process-name wildcard, or
terminates an unrelated port owner.

The release workflow refuses to publish unless macOS signing/notarization and
Azure Artifact Signing credentials are present. It verifies the expected signing
identities, Gatekeeper assessment, stapled notarization ticket, Windows NSIS and
native executable publishers and timestamps, updater metadata, checksums, and installed-product
behavior on all supported native architectures before creating the release.
GitHub Actions are pinned to full commit hashes. A compromised release workflow,
GitHub account, signing identity, or upstream updater dependency remains a
software-supply-chain risk.

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
- Unsigned preview builds cannot use the automatic updater and require manual
  replacement.

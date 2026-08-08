# Lane architecture

## Shape

```text
Client app
  │ OpenAI-compatible HTTP + Lane client key
  ▼
127.0.0.1 gateway
  │ request and stream adapters
  ▼
Canonical Lane request/event model
  │
  ▼
@earendil-works/pi-ai Models collection
  │ provider-owned auth and protocol implementation
  ▼
OpenAI / Anthropic / OpenRouter / ChatGPT-Codex / custom endpoint
```

The Electron main process owns the gateway, provider collection, OAuth flow,
configuration, logs, and secure storage. The sandboxed renderer receives a small
IPC API with public status and configuration actions. It never receives an
upstream API key, access token, or refresh token.

An optional `lane` launcher gives local agents a separate control-plane path:

```text
agent or shell
  │ lane <command> --json --no-input
  ▼
packaged Lane executable in CLI mode
  │ versioned newline-delimited JSON
  ▼
same-user Unix socket / Windows named pipe
  │ allowlisted AppCore operations
  ▼
gateway, connection, provider, model, and redacted diagnostic operations
```

The same-user control socket is an internal application integration point and
starts with Lane. The optional shell command is enabled separately. On macOS its
installer creates a symlink to the packaged executable after the system
authorization dialog. The launcher is independent of the renderer and can wake
Lane without opening the main window.

The packaged app also registers a Chrome Native Messaging host for the explicit
Transly extension ID `mdjfkiddlpdgchddcckhcmdjekmmhcgp`. This ID is derived
from Transly's verified Chrome Web Store public key; the same key in Transly's
manifest gives unpacked and store builds the same ID:

```text
Transly service worker
  │ versioned Chrome Native Messaging frame
  ▼
packaged Lane executable in native-host mode
  │ private same-user control socket
  ▼
AppCore authorizes the Transly origin and starts the gateway
  │
  ▼
Transly receives only API URL, Lane client key, and public model IDs
```

The native host manifest is installed in Chrome's per-user directory on macOS.
Native Messaging is not shipped on Windows or Linux. Chromium requires a
byte-exact binary stdout channel, while the Electron GUI executable can prefix
stdout on Windows; Linux has no packaged-product verification yet. Supporting
either platform requires a dedicated native-host helper rather than registering
an unverified GUI executable. Manual provider configuration remains available
in Transly when Lane is not installed.

## Main components

- `AppCore` coordinates configuration, provider changes, startup restoration,
  gateway lifecycle, and public UI state.
- `SecureCredentialStore` implements pi-ai's `CredentialStore` contract over an
  OS-backed encrypted secret store. pi-ai performs OAuth refresh while holding
  the store's serialized provider mutation.
- `PiAiRuntime` converts Lane's canonical messages into pi-ai `Context` values
  and converts pi-ai stream events back into canonical events.
- `GatewayServer` owns the fixed loopback listener, client authentication, CORS,
  request cancellation, JSON responses, and SSE output.
- `LaneCliControlServer` owns the private same-user control socket. The CLI has a
  versioned schema, deterministic JSON/plain output, semantic exit codes, and no
  prompts in agent mode. API-key providers accept secrets only over stdin; the
  secret is stored by the same main-process credential path used by the UI.
- `NativeMessagingInstaller` registers the packaged executable for the explicit
  Transly extension-ID allowlist. Native-host mode validates Chrome's caller
  origin and forwards that exact verified origin when requesting a browser-client
  connection over the private control socket. Production releases must confirm
  that the Web Store public key, unpacked extension ID, Dashboard item ID, and
  Lane allowlist still agree. Persisted extension origins outside that allowlist
  are removed when Lane loads its configuration.
- `LaneLogger` keeps the latest 200 redacted activity entries in memory and
  mirrors them to daily JSONL files in Electron's application log directory.
  Startup reloads recent entries, removes files older than 7 days, enforces a
  5 MiB aggregate cap, and rotates files at 1 MiB. Persistence is diagnostic:
  a filesystem failure falls back to memory without stopping the gateway.
- `LaneAutoUpdate` uses `electron-updater` with the GitHub Releases provider.
  Signed release builds check after startup and every 30 minutes. An available
  update appears as a small window utility; clicking it replaces the icon with
  download progress, then installs and restarts Lane. A build-time release
  marker is set only by the signing workflow; development, E2E, local package,
  and prerelease builds never contact the update feed. A completed
  download also retains the standard install-on-quit fallback if the immediate
  relaunch is interrupted.
- The protocol module maps both OpenAI Responses and Chat Completions onto the
  same canonical request/event model. User content retains ordered text and
  image parts; image data URLs are decoded into pi-ai's provider-neutral image
  content instead of being flattened into text.
- Response speed has two product states: Standard and Fast. The persisted
  default can be overridden per request with OpenAI's `service_tier` field.
  Lane treats `auto` and `default` as Standard, then maps Standard to `default`
  and Fast or `priority` to `priority` immediately before
  pi-ai sends an OpenAI or ChatGPT / Codex payload. Other providers reject an
  explicit Fast request rather than silently ignoring it.
- Reasoning effort is persisted independently from the default model. The UI
  presents Light, Medium, High, Extra High, and Ultra, mapped to pi-ai's `low`,
  `medium`, `high`, `xhigh`, and `max` levels. High is the initial default. A
  request-level `reasoning.effort` or `reasoning_effort` value takes precedence;
  pi-ai applies the effective value only to reasoning-capable models.
- Image generation has its own canonical one-shot request/result model. It uses
  pi-ai's `ImagesModels` collection and does not enter the chat streaming or
  tool-call path.

## Provider connection model

OAuth and API keys produce the same result: a public `ProviderConfig` plus one
secret credential keyed by provider ID. Public settings contain names, endpoint
metadata, and model IDs. Secret values live only in the encrypted secret file.

Built-in OpenAI, Anthropic, OpenRouter, and OpenAI Codex providers come from
pi-ai provider factories. Custom OpenAI-compatible connections are constructed
with pi-ai's `createProvider()` and OpenAI Completions protocol implementation.
Image models use pi-ai's separate `ImagesModels`/`createImagesProvider()`
abstraction. Lane supplies the OpenAI Images transport that pi-ai does not yet
ship for OpenAI API-key or ChatGPT / Codex OAuth connections.

Model discovery is a control-plane request. Lane calls the provider's model-list
endpoint, normalizes IDs, and stores only non-secret model metadata. Generation
requests stay on the data plane and are never made during connection tests.

## Product verification

Vitest covers isolated protocol, provider, storage, security, and lifecycle
contracts. It is intentionally not treated as proof that the desktop product
works.

Playwright launches the packaged application with a fresh temporary user
profile and a local mock provider. The suite connects that provider through the
visible UI, selects a model, starts the gateway, calls every public API in
streaming and non-streaming modes, checks authentication and CORS failures,
aborts an in-flight request, exercises the packaged CLI, restarts the real
application, and removes the provider. On supported platforms it also exercises
the approved Native Messaging host. macOS release jobs install the DMG first
and run the same journey against the installed app on native Apple Silicon and
Intel runners. Windows CI runs the UI, API, security, persistence, port, and CLI
journeys against the packaged Windows application; Native Messaging remains
disabled until Lane has a dedicated Windows host.

E2E credentials use a per-run AES-GCM key and a user-data directory that must
resolve inside the operating system's temporary directory. The production
secure-storage backend remains the only backend for normal profiles, so
automated tests cannot read or prompt for a user's Keychain credentials.

## Lifecycle

Settings record whether the gateway should be restored. On launch, Lane restores
public configuration, obtains the Lane client key from secure storage, rebuilds
the provider collection, and starts the fixed loopback listener if requested.
Failure leaves the app open with a concrete diagnostic, such as a port conflict
or unavailable secure storage. A short-lived port conflict is retried on the
same configured port. If the port remains occupied, the desktop UI offers an
available port and changes the API URL only after confirmation. The new port is
persisted and returned to Transly through Native Messaging.

Removing or logging out a provider deletes its secret before removing the public
configuration. Changing providers rebuilds the runtime behind a stable gateway
holder, so clients do not need a new endpoint.

Activity is loaded before configuration restoration so startup events append to
the previous history. Clean shutdown waits for queued activity writes. Cleanup
runs at startup, after rotation, and at least daily while Lane remains open.
Each gateway request emits correlated start and completion metadata so the UI
can show one compact trace with route, resolved model, status, latency, usage,
and cancellation or error state. Request and response content is never part of
that trace.
An accepted update first stops the gateway and private control socket, then
hands the signed package to the platform updater.

## Compatibility policy

The HTTP surface follows the common text, base64 image-input, and function-call
subset of OpenAI Responses and Chat Completions plus one-shot OpenAI Images
generations. Remote image URLs are rejected rather than fetched by the gateway.
Each supported provider is still constrained by its own model and protocol
capabilities. Lane returns an explicit OpenAI-shaped error when a request cannot
be represented; it does not invent missing provider semantics.

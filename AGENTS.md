# Lane contributor notes

- Lane is a local AI gateway, not an agent. Do not add an agent loop, hidden system prompt, or tool execution.
- Keep upstream credentials in the Electron main process and OS-backed secure storage.
- Bind the gateway only to `127.0.0.1`. Keep client authentication and explicit CORS allowlists enabled.
- Add protocol behavior through the canonical request/event adapters, with mock-provider tests.
- Never use real paid model calls in automated tests.

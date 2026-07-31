# Contributing

Lane is a local gateway, not an agent. Changes must not add hidden prompts,
agent loops, or tool execution.

## Setup

Use Node.js 24 LTS and npm:

```bash
npm install
npm run check
```

Before opening a pull request, also run `npm run build`. Packaging changes
should pass the relevant packaged-product E2E in
[RELEASING.md](docs/RELEASING.md).

Tests must use mock providers. Do not commit credentials or make paid model
requests in automated tests. Security-sensitive changes should update the
[threat model](docs/THREAT_MODEL.md).

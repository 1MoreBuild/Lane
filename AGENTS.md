# AGENTS.md

Lane is a local, multi-provider AI gateway for desktop apps, scripts, and
agents. It exposes OpenAI-compatible loopback APIs without becoming an agent.

## Installing Lane for a user

- Prefer the signed and notarized macOS release linked from `README.md`. Do not
  clone or build the repository for a normal installation unless the user asks
  for a source or development build.
- Never claim that an app was installed, launched, signed, notarized, or updated
  unless that result was verified.
- Do not send a real model request, start OAuth login, alter provider
  credentials, or remove user data without explicit authorization.
- Report the installed version, verification performed, remaining manual steps,
  and whether any real model request ran.

## Working on Lane

- Do not add an agent loop, hidden system prompt, or tool execution. Lane adapts
  protocols and returns tool calls to its clients.
- Keep provider OAuth tokens and API keys in the Electron main process and
  OS-backed secure storage. They must not enter renderer state, logs, browser
  extensions, local API responses, CLI output, or Native Messaging responses.
- Keep the gateway bound to `127.0.0.1`, require the Lane client key, and use
  explicit CORS and Native Messaging allowlists. Never replace an allowlist with
  a wildcard.
- Read `docs/ARCHITECTURE.md`, `docs/THREAT_MODEL.md`, the relevant production
  source, and its tests before changing behavior.
- Add protocol behavior through the canonical request and event adapters. Keep
  provider differences behind the shared connection/runtime boundaries.
- Treat packaged-product E2E journeys as the product baseline for user-visible
  behavior. Add or update an E2E regression for user-visible changes and bugs.
- Keep contract tests only for algorithms, parsers, protocols, security,
  persistence, concurrency, updater state, and failure modes that packaged E2E
  cannot isolate reliably. Do not optimize for test count or line coverage.
- Automated tests must use deterministic local providers and isolated user-data
  directories. Never call a paid or subscription model in CI.
- Add a `.changes` fragment for user-visible changes. Internal refactors, tests,
  and documentation-only changes do not require one.
- Preserve unrelated worktree changes and update focused documentation when a
  public contract changes.

Before finishing, run `npm run check`, the packaged E2E command appropriate for
the changed platform, and `git diff --check`. State exactly what ran, whether it
used an installed package, and whether any real model request ran.

## Releasing

- A release requires explicit user authorization. Do not infer release intent
  from a request to commit, push, open a pull request, or merge.
- At the start of release preparation, run `git fetch origin --tags --prune`,
  require a clean worktree, verify that local `main` exactly matches
  `origin/main`, and compare `package.json` with the latest stable GitHub
  Release and tag. Query the latest release directly; checking only a named tag
  is not sufficient.
- Before a release, read `docs/RELEASING.md`, inspect the active workflow, fold
  pending `.changes` fragments into `CHANGELOG.md`, and remove consumed
  fragments.
- Keep the release pull request open until automated and human reviews have
  finished. Inspect unresolved review threads immediately before merging; do
  not merge, tag, or publish while an actionable P1 or P2 remains.
- Never change the package version, create or push a tag, dispatch a release
  workflow, or publish artifacts without explicit release authorization.
- After the release pull request merges and immediately before preflight or
  tagging, repeat the remote refresh and version checks. Stop if `main` moved,
  the local checkout is stale, or a newer stable release already exists.
- Stable macOS artifacts must be Developer ID signed, notarized, stapled, and
  pass installed-product E2E on native Apple Silicon and Intel runners before
  publication.

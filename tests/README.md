# Test organization

Repository tests follow the production responsibility they verify. Unit tests stay
beside application source or inside the owning plugin. This directory owns repository
tooling, packaged resources and contracts that cross host/native/plugin boundaries.

| Directory                         | Responsibility                                                                   |
| --------------------------------- | -------------------------------------------------------------------------------- |
| `architecture/`                   | Cross-domain source and process dependency boundaries                            |
| `build/`                          | Vite, React refresh, startup presentation and npm build entry contracts          |
| `packaging/`                      | Builder hooks, NSIS, archives, licenses, signing and update artifacts            |
| `runtime/`                        | Bundled Node, Python, Git and local speech dependencies/artifacts                |
| `tooling/`                        | Test runner/private SQLite, development launchers, ports and diagnostic scripts  |
| `renderer/`                       | Renderer-wide presentation contracts                                             |
| `browser/background/`             | Embedded-browser background/profile/cron Electron fixtures                       |
| `browser/recording/`              | Packaged browser preload recording fixtures                                      |
| `workspace-window/`               | Real workspace-window, preload and UI fixtures                                   |
| `mcp-apps/`                       | Generic MCP Apps Gateway, UI, navigation and workspace integration               |
| `plugins/host/`                   | Generic App SDK, Main/Browser loading, lifecycle and resource boundaries         |
| `plugins/management/marketplace/` | Real plugin management IPC, marketplace/import UI and publication fixtures       |
| `plugins/chrome-assistant/`       | Chrome extension/desktop integration, Native Messaging and host content adapters |
| `plugins/drawio/`                 | draw.io host packaging, Renderer navigation and editor integration               |
| `plugins/smart-canvas/`           | Smart Canvas delivery examples and host resource assembly                        |
| `openclaw/runtime/`               | Native staging, proofs, SDK/host contracts and explicit prepared-runtime probes  |
| `openclaw/plugins/`               | OpenAI source/artifact/native composition boundary                               |
| `openclaw/patches/<version>/`     | Behavior pinned to an exact historical/current patch version                     |
| `openclaw/fixtures/`              | Shared native controls and the reusable offline npx MCP package                  |
| `fixtures/`                       | Actual cross-domain fixture reuse, such as the loopback model server             |

Use kebab-case `*.test.ts` or `*.test.tsx` for automatically discovered tests.
Keep helpers and fixtures beside their consumers; share them only when multiple
domains actually reuse them. Native version locks and historical evidence retain
their original version identity. Directory sizes are not a reason to split suites.

## Discovery and execution

`npm test` runs Core suites with standalone Node 24, prepares a private SQLite
module under `build/test-dependencies/`, and then runs discovered independent App
plugin suites. It does not replace the application's Electron native bindings.
The authoritative include/setup/alias rules are in [Vitest configuration](../vitest.config.ts).

Ordinary repository discovery includes `tests/**/*.test.ts` and
`tests/**/*.test.tsx`. The Workboard `.test.mts` contract uses the explicit
`scripts/test/openclaw/workboard-upstream.vitest.config.mts` profile. Native
`.mjs`/`.cjs` probes and Electron entry fixtures remain explicit commands; moving
them must not add them to default discovery or start Gateway/browser processes.
The Runtime Services `history-result.test.mjs` keeps its explicit `node --test`
execution in the plugin's own `tests/` directory.

Pure plugin tests live under `plugins/<category>/<plugin-id>/tests/`. Host/plugin
boundary tests stay here even when their subject is a named plugin. The two draw.io
native probes live with that plugin under `scripts/test/` and use an explicitly
selected host checkout. Required sources and environment variables are documented
with the owning probe; no sibling checkout is inferred.

## Opt-in integration commands

The probe entry index and prerequisites are in [repository scripts](../scripts/README.md#opt-in-verification).
The two recording probes cover different boundaries: `scripts/test/browser/browser-recording-smoke.cjs`
builds the guest recording helper, while `tests/browser/recording/run.cjs` checks
the packaged browser preload. Preserve both.

- [Plugin marketplace/import integration](../docs/plugins/marketplace/integration.md#本地市场联调探针) owns runtime/Playwright/ABI prerequisites, the original import fixtures, publication locks and retained historical evidence. The stable marketplace command is `npm run test:plugins:marketplace -- --runtime <prepared-runtime-root>`.
- [Browser background fixtures](browser/background/README.md) owns background/profile and cron commands.
- [draw.io validation](../docs/plugins/extensions/drawio/README.md) owns explicit native/model probes and their limits.
- [Agent Team validation](../docs/plugins/extensions/agent-team/validation.md) records current and retired probe boundaries separately.

Use focused source tests during development. A directory move needs discovery,
path and affected-suite checks; it does not require new installation/cold-start
rehearsals or imply that opt-in native/browser evidence was re-established.

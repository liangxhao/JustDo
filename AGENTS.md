# AGENTS.md

Guidance for coding agents in this repository. Keep global rules here; read the
relevant documents below before changing a domain. Detailed design belongs in
`docs/architecture/` and `docs/features/`, not in this file.

## Project and Commands

JustDo is a local-first Electron + React desktop assistant backed by OpenClaw
Gateway and SQLite. Use npm and Node 24 (`.nvmrc`); `package.json` is authoritative
for versions, engine constraints, scripts and the development server port.

```bash
nvm use 24
npm install
npm run dev                    # Vite only
npm run electron:dev           # Compile Main and launch Electron
npm run electron:dev:openclaw   # Prepare host runtime and launch
npm run lint
npm run build
npm run compile:electron
npm test
```

- Before non-trivial pushes, prefer `npm run lint && npm run build && npm test`.
- For docs-only changes, run `git diff --check`.
- `npm test` uses Node better-sqlite3, then restores the Electron ABI;
  `npm run rebuild:electron-native` repairs native dependencies when needed.
- Packaging and runtime preparation commands are in `package.json` and
  [scripts/README.md](scripts/README.md).
- For specific implementation details, refer to the OpenClaw source code at ../openclaw (relative to the dev branch)."

## Ownership and Safety

- **Main** (`src/main/`) owns product lifecycle, IPC, permissions, configuration,
  SQLite metadata and system resources. **OpenClaw** owns execution, Gateway
  capabilities, tools, skills and native transcripts.
- **Renderer** (`src/renderer/`) is browser-only: no Node/Electron imports.
  Privileged operations use the explicit preload bridge. The designated chat
  controller consumes authenticated Gateway history and live events directly.
- **Shared** (`src/shared/`) contains pure cross-process contracts/utilities:
  no Electron, Node built-ins, DOM-only APIs or process state.
- Never recreate `cowork_messages` or a Main/Redux transcript cache. Product
  tables retain metadata and receipts; native history remains authoritative.
- Only exact whole-run lifecycle terminals with `executionSettled: true`
  establish execution outcomes. Chat final, attempt completion, Stop ACK,
  idle state and owner changes cannot substitute for terminal evidence.
- Preserve exact native identity, incarnation and generation checks. Unknown
  sends/launches remain unknown; never blindly retry or infer authorization
  from prompt markers, the latest message or run-ID suffixes.
- Gateway owns terminal PTYs and buffers. Bind chat terminals to the prepared
  native session; reconnect by attach, never reopen or replay uncertain input.
- Preserve packaged Renderer loopback hosting, immutable asset checks, CSP and
  navigation guards. Persist approved UI preferences through
  `rendererPreferences`/Main KV and hydrate before App/Redux imports.
- Plugins must not import application `src`; required Runtime Services must
  not depend on optional plugins. Native registration must not import
  `host/` or `browser/`; shared facades import only pure contracts/prompts,
  and browser modules never import Main.
- Built-in plugins live under `plugins/`: `extensions/`, `skills/`, `mcp-servers/`,
  `hooks/` and `browser-extensions/`. Keep sources and assets in their owning category.
- Keep OpenClaw extension-owned tools, UI, assets, scripts and unit tests
  under `plugins/extensions/<plugin-id>/`. The host retains generic capabilities,
  integration adapters and tests that exercise host/plugin boundaries.
- Browser extension sources, assembly scripts and unit tests live under
  `plugins/browser-extensions/<plugin-id>/`. Main owns Native Messaging and
  app-server integration; host build adapters may reuse application chat code.
- OpenClaw runtime documentation and role templates belong under
  `resources/openclaw/docs/`; repository design documentation stays in `docs/`.
- Keep `main.ts`, `preload.ts` and plugin registration entries thin.
  Controllers retain lifecycle/state ownership and delegate through explicit
  typed contexts. Use live `shared/app/propertyContext.ts` accessors rather
  than copied state or passing the whole controller.

## Coding and Structure

- Keep packaging intermediates under the repository-root `build/` and offline
  download caches under the repository-root `cache/`; both are ignored by Git.
- Strict TypeScript, functional React, 2-space indent, single quotes, semicolons.
  Renderer aliases: `@/` → `src/renderer/`, `@shared/` → `src/shared/`.
- Organize by feature/domain and preserve existing entry points. Co-locate
  helpers, styles and tests with their consumers; `shared/` is for actual reuse.
  Do not split/merge directories merely to equalize file counts.
- Main services, IPC and shared contracts belong to their owning domain.
  Provider credentials/authentication belong to `main/providers/`; native
  config projection belongs to `main/openclaw/config/`.
- Cowork `display/` owns tab composition; `preview/` owns file browsing;
  `approvals/` owns plan review. Keep native subtask graphs, Agent Team
  collaboration/discussions and Swarm Workflow UI in their separate domains.
- Renderer UI primitives live in `shared/components/ui/`, startup presentation
  in `app/shell/`, plugin feedback in `features/plugins/shared/`.
  Theme build tooling stays in `scripts/theme/`; browser theme code stays in
  `src/renderer/theme/`.
- Use i18n for user-visible strings and add matching `zh`/`en` entries.
  Dictionaries are grouped by domain; `translations.ts` only composes them.
- Use constants for discriminants, statuses and IPC names. Avoid mutation
  outside intentional Redux Toolkit Immer reducers.
- Main logs use module prefixes, e.g. `[CronJobService]`. Avoid production
  Renderer `console.log`. Never log/hardcode secrets, tokens, passwords,
  raw auth headers or credential objects.

## Branding and Paths

- `package.json.name` (`justdo`) is the stable internal package ID; never rebrand it.
- `package.json.productName` is the external name. Read it through
  `src/shared/productMetadata.ts` / `electron-builder.config.cjs`; never hardcode
  user-facing branding. `author.name` is separate publisher metadata.
- `productName` must match `[A-Za-z]{1,64}`. User-selected install paths may
  contain Chinese or spaces.
- It controls installer/UI names, `<appData>/<productName>` and
  `~/<productName lowercase>/project`; old branded directories are not migrated.
  `appId` is derived as `com.<productName lowercase>.app`: lowercase-name changes
  create a separate OS identity; case-only changes retain the existing identity.
- Preserve existing compatibility identifiers: `justdo://`, `justdo.sqlite`,
  `JUSTDO_*`, `--justdo-*`, `<justdo-chat>` and application session identities
  in the `justdo:` namespace. Rebranding must not rename provider/export IDs
  or existing source symbols/files. These preservation exceptions are
  **not naming templates for new identifiers**.
- **New internal identifiers must be product-neutral.** Do not use `justdo`
  (in any casing), the product name or a value derived from `productName` in
  new fields, database tables/columns, config/KV keys, IPC/RPC channels,
  namespaces, plugin state slots, service registry keys, message markers,
  source symbols/files or temporary path prefixes. Name them after the owning
  domain, capability or plugin, e.g. `agentTeam`, `swarm-workflow`, `runtime-services`.
- Project task artifacts use the fixed, product-neutral `.agent-tasks/` root;
  keep browser output and Swarm batches under their capability subdirectories.

## Change Checklist

- **IPC:** channel constants and typed payloads → owning Main handler →
  minimal preload method → `src/renderer/types/electron.d.ts`.
  Test non-trivial payload validation and permissions.
- **Redux:** create in the feature domain, mount in `store/index.ts`, export
  typed actions/selectors. The mounted store is the active-state authority.
- **SQLite:** schema, CRUD/indexes, existing-user compatibility and focused
  tests; update [data storage](docs/architecture/10-data-storage.md).
  This does not authorize the withdrawn runtime migration described below.
- **Bundled skills:** update `plugins/skills/<skill-id>/` and
  `plugins/skills/builtin-skills.json`. Gateway skill APIs own metadata;
  local skill-file helpers only import/remove files.
- **Scheduled tasks:** keep `main/scheduler/`, `main/ipc/scheduledTask/` and
  `shared/scheduledTask/` consistent. Test parsing, persistence, manual runs,
  runtime mapping and IPC.
- Tests use Vitest, with co-located `src/**/*.test.ts` and integration/snapshot
  `tests/**/*.test.mjs`. Test behavior with Arrange → Act → Assert.

## Runtime and Configuration Guardrails

- Production runs in a company intranet without public Internet access; model
  endpoints are internal. Ship runtime dependencies and UI assets in the installer
  or use explicitly configured internal services. Do not depend on public CDNs,
  first-launch package downloads, public update checks or public-service fallbacks.
  Validate cold startup without caches and with public network access blocked;
  build-time resource preparation follows `docs/offline-downloads.md`.

- Before any OpenClaw version upgrade or local OpenAI fork refresh, read
  [upgrade checklist](docs/openclaw-upgrade-checklist.md). Validate patches, SDK
  contracts, complete source replacement and the freshly rebuilt artifact.

- Apply current patches to the locked pristine OpenClaw package.
  Historical/partial patch shapes must fail clearly; do not add compatibility,
  migration or in-place upgrades for older application patch revisions.
  Current-shape idempotency is allowed.
- Do not reintroduce the withdrawn 9.6→9.8 native SQLite migration bridge,
  startup gate or build assets. Existing product-database initialization remains.
- Config sync preserves explicit optional-plugin state and unrelated permissions.
  Application-managed adapters follow their owning settings; generic extension
  controls must enforce their protection. Do not add public-service defaults,
  fallback catalogs or retired custom-video configuration migration.
- Assistant role homes remain `stateDir/agent-workspaces/<agentId>`;
  native `agents.files` owns role text. Switching assistants creates a new
  conversation without moving history or rewriting project rules.
  Profile deletion preserves historical native ownership: do not call
  `agents.delete`, which purges session indexes even with `deleteFiles:false`.
- Agent Team and Swarm Workflow are independent optional plugins.
  Retain required Runtime Services protection, receipt reconciliation and cleanup
  after disable; never duplicate transcript/config authorities or delete
  borrowed source sessions.
- Widgets require real `show_widget` admission and authenticated Gateway HTML.
  Only a current HTTP(S) viewer advertises them; delegate one prepared send.
  Widget follow-ups require human confirmation into the existing composer draft.
- Login and built-in model exchange share `core/network/macAddress.ts`:
  uppercase colon-free MAC, error when unavailable, no UUID/device-ID fallback.

## Read by Task

Read the matching contract before editing; use [feature index](docs/features/README.md)
for other areas. Pending acceptance limits remain in `docs/plans/`.

| Task                                                       | Required documents                                                                                                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture, directories, process/IPC boundaries          | [Architecture](docs/architecture/02-architecture.md), [process model](docs/architecture/03-process-model.md)                                                                    |
| Execution, permissions, terminals                          | [Engine](docs/architecture/05-agent-engine.md), [permissions](docs/features/chat/openclaw-permission-management.md)                                                             |
| Persistence and native storage                             | [Data storage](docs/architecture/10-data-storage.md)                                                                                                                            |
| Chat rendering, widgets                                    | [Chat rendering](docs/architecture/15-chat-rendering.md), [interactive answers](docs/features/chat/interactive-answers.md)                                                      |
| Assistant profiles, Team collaboration/discussions/holding | [Assistants](docs/features/assistants/assistants-and-collaboration.md), [Agent Team](docs/features/assistants/agent-team.md), [acceptance](docs/plans/agent-team-acceptance.md) |
| Swarm DAG, batches, host/browser ownership                 | [Workflow](docs/features/workflow/swarm-workflow.md), [batches](docs/features/workflow/swarm-workflow-batches.md)                                                               |
| Plugins, skills, managed adapters, computer control        | [Plugin system](docs/architecture/07-plugin-system.md), [Plugin Hub](docs/features/plugins/plugin-hub-experience.md)                                                            |
| Browser pairing/relay and extension chat                   | [Browser settings](docs/features/browser/browser-settings-design.md), [side chat](docs/features/browser/browser-extension-side-chat.md)                                         |
| Models, speech, video, decision providers                  | [Model management](docs/features/models/model-management.md), [local speech](docs/features/models/local-tts.md), [Jev/TypeSafe](docs/features/models/jev-integration.md)        |
| Login SDK and model authentication                         | [Login integration](docs/features/integrations/login-sdk-template.md), [model authentication](docs/features/integrations/authentication-builtin-model-lifecycle.md)             |
| Scheduled tasks                                            | [Scheduled tasks](docs/architecture/08-scheduled-tasks.md)                                                                                                                      |
| Runtime patches                                            | [Patch guide](docs/openclaw-runtime-patches.md), [current capability inventory](scripts/patches/v2026.10.4/README.md)                                                            |
| Windows installation, bundled runtimes                     | [Windows installer](docs/windows-installer.md), [offline downloads](docs/offline-downloads.md)                                                                                  |
| Logs and session diagnostics                               | [Development](docs/development.md), [diagnostics](docs/features/chat/session-diagnostics.md)                                                                                    |

## Logs, Docs and Git

- Start Windows triage with `%APPDATA%/<productName>/logs/main-YYYY-MM-DD.log`
  and `%APPDATA%/<productName>/openclaw/logs/gateway.log`. These logs condense
  events; missing records do not prove an event never occurred.
  Complete native JSON logs use the path from `[gateway] log file:`.
  Redirected development-terminal output is only a console capture.
- Never commit raw native logs; check excerpts for credentials/task content.
  Diagnostic reads must not start Gateway or read transcript files directly.
- Update relevant architecture/feature docs in the same change when contracts
  or data flow change. Preserve explanatory design and useful Mermaid diagrams.
  Keep current contracts in `docs/features/`, pending work in `docs/plans/`;
  remove completed/superseded plans after integrating their contracts.
- Keep all offline-download URLs, filenames, destinations and preparation
  commands in `docs/offline-downloads.md`.
- Use English Conventional Commits: `type(scope): imperative summary`.
  Before PRs, review full branch history and the appropriate release-base diff,
  use `.github/PULL_REQUEST_TEMPLATE.md`, and push new branches with `-u`.

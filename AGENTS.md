# AGENTS.md

Guidance for AI coding agents working with this repository — a README for agents.

## Project Overview

JustDo is a **24/7 personal AI assistant** desktop application. It's an Electron + React app where AI agents actually execute tasks (not just suggest them). Core capabilities: real task execution, local-first SQLite storage, 17 bundled skills, scheduled tasks via OpenClaw cron engine, and IM remote control.

- **Version**: 2026.6.25 | **Electron**: 41.2.0 | **OpenClaw**: v2026.6.9
- **Engine**: Node.js >=24 <25 (see `.nvmrc`)
- **Package manager**: npm
- **License**: MIT

## Dev Environment Setup

```bash
# Prerequisites
nvm use 24              # or Node.js >=24 <25
npm install             # install all dependencies (engine-strict enabled)

# Run the app in development
npm run electron:dev              # Vite dev server + Electron (hot reload, port 5175)
npm run electron:dev:openclaw     # Dev with OpenClaw engine enabled

# Rebuild native modules after dependency changes
npm run rebuild-native
```

Windows builds additionally require PortableGit and a Python runtime — see `scripts/setup-mingit.js` and `scripts/setup-python-runtime.js`. These are bundled automatically in production builds but must be set up manually for dev on Windows.

## Build Commands

```bash
npm run dev               # Vite dev server only (no Electron)
npm run build             # Full build: tsc type-check + vite bundle
npm run lint              # ESLint on src/ (flat config: eslint.config.mjs)
npm run format            # Prettier write (single quotes, semicolons, trailing commas)
npm test                  # Vitest run (rebuilds better-sqlite3 first via pretest)
npm run pack              # Build + electron-builder --dir (unpacked, fast local verify)
npm run dist              # Build + full platform installer
npm run dist:win           # Windows installer (NSIS .exe)
npm run dist:mac           # macOS DMG (signed + notarized)
npm run dist:linux         # Linux AppImage + deb
```

### Build Verification (CI)

Before pushing, CI runs these stages (see `.github/workflows/ci.yml`):
1. **lint** — ESLint on changed files
2. **build-renderer** — `npm run build`
3. **build-main** — Verify `dist-electron/` compiles
4. **build-skills** — Verify skill assets
5. **test** — Vitest suite

Run `npm run lint && npm run build && npm test` locally before pushing to catch CI failures early.

## Architecture

Strict process isolation: **Main** (IPC, SQLite, engine) ↔ **Preload** (contextBridge) ↔ **Renderer** (React + Redux).

| Layer | Path | Purpose |
|-------|------|---------|
| Main process | `src/main/` | Electron main, IPC handlers, engine lifecycle, SQLite |
| Preload | `src/main/preload.ts` | contextBridge — the ONLY API surface exposed to renderer |
| Renderer | `src/renderer/` | React UI with Redux Toolkit (7 slices) |
| Scheduled tasks | `src/scheduledTask/` | Cron engine, execution policies (shared by main + renderer) |
| Shared | `src/shared/` | Platform & provider constants (usable from both processes) |
| Common | `src/common/` | Pure utilities with zero process-specific imports |

### Process Isolation Rules (CRITICAL)

- **Main process** (`src/main/`): CommonJS module system. Uses `electron-log`. Can access Node.js APIs, filesystem, SQLite.
- **Renderer** (`src/renderer/`): ESNext modules. Can NOT access Node.js directly — all system access goes through `window.electronAPI` (defined in preload).
- **Shared code** (`src/shared/`, `src/common/`): Must work in BOTH module systems. Never import electron, node built-ins, or browser-only APIs.
- **TypeScript configs**: `tsconfig.json` (renderer, strict, ESNext), `electron-tsconfig.json` (main, CommonJS), `tsconfig.node.json` (vite config only).

### Redux Store (7 slices)

| Slice | File | Purpose |
|-------|------|---------|
| `cowork` | `store/slices/coworkSlice.ts` | Chat sessions, messages, streaming, permissions, groups |
| `agent` | `store/slices/agentSlice.ts` | AI agent CRUD and selection |
| `model` | `store/slices/modelSlice.ts` | Selected model, available models, server models |
| `skill` | `store/slices/skillSlice.ts` | Skills list and multi-select |
| `mcp` | `store/slices/mcpSlice.ts` | MCP server list and toggle |
| `scheduledTask` | `store/slices/scheduledTaskSlice.ts` | Cron tasks, runs, view mode |
| `quickAction` | `store/slices/quickActionSlice.ts` | Quick action prompts |

Selectors: `store/selectors/coworkSelectors.ts` for memoized cowork state queries.

### Key Subsystems

**OpenClaw Engine** (`src/main/libs/openclawEngineManager.ts`, ~57KB): Runtime download, install, version caching, and Gateway process lifecycle (idle → downloading → installing → ready → running).

**Cowork System** (`src/main/libs/agentEngine/`): AI chat orchestration. Routes through `coworkEngineRouter.ts` → `openclawRuntimeAdapter.ts` (~94KB). Supports streaming, thinking content, subagents (`openclaw/subagentGateway.ts`), and history reconciliation (`history/historyReconciler.ts`, ~31KB).

**Skills** (`src/main/skillManager.ts`, ~70KB): 17 bundled skills in `resources/skills/`, Gateway-managed via RPC (`rpc/skillRpc.ts`). User-imported skills go to `userData/openclaw/state/skills/`. Bundled skills take priority on ID conflict.

**IM (Remote Control)**: In development. Types at `src/renderer/types/im.ts`.

**Data Storage**: SQLite (`justdo.sqlite`) at platform data dir. Key tables: `kv`, `cowork_config`, `cowork_sessions`, `cowork_messages`, `cowork_subagents`, `session_groups`, `agents`, `mcp_servers`. Wrapper: `src/main/sqliteStore.ts`. Cowork CRUD: `src/main/coworkStore.ts` (~37KB).

### Key Files by Area

| Area | Path |
|------|------|
| App entry | `src/main/main.ts` (~164KB), `src/main/preload.ts` (~22KB) |
| Engine lifecycle | `src/main/libs/openclawEngineManager.ts` |
| Engine adapter | `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` |
| Cowork CRUD | `src/main/coworkStore.ts` |
| SQLite wrapper | `src/main/sqliteStore.ts` |
| Chat rendering | `src/renderer/libs/openclaw-chat/` (pipeline architecture) |
| Markdown renderer | `src/renderer/components/MarkdownContent.tsx` (~43KB) |
| Settings UI | `src/renderer/components/Settings.tsx` (~148KB) |
| Permission UI | `src/renderer/components/cowork/CoworkPermissionModal.tsx` |
| Config sync | `src/main/libs/openclawConfigSync.ts` (~43KB) |
| Enterprise config | `src/main/libs/enterpriseConfigSync.ts` |
| OpenAI compat proxy | `src/main/libs/coworkOpenAICompatProxy.ts` (~89KB) |
| MCP bridge | `src/main/libs/mcpBridgeServer.ts` |
| Command safety | `src/main/libs/commandSafety.ts` |
| Skill security | `src/main/libs/skillSecurity/` |
| Scheduled task engine | `src/scheduledTask/cronJobService.ts`, `src/scheduledTask/policies/` |

## Coding Conventions

### TypeScript

- **Strict mode** — all compiler strict flags enabled
- **Functional React** — no class components, prefer hooks
- **2-space indent**, **single quotes**, **semicolons**, trailing commas (see `.prettierrc`)
- `PascalCase` for components and types, `camelCase` for functions and variables
- Path aliases: `@/` → `src/renderer/`, `@shared/` → `src/shared/`

### Immutability (CRITICAL)

Always create new objects/arrays. Never mutate existing state:

```typescript
// WRONG: mutates in place
state.sessions.push(newSession);

// CORRECT: returns new copy (Redux Toolkit immer or spread)
[...sessions, newSession];
```

### Internationalization (i18n) — CRITICAL

**Never hardcode user-visible strings.** Always use the `t()` function:

```typescript
// WRONG
<span>Save</span>

// CORRECT
<span>{t('save')}</span>
```

- **Renderer**: import `t` from `src/renderer/services/i18n.ts`
- **Main process**: import `t` from `src/main/i18n.ts`
- When adding new strings, add keys to **both** `zh` and `en` translation maps
- Supports `{param}` interpolation: `t('key', { param: value })`

### Constants over Literals

Never use bare string/number literals for discriminants, status values, or IPC channel names. Define `as const` objects in a `constants.ts` file:

```typescript
// WRONG
if (status === 'running') { ... }

// CORRECT
export const EngineStatus = { RUNNING: 'running', IDLE: 'idle' } as const;
if (status === EngineStatus.RUNNING) { ... }
```

### Logging

- **Main process**: `console.error` / `console.warn` / `console.log` / `console.debug` (intercepted by `electron-log`)
- Format: `[ModuleName] plain English description of what happened`
- Never use `console.log` in production-only paths without considering log levels
- **Renderer**: avoid `console.log` in production code

### File Organization

- Organize by feature/domain, not by file type
- 200-400 lines typical, 800 lines max per file
- Co-locate tests (`.test.ts` next to source) for unit tests
- Extract shared utilities to `src/common/` when used by both processes

## Testing

### Running Tests

```bash
npm test                    # Run all Vitest tests (pretest rebuilds native modules)
npx vitest src/path/to/file.test.ts  # Run a single test file
npx vitest --coverage       # With coverage report
```

### Test Locations

Two locations, both using Vitest:

1. **Co-located unit tests**: `src/**/*.test.ts` — unit tests next to source
2. **Integration/snapshot tests**: `tests/**/*.test.mjs` — larger integration tests using ES modules

### Test Patterns

```typescript
import { test, expect } from 'vitest';

test('descriptive name of what should happen', () => {
  // Arrange
  const input = ...;

  // Act
  const result = functionUnderTest(input);

  // Assert
  expect(result).toBe(expectedValue);
});
```

- **Test naming**: describe the behavior, not the implementation ("returns empty array when no sessions match" not "test findSessions edge case")
- **AAA pattern**: Arrange → Act → Assert
- **Mocking**: use `vi.mock()`, `vi.spyOn()`, `vi.fn()` from vitest
- **Test config**: `vitest.config.ts` — node environment, matches vite resolve aliases

### CI Test Integration

Tests run in CI via `.github/workflows/ci.yml`. Tests that depend on native modules (`better-sqlite3`) need the `pretest` rebuild step. If you add a new native dependency, ensure it's in the `externals` list in `vite.config.ts` and `electron-builder.json`.

## PR and Commit Guidelines

### Commit Format

Conventional Commits (English only):

```
type(scope): imperative summary

Optional detailed body explaining why.
```

Types: `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `perf`, `ci`, `style`

Scopes: `cowork`, `skills`, `scheduledTask`, `engine`, `ui`, `electron`, `build`, `config`, `security`, `i18n`

Commitlint enforces this via `.commitlint.config.mjs` and the `.husky/commit-msg` hook.

### PR Workflow

1. Analyze full commit history (not just latest commit)
2. Use `git diff release_20260625...HEAD` to see all changes against main branch
3. Draft PR description using the template at `.github/PULL_REQUEST_TEMPLATE.md`
4. Push with `-u` flag if new branch

### Pre-PR Checklist

- [ ] `npm run lint` passes
- [ ] `npm run build` succeeds
- [ ] `npm test` passes (all tests green)
- [ ] i18n keys added to both `zh` and `en` if new strings added
- [ ] No hardcoded secrets or credentials
- [ ] New features have tests
- [ ] No `console.log` left in renderer

## Security Considerations

### Secret Management (CRITICAL)

- **Never** hardcode API keys, tokens, passwords, or credentials in source code
- All secrets go through environment variables or the app's encrypted config store
- CI uses GitHub Secrets for signing keys and notarization credentials
- See `.github/workflows/security.yml` for automated secret scanning (TruffleHog, npm audit, CodeQL)

### Skill Security

Skills can execute arbitrary code. The skill security system (`src/main/libs/skillSecurity/`) scans skills before installation:
- `skillSecurityScanner.ts` — static analysis of skill files
- `skillSecurityRules.ts` — configurable security rules
- `skillSecurityPromptAudit.ts` — prompt injection audit

### Command Safety

`src/main/libs/commandSafety.ts` validates commands before execution. Always route command execution through this module — never spawn shells directly from user input.

### IPC Security

- All IPC goes through `contextBridge` in `preload.ts`
- Never expose `ipcRenderer` directly to the renderer
- Validate all IPC parameters in main process handlers
- New IPC channels: add to preload's exposed API, then handle in main

### CSP and Headers

The renderer runs with Content Security Policy. When adding external resources (CDN scripts, fonts, images), update the CSP configuration accordingly.

## CI/CD Overview

| Workflow | File | Trigger |
|----------|------|---------|
| **CI** | `ci.yml` | Push to main/develop, PRs |
| **Electron Verify** | `electron-verify.yml` | Push to main/develop, PRs touching `src/` or config |
| **Security Scan** | `security.yml` | Weekly schedule + push/PR |
| **Platform Builds** | `build-platforms.yml` | Manual dispatch + `v*` tag push |
| **OpenClaw Check** | `openclaw-check.yml` | Push/PR touching OpenClaw config |
| **Labeler** | `labeler.yml` | PR opened/synchronize |
| **Stale** | `stale.yml` | Schedule (daily) |

### CI Pipeline Stages

1. **changed-files** — detect which paths changed (gates downstream steps)
2. **lint** — ESLint on changed files
3. **build-renderer** — `npm run build`
4. **build-main** — verify `dist-electron/` compiles
5. **build-skills** — verify skill assets
6. **test** — Vitest suite

All stages are cached where possible. Lint, build-main, and build-skills are conditional on changed paths.

## Internationalization (i18n)

Two separate i18n instances that share the same pattern:

| Instance | File | Coverage |
|----------|------|----------|
| Main process | `src/main/i18n.ts` | Tray menu, subagent status, session titles, skill errors, auth, enterprise |
| Renderer | `src/renderer/services/i18n.ts` | All UI: settings, models, skills, permissions, scheduled tasks, etc. |

Both export `t(key, params?)`, `setLanguage(lang)`, `getLanguage()`. Languages: `zh` and `en` only.

**When adding UI text:**
1. Add the key to the `zh` and `en` objects in the appropriate i18n file
2. Use `t('your.key')` in the component — never hardcode strings
3. Use `t('key', { param: 'value' })` for parameterized strings

## Resources and Assets

```
resources/
├── skills/          # 17 bundled skills (each has SKILL.md + assets)
├── tray/            # System tray icons (png, ico, mac@2x)
├── mingit/          # Portable Git for Windows (MinGit 2.47.1)
├── node-runtime/    # Node.js runtime files
├── python-win/      # Python runtime for Windows
└── builtin-skills.json  # Skill manifest (19 entries)
```

Skills are Gateway-managed. To modify bundled skills, update `resources/skills/<skill-name>/` and the manifest. To add a new bundled skill, add the directory and update `resources/builtin-skills.json`.

## Common Patterns

### Adding a New IPC Channel

1. Define the channel name and parameter types
2. Add handler in `src/main/` (register in `main.ts` or an `ipcHandlers/` submodule)
3. Expose via `contextBridge` in `src/main/preload.ts`
4. Call from renderer via `window.electronAPI.yourMethod()`

### Adding a New Redux Slice

1. Create `src/renderer/store/slices/yourSlice.ts` using `createSlice` from `@reduxjs/toolkit`
2. Add to `configureStore` in `src/renderer/store/index.ts`
3. Export selectors and actions
4. Use `useSelector` / `useDispatch` with the typed `RootState` and `AppDispatch` from the store

### Adding a New Database Table

1. Add migration logic (check existing patterns in `sqliteStore.ts`)
2. Add CRUD operations following existing naming: `getX`, `createX`, `updateX`, `deleteX`
3. Document the schema in the architecture docs (`docs/architecture/`)
4. Add tests

### Adding a New Scheduled Task Policy

1. Create `src/scheduledTask/policies/yourPolicy.ts` implementing the `ScheduledTaskPolicy` interface
2. Register in `src/scheduledTask/policies/registry.ts`
3. Add comprehensive tests — policies MUST have tests

## Documentation

- Architecture docs: `docs/architecture/` (14+ documents covering architecture, process model, cowork, skills, security, etc.)
- User-facing READMEs: `README.md` (English), `README_zh.md` (Chinese)
- This file (`AGENTS.md`) is for AI coding agents — keep it focused on what agents need to know to work effectively in this codebase

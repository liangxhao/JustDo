# AGENTS.md

Guidance for Claude Code when working with this repository.

## Project Overview

GucciAI is a **24/7 personal assistant Agent** — an AI that actually executes tasks, not just suggests. Core capabilities: real task execution, local-first SQLite storage, 17 bundled skills, scheduled tasks via OpenClaw cron, and IM remote control (in development).

**Version**: 2026.6.12 | **Electron**: 41.2.0 | **OpenClaw**: v2026.6.5

## Build Commands

```bash
npm run electron:dev              # Dev server + Electron (hot reload, port 5175)
npm run electron:dev:openclaw     # Dev with OpenClaw engine
npm run build                     # Production build (tsc + vite)
npm run lint                      # ESLint (src/)
npm test                          # Vitest unit tests
npm run pack                      # Build + pack (dir output)
npm run dist                      # Build + full installer
```

**Requirements**: Node.js >=24 <25. Windows builds need PortableGit.

## Architecture

Electron + React, strict process isolation: **Main** (IPC, SQLite, engine) ↔ **Preload** (contextBridge) ↔ **Renderer** (React + Redux).

| Layer | Path | Purpose |
|-------|------|---------|
| Main process | `src/main/` | Electron main, IPC handlers, engine lifecycle, SQLite |
| Renderer | `src/renderer/` | React UI with Redux slices |
| Scheduled tasks | `src/scheduledTask/` | Cron engine, policies (cowork/IM/manual), OpenClaw migration |
| Shared | `src/shared/` | Platform & provider constants (main + renderer) |
| Common | `src/common/` | Pure utilities (error classification) |

### Engine & Gateway

The **OpenClaw Engine Manager** (`src/main/libs/openclawEngineManager.ts`) handles runtime download, install, caching, and Gateway process lifecycle (idle → downloading → installing → ready → running). Cowork sessions route through `src/main/libs/agentEngine/coworkEngineRouter.ts` → `openclawRuntimeAdapter.ts`, with subagent support via `openclaw/subagentGateway.ts` and history reconciliation via `history/historyReconciler.ts`.

### Skills System

17 bundled skills in `resources/skills/`, **Gateway-managed** (loaded via RPC). User-imported skills go to `userData/openclaw/state/skills/`. Bundled skills take priority on ID conflict.

Key files: `src/main/skillManager.ts`, `src/main/libs/openclawConfigSync.ts`, `src/main/libs/agentEngine/rpc/skillRpc.ts`, `src/main/libs/skillSecurity/`.

### Cowork System

- **IPC streams**: `message`, `messageUpdate`, `thinkingUpdate`, `messageMetadataUpdate`, `permissionRequest`, `complete`, `error`
- **Thinking Stream**: persisted in `cowork_messages.thinking_content`
- **Memory**: file-based (`MEMORY.md`, `USER.md`, `SOUL.md`, daily notes)
- **Permission**: all tool calls require user approval (single/session scope)
- **Subagents**: tracked in `cowork_subagents` table

### Scheduled Tasks

Migrated to OpenClaw's cron engine (legacy `scheduled_task_meta` table removed). Engine: `src/scheduledTask/cronJobService.ts`. GUI: `src/renderer/components/scheduledTasks/`.

### IM (Remote Control)

In development with UI placeholders. Types: `src/renderer/types/im.ts` (Telegram, Discord).

### Data Storage

SQLite (`gucciai.sqlite`) at standard platform data dirs. Key tables: `kv`, `cowork_config`, `cowork_sessions`, `cowork_messages`, `cowork_subagents`, `session_groups`, `agents`, `mcp_servers`.

### Key Files

| Area | Path |
|------|------|
| Entry point | `src/main/main.ts` |
| Engine manager | `src/main/libs/openclawEngineManager.ts` |
| SQLite | `src/main/sqliteStore.ts` |
| Cowork CRUD | `src/main/coworkStore.ts` |
| Engine router | `src/main/libs/agentEngine/coworkEngineRouter.ts` |
| OpenClaw adapter | `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` |
| Subagent gateway | `src/main/libs/agentEngine/openclaw/subagentGateway.ts` |
| History reconciler | `src/main/libs/agentEngine/history/historyReconciler.ts` |
| Skill manager | `src/main/skillManager.ts` |
| Config sync | `src/main/libs/openclawConfigSync.ts` |
| Command safety | `src/main/libs/commandSafety.ts` |
| MCP bridge | `src/main/libs/mcpBridgeServer.ts` |
| Enterprise config | `src/main/libs/enterpriseConfigSync.ts` |
| Cowork types/slice/UI | `src/renderer/types/cowork.ts`, `store/slices/coworkSlice.ts`, `components/cowork/` |
| Redux slices | `agentSlice`, `mcpSlice`, `skillSlice`, `scheduledTaskSlice`, `quickActionSlice` (all under `store/slices/`) |
| Scheduled task engine | `src/scheduledTask/cronJobService.ts`, `src/scheduledTask/migrate.ts`, `src/scheduledTask/policies/` |

## Coding Conventions

- TypeScript (strict), functional React, 2-space indent, single quotes
- `PascalCase` components, `camelCase` functions
- Tailwind CSS, path alias `@` → `src/renderer/`
- Never hardcode user-visible strings — use `t('key')` from `src/renderer/services/i18n.ts` or `src/main/i18n.ts` (add keys to both `zh` and `en`)
- Never use bare literals for discriminants/status/IPCs — define `as const` objects in `constants.ts`

### Logging

`console.*` in `src/main/` (intercepted by `electron-log`): `error` / `warn` / `log` / `debug`. Format: `[ModuleName] plain English sentence`.

## Testing

Vitest, co-located `.test.ts` files. `import { test, expect } from 'vitest'`. Manual testing via `npm run electron:dev`.

## Commits

Conventional Commits (English): `type(scope): imperative summary`. Types: `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `perf`.

## Key Documentation

| Doc | Path |
|-----|------|
| Overview | `docs/architecture/01-overview.md` |
| Architecture | `docs/architecture/02-architecture.md` |
| Process Model | `docs/architecture/03-process-model.md` |
| Cowork System | `docs/architecture/04-cowork-system.md` |
| Agent Engine | `docs/architecture/05-agent-engine.md` |
| Skills System | `docs/architecture/07-skills-system.md` |
| Scheduled Tasks | `docs/architecture/08-scheduled-tasks.md` |
| Data Storage | `docs/architecture/10-data-storage.md` |
| Security Model | `docs/architecture/11-security-model.md` |
| Tech Stack | `docs/architecture/12-tech-stack.md` |
| Frontend Design | `docs/architecture/13-pure-frontend-design.md` |
| OpenClaw Boundary | `docs/architecture/14-openclaw-frontend-boundary-plan.md` |
| Gateway Matrix | `docs/architecture/openclaw-gateway-capability-matrix.md` |
| Thinking Stream | `docs/features/thinking-stream-implementation.md` |
| Thin Frontend Plan | `docs/features/openclaw-thin-frontend-refactor-plan.md` |

# AGENTS.md

Guidance for Claude Code when working with this repository.

## Project Overview

GucciAI is a **24/7 personal assistant Agent** - an AI that actually executes tasks, not just suggests. Core capabilities:
- Real task execution via tool calls (file ops, commands, network)
- Local-first: SQLite storage, privacy-controlled
- Skills system: 8 default skills (docx, xlsx, pptx, pdf, web-search, local-tools, create-plan, skill-creator)
- IM remote control (planned): trigger desktop agent from mobile
- Scheduled tasks: natural language or GUI creation

**Version**: 2026.4.12 | **Electron**: 41.2.0 | **OpenClaw**: v2026.3.2

## Build Commands

```bash
npm run electron:dev              # Dev server + Electron (hot reload)
npm run electron:dev:openclaw     # Dev with OpenClaw engine
npm run build                     # Production build
npm run lint                      # ESLint
npm test                          # Vitest unit tests
```

**Requirements**: Node.js >=24 <25. Windows builds need PortableGit.

## Architecture

Electron + React app with two modes:
1. **Cowork Mode** - AI coding sessions via OpenClaw engine
2. **Artifacts System** - Rich preview (HTML, SVG, Mermaid, React)

Strict process isolation: Main (IPC, SQLite, engine routing) ↔ Preload (contextBridge) ↔ Renderer (React UI).

### Skills System

29 built-in skills, 8 enabled by default. Config: `SKILLs/skills.config.json` (new format with `version`, `description`, `defaults`).

Key skill paths:
- Definitions: `SKILLs/*/SKILL.md`
- Config sync: `src/main/libs/openclawConfigSync.ts`
- Security scan: `src/main/libs/skillSecurity/`

### Key Files

| Area | Path |
|------|------|
| Entry point | `src/main/main.ts` |
| SQLite | `src/main/sqliteStore.ts` |
| Cowork CRUD | `src/main/coworkStore.ts` |
| Engine router | `src/main/libs/agentEngine/coworkEngineRouter.ts` |
| OpenClaw adapter | `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` |
| Cowork types | `src/renderer/types/cowork.ts` |
| Cowork slice | `src/renderer/store/slices/coworkSlice.ts` |
| Cowork UI | `src/renderer/components/cowork/` |

### Cowork System

- **Primary engine**: OpenClaw (`openclawRuntimeAdapter.ts`)
- **Memory**: File-based in OpenClaw working dir (`MEMORY.md`, `USER.md`, `SOUL.md`, daily notes)
- **IPC streams**: `message`, `messageUpdate`, `thinkingUpdate`, `messageMetadataUpdate`, `permissionRequest`, `complete`, `error`
- **Thinking Stream**: Real-time model reasoning display, persisted in `cowork_messages.thinking_content`
- **Permission control**: All tool calls require user approval (single/session scope)

### Data Storage

SQLite (`gucciai.sqlite`) in user data dir:
| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/GucciAI/` |
| Windows | `%APPDATA%\GucciAI\` |
| Linux | `~/.config/GucciAI/` |

Key tables: `kv`, `cowork_config`, `cowork_sessions`, `cowork_messages` (has `thinking_content` column), `agents`, `mcp_servers`, `im_config`, `scheduled_task_meta`

### Auth Flow

Browser login → deep link callback → token exchange → SQLite persistence → auto-refresh.

## Coding Conventions

- TypeScript, functional React, 2-space indent, single quotes
- `PascalCase` components, `camelCase` functions
- Tailwind CSS for styling
- Path alias: `@` → `src/renderer/`

### String Constants

Never use bare literals for discriminants/status/IPCs. Define `as const` objects in `constants.ts`:

```typescript
export const SessionTarget = { Main: 'main', Isolated: 'isolated' } as const;
export type SessionTarget = typeof SessionTarget[keyof typeof SessionTarget];
```

### Logging

Use `console.*` in `src/main/` (intercepted by `electron-log`):
- `error` - Unrecoverable failures
- `warn` - Recoverable issues
- `log` - Key lifecycle events
- `debug` - Development detail

Format: `[ModuleName] plain English sentence`

### i18n

Never hardcode user-visible strings. Use `t('key')` from:
- Renderer: `src/renderer/services/i18n.ts`
- Main: `src/main/i18n.ts`

Add keys to both `zh` and `en` sections.

## Testing

- Vitest, co-located `.test.ts` files
- `import { test, expect } from 'vitest'`
- Manual UI testing via `npm run electron:dev`

## Commits

Conventional Commits format, English:

```
type(scope): imperative summary

Optional body explaining why.
```

Types: `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `perf`

## Key Documentation

| Doc | Path |
|-----|------|
| Overview | `docs/architecture/01-overview.md` |
| Cowork System | `docs/architecture/04-cowork-system.md` |
| Skills System | `docs/architecture/07-skills-system.md` |
| Data Storage | `docs/architecture/10-data-storage.md` |
| Tech Stack | `docs/architecture/12-tech-stack.md` |
| Thinking Stream | `docs/features/thinking-stream-implementation.md` |
| Preload API | `docs/architecture/08-preload-api.md` |
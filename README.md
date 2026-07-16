# JustDo - Personal AI Assistant

JustDo is a desktop AI assistant built with Electron, React, SQLite, and the
OpenClaw Gateway. It is designed for real task execution: chat with an agent,
attach files, manage skills and MCP servers, run scheduled tasks, and keep the
desktop app available in the background.

![Version](https://img.shields.io/badge/Version-v2026.7.6-green.svg?style=for-the-badge)
![Electron](https://img.shields.io/badge/Electron-42-47848F?style=for-the-badge&logo=electron&logoColor=white)
![Node](https://img.shields.io/badge/Node-24.x-339933?style=for-the-badge&logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)

## What It Does

| Capability | Current implementation |
| --- | --- |
| AI work sessions | OpenClaw Gateway is the execution engine. JustDo manages the desktop shell, UI state, permissions, and local cache. |
| Chat UI | React owns the application shell; `<justdo-chat>` is a Lit custom element backed by the local OpenClaw Gateway WebSocket. |
| Local storage | `better-sqlite3` stores UI cache, app settings, agents, MCP servers, hooks, session groups, and cowork metadata. |
| Skills | 15 bundled skills are listed in `resources/builtin-skills.json`; 14 are enabled by default and `agent-browser` is disabled. |
| MCP and hooks | Managed from the Plugins screen, persisted locally, then synced into OpenClaw configuration. |
| Scheduled tasks | UI CRUD and polling are handled by JustDo; execution is delegated to the OpenClaw cron runtime. |
| Desktop integration | Tray, auto launch, prevent sleep, local file preview, logs, proxy handling, and packaged platform resources. |

## Architecture

```text
Renderer (React + Redux + Lit)
  -> preload contextBridge (`window.electron`)
  -> Main process IPC handlers
  -> SQLite stores / plugin services / OpenClaw runtime manager
  -> OpenClaw Gateway
```

The main rule is process isolation:

- `src/main/` is the Electron main process. It can use Node.js, SQLite, the filesystem, and Electron APIs.
- `src/main/preload.ts` is the only renderer-facing API surface.
- `src/renderer/` is browser-side React and Lit code. It must not import Node.js or Electron directly.
- `src/shared/` contains cross-process contracts and must stay runtime-neutral.

## Quick Start

Use Node.js 24. The project is engine-strict and expects `>=24 <25`.

```bash
nvm use 24
npm install
npm run electron:dev
```

The Vite dev server uses the port from `package.json`:

```text
http://localhost:4175
```

To prepare and run with the OpenClaw host runtime:

```bash
npm run electron:dev:openclaw
```

## Build And Test

```bash
npm run lint
npm run build
npm run compile:electron
npm test
```

Packaging commands:

```bash
npm run pack
npm run dist
npm run dist:win
npm run dist:mac
npm run dist:linux
```

Windows packaging prepares MinGit and a Python runtime through the scripts in
`scripts/`. Production packages include the runtime resources needed by the app.

## Important Directories

| Path | Purpose |
| --- | --- |
| `src/main/core/` | app constants, window/tray, logging, proxy, CSP, Python runtime, local file protocol |
| `src/main/data/` | SQLite wrapper plus cowork and session group stores |
| `src/main/engine/` | cowork routing, Gateway adapter, runtime forwarding, command safety |
| `src/main/openclaw/` | Gateway config sync, runtime lifecycle, model/session/slash-command helpers |
| `src/main/plugins/` | skills, MCP, hooks, extensions, and marketplace services |
| `src/main/scheduler/` | scheduled task prompt/runtime bridge |
| `src/renderer/features/` | React feature modules for cowork, agents, models, plugins, scheduled tasks, settings |
| `src/renderer/libs/openclaw-chat/` | Lit chat element and message rendering pipeline |
| `src/shared/` | shared contracts for cowork, OpenClaw, providers, plugins, scheduled tasks, slash commands |
| `resources/skills/` | bundled skill source folders |
| `vendor/openclaw-runtime/` | downloaded/synced OpenClaw runtime artifacts |

## State Model

The renderer Redux store currently has 6 slices:

- `model`
- `cowork`
- `skill`
- `mcp`
- `scheduledTask`
- `agent`

The historical `coworkDeleteState` standalone slice has been removed from the
store; deletion state now lives with the cowork feature code.

## Data Storage

The app database is `justdo.sqlite` under Electron `userData` for `JustDo`.
Core tables include:

- `kv`
- `cowork_config`
- `cowork_sessions`
- `cowork_messages`
- `agents`
- `mcp_servers`
- `openclaw_hooks`
- `session_groups`

Gateway chat history remains the authoritative execution history. SQLite keeps
local UI cache and product metadata.

## Configuration

OpenClaw integration is declared in `package.json`:

```json
{
  "version": "v2026.7.6",
  "openclaw": {
    "version": "v2026.6.11",
    "repo": "https://github.com/openclaw/openclaw.git"
  },
  "devServer": {
    "port": 4175
  }
}
```

Runtime patch policy is documented in `scripts/patches/README.md` and summarized
in `docs/patches/openclaw-patch-guide.md`.

## Documentation

Start with [docs/README.md](docs/README.md). The architecture documents describe
the current implementation rather than an aspirational design.

## Contributing

- Keep user-visible strings in the i18n maps.
- Keep renderer code isolated from Node.js and Electron.
- Prefer shared constants for IPC channels, status values, and discriminants.
- Run `npm run lint`, `npm run build`, `npm run compile:electron`, and `npm test`
  before release work.

## License

MIT

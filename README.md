# JustDo — All-in-One Personal Assistant Agent

<p align="center">
  <img src="public/logo.png" alt="JustDo" width="120">
</p>

<p align="center">
  <strong>A 24/7 personal assistant Agent that gets things done</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/Version-2026.7.1-green.svg?style=for-the-badge" alt="Version">
  <br>
  <img src="https://img.shields.io/badge/Platform-macOS%20%7C%20Windows%20%7C%20Linux-brightgreen?style=for-the-badge" alt="Platform">
  <img src="https://img.shields.io/badge/Electron-41-47848F?style=for-the-badge&logo=electron&logoColor=white" alt="Electron">
  <img src="https://img.shields.io/badge/React-18-61DAFB?style=for-the-badge&logo=react&logoColor=black" alt="React">
</p>

<p align="center">
  English · <a href="README_zh.md">中文</a>
</p>

---

**JustDo** is an all-in-one personal assistant Agent. It works around the clock to handle your everyday tasks — data analysis, making presentations, generating videos, writing documents, searching the web, sending emails, scheduling tasks, and more.

At its core is **Cowork mode** — it executes tools, manipulates files, and runs commands in a local or sandboxed environment, all under your supervision.

JustDo is a **thin frontend** for the [OpenClaw Gateway](https://github.com/openclaw/openclaw) — all AI inference, session lifecycle, message history, and subagent management are handled by the Gateway. JustDo owns the UI, configuration, and permission gating.

## Key Features

| Feature | Description |
|---------|-------------|
| **Thin Frontend for OpenClaw Gateway** | All AI execution, history, and subagent lifecycle delegated to OpenClaw. JustDo is a pure UI frontend |
| **Cowork Mode (Auto/Local)** | AI working sessions that autonomously complete complex tasks in local or sandboxed environments |
| **17 Built-in Skills** | Office documents, web search, browser automation, data analysis, diagram generation, AI art, and more |
| **Scheduled Tasks** | Create recurring tasks via conversation or GUI using OpenClaw's cron engine |
| **Persistent Memory** | Automatic extraction of preferences and facts across sessions (MEMORY.md, USER.md, SOUL.md) |
| **Permission Gating** | All tool invocations require explicit user approval before execution |
| **14 Themes** | Built-in theme system with 14 curated themes, i18n (Chinese + English) |
| **Lit-based Chat Rendering** | Message rendering via `<justdo-chat>` Lit custom element, same pipeline as OpenClaw webchat |
| **IM Integration** | Remote control via IM platforms (Telegram, Discord) — in development |
| **Cross-Platform** | macOS (Intel + Apple Silicon), Windows, Linux desktop |
| **Local Data** | SQLite as UI cache keeps your configuration and session metadata on your device |

## Architecture Overview

JustDo is designed as a **thin frontend** for OpenClaw Gateway:

```
┌─────────────────────────────────────────────────────────────┐
│                      JustDo (Frontend)                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  React UI   │  │ Config Sync │  │   Skill Manager     │  │
│  │ (renderer)  │  │ (API/model) │  │ (sync to Gateway)   │  │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘  │
│         │                │                     │             │
│  ┌──────┴──────────────────────────────────────┴──────────┐  │
│  │   <justdo-chat> Lit Element (direct WebSocket)         │  │
│  │   GatewayClient → ChatController → justdo-chat         │  │
│  └──────────────────────────┬──────────────────────────────┘  │
└─────────────────────────────│─────────────────────────────────┘
                              │ WebSocket
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    OpenClaw Gateway                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  AI Engine  │  │  History    │  │    Skills System    │  │
│  │ (inference) │  │ (storage)   │  │  (~/.openclaw/)     │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
│  ┌─────────────┐  ┌─────────────┐                            │
│  │  Sessions   │  │  Subagents  │                            │
│  │ (lifecycle) │  │ (dispatch)  │                            │
│  └─────────────┘  └─────────────┘                            │
└─────────────────────────────────────────────────────────────┘
```

### Key Architecture Principles (v2026.7)

1. **Thin Frontend** — JustDo does not inject custom system prompts, AGENTS.md policies, or per-agent workspace content. All AI context is managed by Gateway.
2. **Single Engine** — OpenClaw Gateway is the only AI engine. No dual-engine architecture.
3. **Runtime as pre-built npm package** — OpenClaw runtime is downloaded as a pre-built npm package, not cloned and built from source.
4. **Gateway is Single Authority** — `chat.history` from Gateway is the authoritative source for message history. SQLite is a UI cache only.
5. **Lit Chat Rendering** — Message rendering uses the same Lit pipeline as OpenClaw webchat (`<justdo-chat>` custom element connecting directly to Gateway WebSocket).
6. **Subagent Logic Fully Contracted** — No local subagent state tracking; parent/child relationships managed by Gateway.

## Getting Started

### Prerequisites

- **Node.js** >= 24 < 25
- **npm**

### Development

```bash
git clone https://github.com/liangxhao/JustDo.git
cd JustDo
git checkout dev
npm install

# Start development (Vite + Electron with hot reload)
npm run electron:dev

# With OpenClaw runtime (downloads pre-built package on first run)
npm run electron:dev:openclaw
```

Dev server runs at `http://localhost:5175` with HMR. OpenClaw runtime is downloaded as a pre-built npm package.

<details>
<summary>OpenClaw Environment Variables</summary>

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENCLAW_FORCE_INSTALL` | Force reinstall of the pre-built runtime | — |

</details>

### Production Build & Packaging

```bash
npm run build           # TypeScript + Vite bundle
npm run lint            # ESLint check

# Platform-specific installers (output to release/)
npm run dist:mac        # macOS .dmg (Apple Silicon)
npm run dist:win        # Windows .exe (NSIS)
npm run dist:linux      # Linux .AppImage & .deb
```

Desktop packages bundle a prebuilt OpenClaw runtime — no manual setup needed.

## Core Systems

### Cowork System

An AI working session system powered by OpenClaw Gateway, autonomously completing complex tasks.

| Mode | Description |
|------|-------------|
| `auto` | Automatically selects execution context |
| `local` | Direct local execution, full speed |

All tool invocations (filesystem, terminal, network) require explicit approval via `CoworkPermissionModal`.

Chat messages are rendered by a Lit-based pipeline (`<justdo-chat>` element) connecting directly to Gateway WebSocket — the same approach as OpenClaw webchat.

### Skills System (17 bundled skills)

Skills are managed by OpenClaw Gateway. JustDo syncs skill definitions from `resources/skills/` to the Gateway's state directory.

| Skill | Category |
|-------|----------|
| `docx` / `xlsx` / `pptx` / `pdf` | Office documents |
| `multi-search-engine` | Multi-engine web search |
| `playwright` / `agent-browser` | Browser automation |
| `data-analysis` | Data processing & visualization |
| `diagram-generator` | Diagrams & flowcharts |
| `algorithmic-art` | Generative AI art |
| `taskflow` | Multi-step workflows |
| `mcp-builder` | MCP server creation |
| `self-improvement` | Agent self-optimization |
| `ontology` | Domain knowledge modeling |
| `theme-factory` | UI theme generation |
| `healthcheck` | System diagnostics |

Custom skills can be created via `skill-creator` and hot-loaded at runtime. User-imported skills stored in `userData/openclaw/state/skills/`. Bundled skills take priority on ID conflict.

### Scheduled Tasks

Create recurring tasks via natural language or GUI using OpenClaw's cron engine. Examples: daily news collection, weekly reports, email cleanup. Task metadata is persisted locally in `scheduled_task_meta` table.

### Persistent Memory

File-based memory system managed by OpenClaw Gateway:

| File | Purpose |
|------|---------|
| `MEMORY.md` | Durable facts and preferences |
| `memory/YYYY-MM-DD.md` | Daily notes |
| `USER.md` | User profile |
| `SOUL.md` | Agent personality |

### Chat Rendering

Message rendering uses a Lit-based pipeline identical to OpenClaw webchat:

```
Gateway WebSocket → GatewayClient → ChatController → <justdo-chat> Lit Element → Shadow DOM
```

Key benefits:
- Eliminates message duplication, truncation, and loss issues
- Direct WebSocket connection (no IPC round-trip)
- Same render pipeline as webchat (consistent behavior)
- Streams, thinking content, and tool calls all handled in the pipeline

## Technical Details

### Process Model

Electron strict process isolation with IPC communication.

| Process | Responsibilities |
|---------|------------------|
| **Main** (`src/main/`) | Window lifecycle, SQLite, OpenClaw Gateway process management, 40+ IPC handlers |
| **Preload** (`src/main/preload.ts`) | `contextBridge` API, `cowork` namespace |
| **Renderer** (`src/renderer/`) | React 18 + Redux + Tailwind, all UI logic, Lit chat rendering |

### Directory Structure

```
src/
├── main/                  # Electron main process
│   ├── main.ts            # Entry point
│   ├── preload.ts         # contextBridge security layer
│   ├── coworkStore.ts     # Cowork session & message CRUD
│   ├── groupStore.ts      # Session group management
│   ├── mcpStore.ts        # MCP server configuration
│   ├── core/              # Core app utilities
│   │   ├── appConstants.ts
│   │   ├── autoLaunchManager.ts
│   │   ├── logger.ts
│   │   └── trayManager.ts
│   ├── data/              # Data layer
│   │   └── sqliteStore.ts # SQLite database management
│   ├── features/          # Feature managers
│   │   ├── agentManager.ts
│   │   └── presetAgents.ts
│   ├── ipcHandlers/       # IPC handler modules
│   └── libs/              # Domain-organized libraries
│       ├── agentEngine/   # Cowork engine routing & OpenClaw adapter
│       ├── cowork/        # Cowork config, logging, model API
│       ├── infra/         # Command safety, system proxy, Python runtime
│       ├── mcp/           # MCP bridge server & manager
│       └── openclaw/      # Gateway engine, config sync, history, token proxy
│
├── renderer/              # React frontend + Lit chat
│   ├── App.tsx            # Root component
│   ├── theme/             # Theme system (14 themes)
│   │   ├── engine/        # Theme engine
│   │   ├── themes/        # Theme definitions
│   │   ├── tailwind/      # Tailwind integration
│   │   └── tokens/        # Design tokens
│   ├── components/        # UI components
│   │   └── cowork/
│   │       ├── JustDoChatWrapper.tsx  # React ↔ Lit bridge
│   │       ├── CoworkView.tsx
│   │       ├── CoworkSessionList.tsx
│   │       ├── CoworkPermissionModal.tsx
│   │       └── ...
│   ├── libs/
│   │   └── openclaw-chat/ # Lit chat rendering pipeline
│   │       ├── gateway/    # GatewayClient + ChatController
│   │       ├── components/ # Lit components
│   │       ├── pipeline/   # Message processing pipeline
│   │       └── conversion/ # Data conversion
│   ├── store/             # Redux store & slices
│   └── types/             # TypeScript types
│
├── scheduledTask/         # Cron engine, task metadata
└── shared/                # Platform & provider constants

resources/skills/          # 17 bundled skill definitions (Gateway-managed)
scripts/                   # Build and tool scripts
```

### Cowork Engine Architecture

Cowork sessions use a Gateway-based lifecycle (`idle → downloading → installing → ready → running`). History is loaded from Gateway's `chat.startup` / `chat.history` RPC. No local subagent state tracking — parent/child relationships are entirely managed by Gateway.

### Data Storage

Local SQLite (`justdo.sqlite`) serves as a **UI cache**, NOT the authoritative data source:

| Data | Authority | SQLite Role |
|------|-----------|-------------|
| Message history | Gateway `chat.history` API | UI cache |
| Session metadata | JustDo local | Primary storage |
| App configuration | JustDo local | Primary storage |
| Agent definitions | JustDo local | Primary storage |
| MCP servers | JustDo local | Primary storage |

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Electron 41 |
| Frontend | React 18 + TypeScript + Lit (chat rendering) |
| Build | Vite 5 |
| Styling | Tailwind CSS 3 |
| State | Redux Toolkit |
| AI Engine | OpenClaw Gateway (pre-built npm package) |
| Storage | better-sqlite3 (UI cache) |
| Chat Render | Lit 3 + markdown-it + highlight.js + katex |

### Security

- Context isolation enabled, node integration disabled
- Permission gating for sensitive tool invocations
- Optional OpenClaw sandbox
- HTML sandbox, DOMPurify, Mermaid strict mode

## Configuration

### App & Cowork

- **Working Directory** — Root for Agent operations
- **System Prompt** — Customize Agent behavior
- **Execution Mode** — `auto` / `local`
- **Model Provider & Model** — AI model selection (OpenAI-compatible providers)
- **Agent Engine** — Always `openclaw` (single engine)

### OpenClaw Integration

Version pinned in `package.json`:

```json
{
  "openclaw": {
    "version": "v2026.6.9",
    "repo": "https://github.com/openclaw/openclaw.git",
    "plugins": []
  }
}
```

Runtime is distributed as a pre-built npm package, downloaded via platform-specific scripts.

### Internationalization

14 built-in themes. English and Chinese (default) supported. Switch in Settings panel.

## Development

- TypeScript strict mode, functional components + Hooks
- 2-space indentation, single quotes, semicolons
- Components: `PascalCase`; functions/variables: `camelCase`
- Tailwind CSS preferred

### Testing

```bash
npm test              # All tests (Vitest)
npm test -- logger    # Specific module
```

## Contributing

1. Fork → Create feature branch → Commit → Push → Open PR
2. Follow conventional commits: `type: short summary`

## License

[MIT License](LICENSE)

## Acknowledgments

Developed with reference to [LobsterAI](https://github.com/netease-youdao/LobsterAI). Thanks to the LobsterAI team for their pioneering work in personal assistant AI agents.

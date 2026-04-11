# GucciAI — All-in-One Personal Assistant Agent

<p align="center">
  <img src="public/logo.png" alt="GucciAI" width="120">
</p>

<p align="center">
  <strong>A 24/7 personal assistant Agent that gets things done</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <br>
  <img src="https://img.shields.io/badge/Platform-macOS%20%7C%20Windows%20%7C%20Linux-brightgreen?style=for-the-badge" alt="Platform">
  <br>
  <img src="https://img.shields.io/badge/Electron-40-47848F?style=for-the-badge&logo=electron&logoColor=white" alt="Electron">
  <img src="https://img.shields.io/badge/React-18-61DAFB?style=for-the-badge&logo=react&logoColor=black" alt="React">
</p>

<p align="center">
  English · <a href="README_zh.md">中文</a>
</p>

---

**GucciAI** is an all-in-one personal assistant Agent. It works around the clock to handle your everyday tasks — data analysis, making presentations, generating videos, writing documents, searching the web, sending emails, scheduling tasks, and more.

At its core is **Cowork mode** — it executes tools, manipulates files, and runs commands in a local or sandboxed environment, all under your supervision.

---

## Table of Contents

- [Key Features](#key-features)
- [Architecture Overview](#architecture-overview)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Development](#development)
  - [Production Build](#production-build)
  - [Packaging](#packaging)
- [Core Systems](#core-systems)
  - [Cowork System](#cowork-system)
  - [Skills System](#skills-system)
  - [Scheduled Tasks](#scheduled-tasks)
  - [Persistent Memory](#persistent-memory)
- [Technical Details](#technical-details)
  - [Process Model](#process-model)
  - [Directory Structure](#directory-structure)
  - [Data Storage](#data-storage)
  - [Security Model](#security-model)
  - [Tech Stack](#tech-stack)
- [Configuration](#configuration)
- [OpenClaw Integration](#openclaw-integration)
- [Development Guidelines](#development-guidelines)
- [Testing](#testing)
- [Contributing](#contributing)
- [License](#license)
- [Acknowledgments](#acknowledgments)

---

## Key Features

| Feature | Description |
|---------|-------------|
| **All-in-One Productivity** | Data analysis, PPT creation, video generation, document writing, web search, email — covers the full range of daily work |
| **Local + Sandbox Execution** | Run tasks directly on your machine or in an OpenClaw sandbox environment |
| **Built-in Skills** | Office document generation, web search, Playwright automation, Remotion video generation, and more |
| **Windows Python Runtime** | Windows packages bundle a ready-to-use Python interpreter; dependencies install on demand |
| **Scheduled Tasks** | Create recurring tasks via conversation or GUI — daily news digests, inbox cleanup, periodic reports |
| **Persistent Memory** | Automatically extracts preferences and facts from conversations, remembers across sessions |
| **Permission Gating** | All tool invocations require explicit user approval before execution |
| **Cross-Platform** | macOS (Intel + Apple Silicon), Windows, Linux desktop |
| **Local Data** | SQLite storage keeps your chat history and configuration on your device |

---

## Architecture Overview

<p align="center">
  <img src="docs/res/architecture.png" alt="Architecture Overview" width="800">
</p>

---

## Getting Started

### Prerequisites

- **Node.js** >= 24 < 25
- **npm**

### Development

```bash
# Clone the repository
git clone https://github.com/liangxhao/GucciAI.git
cd GucciAI
git checkout dev

# Install dependencies
npm install

# Start development (Vite dev server + Electron with hot reload)
npm run electron:dev
```

The dev server runs at `http://localhost:5175` by default.

#### With OpenClaw Agent Engine

GucciAI uses [OpenClaw](https://github.com/openclaw/openclaw) as its agent engine. The required version is pinned in `package.json` under `openclaw.version`.

```bash
# First run: automatically clones and builds OpenClaw (may take several minutes)
npm run electron:dev:openclaw

# Subsequent runs: skips build if the pinned version hasn't changed
npm run electron:dev:openclaw
```

By default, OpenClaw source is cloned at `../openclaw`. Override with:

```bash
OPENCLAW_SRC=/path/to/openclaw npm run electron:dev:openclaw
OPENCLAW_FORCE_BUILD=1 npm run electron:dev:openclaw   # Force rebuild
OPENCLAW_SKIP_ENSURE=1 npm run electron:dev:openclaw   # Skip version checkout
```

### Production Build

```bash
# TypeScript compilation + Vite bundle
npm run build

# ESLint check
npm run lint
```

### Packaging

Uses [electron-builder](https://www.electron.build/) to produce platform-specific installers. Output goes to `release/`.

```bash
# macOS (.dmg)
npm run dist:mac
npm run dist:mac:x64        # Intel only
npm run dist:mac:arm64      # Apple Silicon only
npm run dist:mac:universal  # Universal

# Windows (.exe NSIS installer)
npm run dist:win

# Linux (.AppImage & .deb)
npm run dist:linux
```

Desktop packaging bundles a prebuilt OpenClaw runtime. The pinned version is automatically fetched and built — no manual setup needed.

Build OpenClaw runtime manually:

```bash
npm run openclaw:runtime:host        # Current host platform
npm run openclaw:runtime:mac-arm64   # macOS ARM64
npm run openclaw:runtime:win-x64     # Windows x64
npm run openclaw:runtime:linux-x64   # Linux x64
```

---

## Core Systems

### Cowork System

Cowork is the core feature of GucciAI — an AI working session system powered by OpenClaw. It autonomously completes complex tasks like data analysis, document generation, and information retrieval.

#### Execution Modes

| Mode | Description |
|------|-------------|
| `auto` | Automatically selects based on context |
| `local` | Direct local execution, full speed |

#### Stream Events

Cowork uses IPC events for real-time communication:

| Event | Description |
|-------|-------------|
| `message` | New message added |
| `messageUpdate` | Incremental streaming content |
| `permissionRequest` | Tool execution requires approval |
| `complete` | Session finished |
| `error` | Execution error |

#### Permission Control

All tool invocations involving file system, terminal, or network require explicit approval in the `CoworkPermissionModal`.

---

### Skills System

GucciAI ships with 29 built-in skills covering productivity, creative, and automation scenarios.

| Skill | Function |
|-------|----------|
| `web-search` | Web search |
| `docx` | Word document generation |
| `xlsx` | Excel spreadsheet generation |
| `pptx` | PowerPoint creation |
| `pdf` | PDF processing |
| `remotion` | Video generation (Remotion) |
| `seedance` | AI video generation |
| `seedream` | AI image generation |
| `playwright` | Web automation |
| `canvas-design` | Canvas drawing |
| `frontend-design` | UI design |
| `stock-analyzer` | Stock analysis |
| `local-tools` | File and system operations |
| `skill-creator` | Custom skill creation |

Custom skills can be created via `skill-creator` and hot-loaded at runtime.

---

### Scheduled Tasks

Create recurring tasks that the Agent executes automatically on a set schedule.

#### How to Create

- **Conversational** — Tell the Agent in natural language (e.g., "collect tech news every morning at 9 AM")
- **GUI** — Add tasks manually in the Scheduled Tasks panel

#### Typical Scenarios

| Scenario | Example |
|----------|---------|
| News Collection | Gather industry news and generate summary daily |
| Inbox Cleanup | Periodically check and categorize emails |
| Data Reports | Weekly business analysis report |
| Content Monitoring | Check websites for changes |

Tasks use Cron expressions, supporting minute, hourly, daily, weekly, and monthly intervals.

---

### Persistent Memory

GucciAI's memory system persists information as files, so the Agent remembers preferences across sessions.

#### Memory Files

| File | Purpose |
|------|---------|
| `MEMORY.md` | Durable facts and preferences — loaded at session start |
| `memory/YYYY-MM-DD.md` | Daily notes |
| `USER.md` | User profile (name, occupation, habits) |
| `SOUL.md` | Agent personality and behavioral principles |

#### How Memories Are Written

- **Explicit instructions** — Say "remember that…" and the Agent saves to `MEMORY.md`
- **Agent-initiated** — Agent can proactively write important findings
- **GUI management** — Add, edit, delete entries from Settings panel

---

## Technical Details

### Process Model

GucciAI uses Electron's strict process isolation with IPC communication.

#### Main Process (`src/main/main.ts`)

- Window lifecycle management
- SQLite persistence
- OpenClaw agent engine + CoworkEngineRouter
- 40+ IPC channel handlers
- Security: context isolation, no node integration, sandbox enabled

#### Preload Script (`src/main/preload.ts`)

- Exposes `window.electron` API via `contextBridge`
- Includes `cowork` namespace for session management

#### Renderer Process (`src/renderer/`)

- React 18 + Redux Toolkit + Tailwind CSS
- All UI and business logic
- Communicates via IPC only

---

### Directory Structure

```
src/
├── main/                           # Electron main process
│   ├── main.ts                     # Entry point, IPC handlers
│   ├── preload.ts                  # Security bridge
│   ├── sqliteStore.ts              # SQLite storage
│   ├── coworkStore.ts              # Session/message CRUD
│   ├── skillManager.ts             # Skill management
│   └── libs/
│       ├── agentEngine/
│       │   ├── coworkEngineRouter.ts      # Dispatch layer
│       │   └── openclawRuntimeAdapter.ts  # OpenClaw adapter
│       ├── openclawEngineManager.ts       # OpenClaw lifecycle
│       └── coworkMemoryExtractor.ts       # Memory extraction
│
├── renderer/                        # React frontend
│   ├── App.tsx                     # Root component
│   ├── store/slices/               # Redux state
│   └── components/
│       ├── cowork/                 # Cowork UI
│       ├── artifacts/              # Artifact renderers
│       └── Settings.tsx            # Settings panel
│
SKILLs/                              # Skill definitions
├── skills.config.json              # Skill configuration
├── web-search/                     # Web search
├── docx/                           # Word documents
├── xlsx/                           # Excel spreadsheets
├── pptx/                           # PowerPoint
└── ...                             # More skills
```

---

### Data Storage

All data stored in local SQLite (`gucciai.sqlite`).

| Table | Purpose |
|-------|---------|
| `kv` | App configuration |
| `cowork_config` | Cowork settings |
| `cowork_sessions` | Session metadata |
| `cowork_messages` | Message history |
| `user_memories` | User memory entries |
| `agents` | Custom Agent configs |
| `mcp_servers` | MCP server configs |
| `scheduled_task_meta` | Scheduled task metadata |

---

### Security Model

| Layer | Protection |
|-------|------------|
| Process Isolation | Context isolation enabled, node integration disabled |
| Permission Gating | Tool invocations require approval |
| Sandbox Execution | Optional OpenClaw sandbox |
| Content Security | HTML sandbox, DOMPurify, Mermaid strict mode |
| Workspace Boundaries | File operations restricted to working directory |
| IPC Validation | All cross-process calls type-checked |

---

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Electron 40 |
| Frontend | React 18 + TypeScript |
| Build | Vite 5 |
| Styling | Tailwind CSS 3 |
| State | Redux Toolkit |
| AI Engine | OpenClaw |
| Storage | better-sqlite3 |
| Markdown | react-markdown + remark-gfm + rehype-katex |
| Diagrams | Mermaid |
| Security | DOMPurify |

---

## Configuration

### App Configuration

Stored in SQLite `kv` table, editable through Settings panel.

### Cowork Configuration

- **Working Directory** — Root for Agent operations
- **System Prompt** — Customize Agent behavior
- **Execution Mode** — `auto` / `local`

### Internationalization

English and Chinese supported. Switch in Settings panel.

---

## OpenClaw Integration

GucciAI pins OpenClaw to a specific version in `package.json`:

```json
{
  "openclaw": {
    "version": "v2026.3.2",
    "repo": "https://github.com/openclaw/openclaw.git"
  }
}
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENCLAW_SRC` | OpenClaw source path | `../openclaw` |
| `OPENCLAW_FORCE_BUILD` | Force rebuild | — |
| `OPENCLAW_SKIP_ENSURE` | Skip version checkout | — |

### Updating OpenClaw

1. Change `openclaw.version` in `package.json`
2. Run `npm run electron:dev:openclaw` or `npm run dist:win`
3. Commit the change

---

## Development Guidelines

- TypeScript strict mode, functional components + Hooks
- 2-space indentation, single quotes, semicolons
- Components: `PascalCase`; functions/variables: `camelCase`
- Tailwind CSS preferred; avoid custom CSS
- Commit format: `type: short summary` (e.g., `feat: add toolbar`)

---

## Testing

Unit tests use [Vitest](https://vitest.dev/), co-located with source files.

```bash
npm test                  # All tests
npm test -- logger        # Specific module
```

Test files use `.test.ts` extension, placed next to the source file.

---

## Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/your-feature`)
3. Commit changes (`git commit -m 'feat: add something'`)
4. Push to branch (`git push origin feature/your-feature`)
5. Open a Pull Request

---

## License

[MIT License](LICENSE)

---

## Acknowledgments

This project was developed with reference to [LobsterAI](https://github.com/netease-youdao/LobsterAI). Special thanks to the LobsterAI team for their pioneering work in personal assistant agent development.
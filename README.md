# GucciAI — All-in-One Personal Assistant Agent

<p align="center">
  <img src="public/logo.png" alt="GucciAI" width="120">
</p>

<p align="center">
  <strong>A 24/7 personal assistant Agent that gets things done</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/Version-2026.4.12-green.svg?style=for-the-badge" alt="Version">
  <br>
  <img src="https://img.shields.io/badge/Platform-macOS%20%7C%20Windows%20%7C%20Linux-brightgreen?style=for-the-badge" alt="Platform">
  <img src="https://img.shields.io/badge/Electron-41-47848F?style=for-the-badge&logo=electron&logoColor=white" alt="Electron">
  <img src="https://img.shields.io/badge/React-18-61DAFB?style=for-the-badge&logo=react&logoColor=black" alt="React">
</p>

<p align="center">
  English · <a href="README_zh.md">中文</a>
</p>

---

**GucciAI** is an all-in-one personal assistant Agent. It works around the clock to handle your everyday tasks — data analysis, making presentations, generating videos, writing documents, searching the web, sending emails, scheduling tasks, and more.

At its core is **Cowork mode** — it executes tools, manipulates files, and runs commands in a local or sandboxed environment, all under your supervision.

## Key Features

| Feature | Description |
|---------|-------------|
| **All-in-One Productivity** | Data analysis, PPT creation, video generation, document writing, web search, email — covers the full range of daily work |
| **Local + Sandbox Execution** | Run tasks directly on your machine or in an OpenClaw sandbox environment |
| **Built-in Skills** | Office document generation (Word/Excel/PPT/PDF), web search, file operations, custom skill creation |
| **Windows Python Runtime** | Windows packages bundle a ready-to-use Python interpreter; dependencies install on demand |
| **Scheduled Tasks** | Create recurring tasks via conversation or GUI — daily news digests, inbox cleanup, periodic reports |
| **Persistent Memory** | Automatically extracts preferences and facts from conversations, remembers across sessions |
| **IM Integration** | Remote control via IM platforms — Coming Soon |
| **Permission Gating** | All tool invocations require explicit user approval before execution |
| **Cross-Platform** | macOS (Intel + Apple Silicon), Windows, Linux desktop |
| **Local Data** | SQLite storage keeps your chat history and configuration on your device |

## Architecture Overview

<p align="center">
  <img src="docs/res/architecture.png" alt="Architecture Overview" width="800">
</p>

## Getting Started

### Prerequisites

- **Node.js** >= 24 < 25
- **npm**

### Development

```bash
git clone https://github.com/liangxhao/GucciAI.git
cd GucciAI
git checkout dev
npm install

# Start development (Vite + Electron with hot reload)
npm run electron:dev

# With OpenClaw agent engine (auto clones & builds on first run)
npm run electron:dev:openclaw
```

Dev server runs at `http://localhost:5175`. OpenClaw source defaults to `../openclaw`.

<details>
<summary>OpenClaw Environment Variables</summary>

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENCLAW_SRC` | OpenClaw source path | `../openclaw` |
| `OPENCLAW_FORCE_BUILD` | Force rebuild | — |
| `OPENCLAW_SKIP_ENSURE` | Skip version checkout | — |

</details>

### Production Build & Packaging

```bash
npm run build           # TypeScript + Vite bundle
npm run lint            # ESLint check

# Platform-specific installers (output to release/)
npm run dist:mac        # macOS .dmg
npm run dist:win        # Windows .exe (NSIS)
npm run dist:linux      # Linux .AppImage & .deb
```

Desktop packages bundle a prebuilt OpenClaw runtime — no manual setup needed.

## Core Systems

### Cowork System

An AI working session system powered by OpenClaw, autonomously completing complex tasks.

| Mode | Description |
|------|-------------|
| `auto` | Automatically selects execution context |
| `local` | Direct local execution, full speed |

All tool invocations (filesystem, terminal, network) require explicit approval via `CoworkPermissionModal`.

### Skills System

| Skill | Function |
|-------|----------|
| `web-search` | Web search |
| `docx` | Word document generation |
| `xlsx` | Excel spreadsheet generation |
| `pptx` | PowerPoint creation |
| `pdf` | PDF processing |
| `create-plan` | Implementation planning |
| `local-tools` | File and system operations |
| `skill-creator` | Custom skill creation |

Custom skills can be created via `skill-creator` and hot-loaded at runtime.

### Scheduled Tasks

Create recurring tasks via natural language or GUI. Examples: daily news collection, weekly reports, email cleanup.

### Persistent Memory

| File | Purpose |
|------|---------|
| `MEMORY.md` | Durable facts and preferences |
| `memory/YYYY-MM-DD.md` | Daily notes |
| `USER.md` | User profile |
| `SOUL.md` | Agent personality |

## Technical Details

### Process Model

Electron strict process isolation with IPC communication.

| Process | Responsibilities |
|---------|------------------|
| **Main** (`src/main/`) | Window lifecycle, SQLite, OpenClaw engine, 40+ IPC handlers |
| **Preload** (`src/main/preload.ts`) | `contextBridge` API, `cowork` namespace |
| **Renderer** (`src/renderer/`) | React 18 + Redux + Tailwind, all UI logic |

### Directory Structure

```
src/
├── main/           # Electron main process
│   ├── main.ts     # Entry point, IPC handlers
│   ├── preload.ts  # Security bridge
│   └── libs/       # Agent engine, memory extraction
├── renderer/       # React frontend
│   ├── App.tsx     # Root component
│   └── components/ # Cowork UI, Settings, Artifacts
SKILLs/             # Skill definitions
├── web-search/     # Web search
├── docx/           # Word documents
├── xlsx/           # Excel spreadsheets
├── pptx/           # PowerPoint
└── pdf/            # PDF processing
```

### Data Storage

Local SQLite (`gucciai.sqlite`): app config, sessions, messages, memories, agents, MCP servers, scheduled tasks.

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Electron 41 |
| Frontend | React 18 + TypeScript |
| Build | Vite 5 |
| Styling | Tailwind CSS 3 |
| State | Redux Toolkit |
| AI Engine | OpenClaw |
| Storage | better-sqlite3 |

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

### OpenClaw Integration

Version pinned in `package.json`:

```json
{
  "openclaw": {
    "version": "v2026.4.11",
    "repo": "https://github.com/openclaw/openclaw.git"
  }
}
```

To update: change version in `package.json`, run build, commit.

### Internationalization

English and Chinese supported. Switch in Settings panel.

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

Developed with reference to [LobsterAI](https://github.com/netease-youdao/LobsterAI). Thanks to the LobsterAI team for their pioneering work.
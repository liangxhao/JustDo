# JustDo — 全场景个人助理 Agent

<p align="center">
  <img src="public/logo.png" alt="JustDo" width="120">
</p>

<p align="center">
  <strong>7×24 小时帮你干活的个人助理 Agent</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/Version-2026.6.25-green.svg?style=for-the-badge" alt="Version">
  <br>
  <img src="https://img.shields.io/badge/Platform-macOS%20%7C%20Windows%20%7C%20Linux-brightgreen?style=for-the-badge" alt="Platform">
  <img src="https://img.shields.io/badge/Electron-41-47848F?style=for-the-badge&logo=electron&logoColor=white" alt="Electron">
  <img src="https://img.shields.io/badge/React-18-61DAFB?style=for-the-badge&logo=react&logoColor=black" alt="React">
</p>

<p align="center">
  <a href="README.md">English</a> · 中文
</p>

---

**JustDo** 是全场景个人助理 Agent。它 7×24 小时待命，能够帮你完成日常办公中的各类事务 —— 数据分析、制作 PPT、生成视频、撰写文档、搜索信息、收发邮件、定时任务，以及更多。

JustDo 的核心是 **Cowork 模式**，它能在本地或沙箱环境中执行工具、操作文件、运行命令，一切都在你的监督下自主完成。

JustDo 是 [OpenClaw Gateway](https://github.com/openclaw/openclaw) 的**薄前端**——所有 AI 推理、会话生命周期、消息历史和子智能体管理均由 Gateway 处理。JustDo 负责 UI 展示、配置管理和权限控制。

## 核心特性

| 特性 | 说明 |
|------|------|
| **OpenClaw Gateway 薄前端** | 所有 AI 执行、历史、子智能体生命周期委派给 OpenClaw。JustDo 是纯 UI 前端 |
| **Cowork 模式 (Auto/Local)** | AI 工作会话系统，在本地或沙箱环境中自主完成复杂任务 |
| **17 个内置技能** | Office 文档、Web 搜索、浏览器自动化、数据分析、图表生成、AI 艺术等 |
| **定时任务** | 通过对话或 GUI 创建定时任务，使用 OpenClaw cron 引擎 |
| **持久记忆** | 自动跨会话提取偏好与事实（MEMORY.md、USER.md、SOUL.md） |
| **权限门控** | 所有敏感工具调用需用户明确批准 |
| **14 套主题** | 内置主题系统，14 套精选主题，支持中英文界面 |
| **Lit 聊天渲染** | 使用 `<justdo-chat>` Lit 自定义元素渲染消息，与 OpenClaw webchat 一致的渲染管线 |
| **IM 集成** | 通过 IM 平台远程操控（Telegram、Discord）—— 开发中 |
| **跨平台** | macOS（Intel + Apple Silicon）、Windows、Linux 桌面端 |
| **数据本地化** | SQLite 作为 UI 缓存，配置和会话元数据保留在本地 |

## 架构概览

JustDo 被设计为 OpenClaw Gateway 的**薄前端**：

```
┌─────────────────────────────────────────────────────────────┐
│                      JustDo (前端)                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  React UI   │  │ Config Sync │  │   Skill Manager     │  │
│  │ (renderer)  │  │ (API/model) │  │ (sync to Gateway)   │  │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘  │
│         │                │                     │             │
│  ┌──────┴──────────────────────────────────────┴──────────┐  │
│  │   <justdo-chat> Lit Element (直接 WebSocket)            │  │
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

### 核心架构原则 (v2026.6)

1. **薄前端** — JustDo 不注入自定义 system prompt、AGENTS.md policy 或 per-agent workspace。所有 AI 上下文由 Gateway 管理。
2. **单一引擎** — OpenClaw Gateway 是唯一 AI 引擎。无双引擎架构。
3. **运行时为预构建 npm 包** — OpenClaw 运行时以预构建 npm 包下载，不从源码克隆构建。
4. **Gateway 为单一权威** — Gateway 的 `chat.history` 是消息历史的权威来源。SQLite 仅为 UI 缓存。
5. **Lit 聊天渲染** — 消息渲染使用与 OpenClaw webchat 一致的 Lit 管线（`<justdo-chat>` 自定义元素直接连接 Gateway WebSocket）。
6. **子智能体逻辑完全收缩** — 无本地子智能体状态追踪，父子关系由 Gateway 管理。

## 快速开始

### 环境要求

- **Node.js** >= 24 < 25
- **npm**

### 开发

```bash
git clone https://github.com/liangxhao/JustDo.git
cd JustDo
git checkout dev
npm install

# 启动开发环境（Vite + Electron 热重载）
npm run electron:dev

# 使用 OpenClaw 运行时（首次自动下载预构建包）
npm run electron:dev:openclaw
```

开发服务器默认运行在 `http://localhost:5175`，支持 HMR。OpenClaw 运行时以预构建 npm 包形式下载。

<details>
<summary>OpenClaw 环境变量</summary>

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `OPENCLAW_FORCE_INSTALL` | 强制重新安装预构建运行时 | — |

</details>

### 生产构建与打包

```bash
npm run build           # TypeScript + Vite 打包
npm run lint            # ESLint 检查

# 各平台安装包（输出到 release/）
npm run dist:mac        # macOS .dmg (Apple Silicon)
npm run dist:win        # Windows .exe (NSIS)
npm run dist:linux      # Linux .AppImage & .deb
```

桌面端打包内置预构建的 OpenClaw runtime，无需手动配置。

## 核心系统

### Cowork 系统

以 OpenClaw Gateway 为引擎的 AI 工作会话系统，自主完成复杂任务。

| 模式 | 说明 |
|------|------|
| `auto` | 自动根据上下文选择执行方式 |
| `local` | 本地直接执行，全速运行 |

所有涉及文件系统、终端、网络的工具调用需在 `CoworkPermissionModal` 中明确批准。

聊天消息由基于 Lit 的渲染管线（`<justdo-chat>` 元素）渲染，直接连接 Gateway WebSocket——与 OpenClaw webchat 完全一致。

### 技能系统（17 个内置技能）

技能由 OpenClaw Gateway 管理。JustDo 将技能定义从 `resources/skills/` 同步到 Gateway 的状态目录。

| 技能 | 类别 |
|------|------|
| `docx` / `xlsx` / `pptx` / `pdf` | Office 文档 |
| `multi-search-engine` | 多引擎 Web 搜索 |
| `playwright` / `agent-browser` | 浏览器自动化 |
| `data-analysis` | 数据处理与可视化 |
| `diagram-generator` | 图表与流程图 |
| `algorithmic-art` | 生成式 AI 艺术 |
| `taskflow` | 多步骤工作流 |
| `mcp-builder` | MCP 服务器创建 |
| `self-improvement` | 智能体自优化 |
| `ontology` | 领域知识建模 |
| `theme-factory` | UI 主题生成 |
| `healthcheck` | 系统健康诊断 |

通过 `skill-creator` 可创建自定义技能并热加载。用户导入的技能存储在 `userData/openclaw/state/skills/`，内置技能在 ID 冲突时优先。

### 定时任务

通过自然语言或 GUI 创建定时任务，底层使用 OpenClaw cron 引擎。示例：每日新闻收集、每周报告、邮箱整理。任务元数据本地持久化在 `scheduled_task_meta` 表中。

### 持久记忆

由 OpenClaw Gateway 管理的文件级记忆系统：

| 文件 | 用途 |
|------|------|
| `MEMORY.md` | 持久化事实与偏好 |
| `memory/YYYY-MM-DD.md` | 每日临时笔记 |
| `USER.md` | 用户档案 |
| `SOUL.md` | Agent 个性与行为准则 |

### 聊天渲染

消息渲染使用与 OpenClaw webchat 完全一致的 Lit 管线：

```
Gateway WebSocket → GatewayClient → ChatController → <justdo-chat> Lit Element → Shadow DOM
```

关键优势：
- 消除消息重复、截断、丢失问题
- 直接 WebSocket 连接（无 IPC 往返）
- 与 webchat 一致的渲染管线（行为一致）
- 流式内容、thinking 内容、工具调用均在管线中处理

## 技术细节

### 进程模型

Electron 严格进程隔离，通过 IPC 通信。

| 进程 | 职责 |
|------|------|
| **Main** (`src/main/`) | 窗口生命周期、SQLite、OpenClaw Gateway 进程管理、40+ IPC 处理 |
| **Preload** (`src/main/preload.ts`) | `contextBridge` API、`cowork` 命名空间 |
| **Renderer** (`src/renderer/`) | React 18 + Redux + Tailwind，所有 UI 逻辑，Lit 聊天渲染 |

### 目录结构

```
src/
├── main/               # Electron 主进程
│   ├── main.ts         # 入口
│   ├── preload.ts      # contextBridge 安全层
│   ├── sqliteStore.ts  # SQLite 数据库管理
│   ├── coworkStore.ts  # Cowork 会话与消息 CRUD
│   └── libs/           # 引擎管理、配置同步
│
├── renderer/           # React 前端 + Lit 聊天
│   ├── App.tsx         # 根组件
│   ├── theme/          # 主题系统（14 套主题）
│   │   ├── engine/     # 主题引擎
│   │   ├── themes/     # 主题定义
│   │   ├── tailwind/   # Tailwind 集成
│   │   └── tokens/     # 设计令牌
│   ├── components/     # UI 组件
│   │   └── cowork/
│   │       ├── JustDoChatWrapper.tsx  # React ↔ Lit 桥接
│   │       ├── CoworkView.tsx
│   │       ├── CoworkSessionList.tsx
│   │       ├── CoworkPermissionModal.tsx
│   │       └── ...
│   ├── libs/
│   │   └── openclaw-chat/ # Lit 聊天渲染管线
│   │       ├── gateway/    # GatewayClient + ChatController
│   │       ├── components/ # Lit 组件
│   │       ├── pipeline/   # 消息处理管线
│   │       └── conversion/ # 数据转换
│   ├── store/           # Redux slices
│   └── types/           # TypeScript 类型
│
├── scheduledTask/      # Cron 引擎、任务元数据
└── shared/             # 平台与 Provider 常量

resources/skills/       # 17 个内置技能定义（Gateway 管理）
openclaw-extensions/    # OpenClaw 本地扩展
scripts/                # 构建和工具脚本
```

### Cowork 引擎架构

Cowork 会话使用基于 Gateway 的生命周期（`idle → downloading → installing → ready → running`）。历史记录通过 Gateway 的 `chat.startup` / `chat.history` RPC 加载。无本地子智能体状态追踪——父子关系完全由 Gateway 管理。

### 数据存储

本地 SQLite（`justdo.sqlite`）作为 **UI 缓存**，**不是**权威数据源：

| 数据 | 权威来源 | SQLite 角色 |
|------|----------|-------------|
| 消息历史 | Gateway `chat.history` API | UI 缓存 |
| 会话元数据 | JustDo 本地 | 主要存储 |
| 应用配置 | JustDo 本地 | 主要存储 |
| Agent 定义 | JustDo 本地 | 主要存储 |
| MCP 服务器 | JustDo 本地 | 主要存储 |

### 技术栈

| 层 | 技术 |
|----|----|
| 框架 | Electron 41 |
| 前端 | React 18 + TypeScript + Lit（聊天渲染） |
| 构建 | Vite 5 |
| 样式 | Tailwind CSS 3 |
| 状态 | Redux Toolkit |
| AI 引擎 | OpenClaw Gateway（预构建 npm 包） |
| 存储 | better-sqlite3（UI 缓存） |
| 聊天渲染 | Lit 3 + markdown-it + highlight.js + katex |

### 安全模型

- Context isolation 启用，node integration 禁用
- 敏感工具调用需用户审批
- 可选 OpenClaw 沙箱隔离
- HTML sandbox、DOMPurify、Mermaid strict mode
- 企业级配置同步支持

## 配置

### 应用与 Cowork

- **工作目录** — Agent 操作的根目录
- **系统提示词** — 自定义 Agent 行为
- **执行模式** — `auto` / `local`
- **模型 Provider 与模型** — AI 模型选择
- **Agent 引擎** — 始终为 `openclaw`（单一引擎）

### OpenClaw 集成

版本锁定在 `package.json`：

```json
{
  "openclaw": {
    "version": "v2026.6.9",
    "repo": "https://github.com/openclaw/openclaw.git",
    "plugins": []
  }
}
```

运行时以预构建 npm 包形式分发，通过平台特定脚本下载。

### 国际化

14 套内置主题。支持中文（默认）和英文，通过设置面板切换。

## 开发

- TypeScript 严格模式，函数式组件 + Hooks
- 2 空格缩进，单引号，分号
- 组件 `PascalCase`，函数/变量 `camelCase`
- Tailwind CSS 优先

### 测试

```bash
npm test              # 全部测试（Vitest）
npm test -- logger    # 指定模块
```

## 贡献

1. Fork → 创建特性分支 → 提交 → 推送 → 发起 PR
2. 遵循约定式提交：`type: 简短说明`

## 许可证

[MIT License](LICENSE)

## 致谢

本项目参考 [LobsterAI](https://github.com/netease-youdao/LobsterAI) 开发而成。感谢 LobsterAI 团队在个人助理 Agent 领域的开拓性工作。

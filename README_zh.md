# JustDo - 个人 AI 助理

JustDo 是一个基于 Electron、React、SQLite 和 OpenClaw Gateway 的桌面 AI 助理。它不是只给建议的聊天框，而是面向真实任务执行：对话、附件、技能、MCP、定时任务、桌面后台运行和本地配置管理都在同一个应用里完成。

![Version](https://img.shields.io/badge/Version-v2026.7.6-green.svg?style=for-the-badge)
![Electron](https://img.shields.io/badge/Electron-42-47848F?style=for-the-badge&logo=electron&logoColor=white)
![Node](https://img.shields.io/badge/Node-24.x-339933?style=for-the-badge&logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)

## 当前能力

| 能力 | 当前实现 |
| --- | --- |
| AI 工作会话 | OpenClaw Gateway 是执行引擎。JustDo 负责桌面壳、UI 状态、权限和本地缓存。 |
| 聊天 UI | React 负责应用外壳；`<justdo-chat>` 是 Lit 自定义元素，直连本地 OpenClaw Gateway WebSocket。 |
| 本地存储 | `better-sqlite3` 保存 UI 缓存、应用设置、Agent、MCP、hooks、会话分组和 cowork 元数据。 |
| Skills | `resources/builtin-skills.json` 声明 15 个内置技能；默认启用 14 个，`agent-browser` 默认关闭。 |
| MCP 与 hooks | 在 Plugins 页面管理，本地持久化后同步到 OpenClaw 配置。 |
| 定时任务 | JustDo 负责 UI CRUD 和轮询；任务执行交给 OpenClaw cron runtime。 |
| 桌面集成 | 托盘、开机启动、防休眠、本地文件预览、日志、代理处理和平台打包资源。 |

## 架构概览

```text
Renderer (React + Redux + Lit)
  -> preload contextBridge (`window.electron`)
  -> Main process IPC handlers
  -> SQLite stores / plugin services / OpenClaw runtime manager
  -> OpenClaw Gateway
```

进程隔离规则：

- `src/main/` 是 Electron 主进程，可以访问 Node.js、SQLite、文件系统和 Electron API。
- `src/main/preload.ts` 是唯一暴露给渲染进程的 API 面。
- `src/renderer/` 是浏览器侧 React/Lit 代码，不能直接导入 Node.js 或 Electron。
- `src/shared/` 存放跨进程契约，不能依赖 Node、Electron 或浏览器专有 API。

## 快速开始

项目使用 Node.js 24，`package.json` 限制为 `>=24 <25`。

```bash
nvm use 24
npm install
npm run electron:dev
```

Vite 开发服务器端口来自 `package.json`：

```text
http://localhost:4175
```

需要准备并使用 OpenClaw host runtime 时：

```bash
npm run electron:dev:openclaw
```

OpenClaw runtime 会按版本和目标平台复用已安装的缓存。如果即使匹配版本已经存在，
仍需要重新下载并安装 runtime，请设置 `OPENCLAW_FORCE_INSTALL=1`：

```bash
# macOS / Linux
OPENCLAW_FORCE_INSTALL=1 npm run electron:dev:openclaw

# Windows PowerShell
$env:OPENCLAW_FORCE_INSTALL='1'; npm run electron:dev:openclaw
```

该变量同样适用于会调用 runtime 安装脚本的各平台 `openclaw:runtime:*` 命令和打包命令。

## 构建与测试

```bash
npm run lint
npm run build
npm run compile:electron
npm test
```

打包命令：

```bash
npm run pack
npm run dist
npm run dist:win
npm run dist:mac
npm run dist:linux
```

Windows 打包会通过 `scripts/` 下的脚本准备 MinGit 和 Python runtime。生产包会包含应用运行所需的 runtime 资源。

## 重要目录

| 路径 | 作用 |
| --- | --- |
| `src/main/core/` | 应用常量、窗口/托盘、日志、代理、CSP、Python runtime、本地文件协议 |
| `src/main/data/` | SQLite 包装层、cowork store、会话分组 store |
| `src/main/engine/` | cowork 路由、Gateway adapter、runtime 转发、命令安全 |
| `src/main/openclaw/` | Gateway 配置同步、runtime 生命周期、模型/会话/slash command 辅助逻辑 |
| `src/main/plugins/` | skills、MCP、hooks、extensions、marketplace 服务 |
| `src/main/scheduler/` | 定时任务 prompt/runtime 桥接 |
| `src/renderer/features/` | cowork、agents、models、plugins、scheduled tasks、settings 等 React feature |
| `src/renderer/libs/openclaw-chat/` | Lit 聊天元素与消息渲染管线 |
| `src/shared/` | cowork、OpenClaw、providers、plugins、scheduled tasks、slash commands 共享契约 |
| `resources/skills/` | 内置技能源目录 |
| `vendor/openclaw-runtime/` | 下载并同步的 OpenClaw runtime 产物 |

## 状态模型

Renderer Redux store 当前有 6 个 slice：

- `model`
- `cowork`
- `skill`
- `mcp`
- `scheduledTask`
- `agent`

历史上的独立 `coworkDeleteState` slice 已不再挂载到 store；删除状态留在 cowork feature 内部处理。

## 数据存储

应用数据库是 Electron `userData/JustDo` 下的 `justdo.sqlite`。核心表包括：

- `kv`
- `cowork_config`
- `cowork_sessions`
- `cowork_messages`
- `agents`
- `mcp_servers`
- `openclaw_hooks`
- `session_groups`

Gateway chat history 仍然是执行历史的权威来源。SQLite 保存本地 UI 缓存和产品元数据。

## 配置

OpenClaw 集成在 `package.json` 中声明：

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

Runtime patch 策略见 `scripts/patches/README.md`，当前 patch 摘要见 `docs/patches/openclaw-patch-guide.md`。

## 文档

从 [docs/README.md](docs/README.md) 开始阅读。架构文档描述当前实现状态，而不是历史迁移计划。

## 贡献约定

- 用户可见字符串放进 i18n map。
- Renderer 代码保持与 Node.js/Electron 隔离。
- IPC channel、状态值、判别字符串优先使用共享常量。
- 发布前运行 `npm run lint`、`npm run build`、`npm run compile:electron` 和 `npm test`。

## 许可证

MIT

# JustDo 项目概述

**Last Updated:** 2026-07-01
**Current Version:** 2026.7.1
**OpenClaw Gateway:** v2026.6.9

## 1. 产品定位

JustDo 是一款 **全天候个人助理 Agent** —— 一个基于 OpenClaw Gateway 的薄前端桌面客户端。它采用 Thin Frontend 架构，所有 Agent 执行逻辑完全由 OpenClaw Gateway 负责，JustDo 仅承担 UI 展示、配置管理和权限控制职责。

### 核心价值

- **真正执行任务**：经由 Gateway 调度，调用工具操作文件、运行命令、生成文档
- **7x24 小时在线**：支持定时任务（由 OpenClaw 内置 Cron 引擎调度）和远程操控（IM 集成规划中）
- **本地优先**：会话数据存储在本地 SQLite，作为 UI 缓存层，隐私可控
- **跨平台支持**：macOS、Windows、Linux 桌面
- **14 套主题**：支持中英文界面

## 2. 产品形态

### 2.1 桌面应用（主要形态）

基于 Electron + React 的跨平台桌面应用：

- macOS：支持 Intel 和 Apple Silicon 架构
- Windows：打包便携 Python 运行时，无需用户手动安装
- Linux：AppImage 和 deb 包

### 2.2 IM 远程控制（规划中）

通过 IM 平台远程触发桌面 Agent（功能开发中，UI 占位已就绪）：

> 支持多个主流 IM 平台的 Bot 接入，实现远程消息触发和结果推送。当前阶段尚未激活此功能。

### 2.3 定时任务

通过自然语言或 GUI 创建定时任务，由 OpenClaw 内置 Cron 引擎调度：

- 每日新闻摘要
- 定期报告生成
- 邮件清理
- 内容监控

## 3. 核心功能

### 3.1 Cowork 模式

Cowork 是 JustDo 的核心功能 —— 一个 AI 工作会话系统，支持两种执行模式：

| 模式 | 说明 |
|------|------|
| `auto` | 自动模式，Agent 自主执行，仅在高风险操作时请求授权 |
| `local` | 本地模式，Agent 执行文件操作和命令时需确认工作目录范围 |

执行流程：

1. 用户发送任务指令（如"分析这份 Excel 数据"）
2. Renderer 通过 IPC 将请求传递给 Main Process
3. Main Process 通过 OpenClaw Runtime Adapter 转发给 Gateway
4. Gateway 执行 Agent 推理，调用工具（需用户授权的步骤通过 IPC 请求 Renderer）
5. 执行过程和结果通过 Gateway WebSocket 流式回传
6. Lit `<justdo-chat>` 自定义元素直接连接 Gateway WebSocket 实时渲染聊天内容
7. 会话保存到本地 SQLite，可随时回顾

### 3.2 Skills 技能系统

内置 17 个 Skills 技能，由 OpenClaw Gateway 管理，覆盖文档生成、网络搜索、系统工具等场景：

| 类别 | 技能 |
|------|------|
| 文档生成 | `docx`（Word）、`xlsx`（Excel）、`pptx`（PPT）、`pdf` |
| 网络工具 | `multi-search-engine`、`playwright`、`agent-browser` |
| 数据处理 | `data-analysis`、`diagram-generator` |
| 系统工具 | `healthcheck`、`taskflow` |
| 扩展 | `skill-creator`、`self-improvement`、`mcp-builder` |
| 创意 | `algorithmic-art`、`theme-factory`、`ontology` |

> OpenClaw Gateway 的 `disableOpenClawDefaults: true` 配置确保仅加载已声明的技能。

### 3.3 持久化记忆

Agent 使用 Gateway 管理的内存文件系统实现持久化记忆：

- `MEMORY.md`：持久事实和偏好，每会话自动加载
- `USER.md`：用户画像
- `SOUL.md`：Agent 人格设定
- `memory/YYYY-MM-DD.md`：每日笔记

### 3.4 权限控制

所有工具调用都需要用户明确授权：

- 文件系统访问
- 终端命令执行
- 网络请求
- IM 消息发送

用户可选择单次授权或会话级授权。权限请求通过 IPC 从 Main Process 推送至 Renderer，用户在 CoworkPermissionModal 中做出决策。

## 4. 技术概览

### 4.1 架构层次

```
+-----------------------------------------------------+
|                    UI Layer                           |  React 18 + Tailwind CSS 3 + Lit
|   CoworkView, Settings, JustDoChatWrapper            |
|   <justdo-chat> Lit custom element (WebSocket)       |
+-----------------------------------------------------+
|                  Service Layer                        |  Redux Toolkit + IPC
|   coworkService, skillService, mcpService            |
|   8 Redux slices                                     |
+-----------------------------------------------------+
|            IPC Bridge (Preload)                       |  contextBridge
|        window.electron API                            |
+-----------------------------------------------------+
|                  Main Process                         |  Node.js + SQLite
|   CoworkStore, OpenClawEngineManager,                |
|   MCP Server Manager, Config Sync                    |
+-----------------------------------------------------+
|               Agent Runtime                           |  OpenClaw Gateway (pre-built npm package)
|     Tool Execution, Memory, WebSocket, Cron           |
+-----------------------------------------------------+
```

### 4.2 关键技术栈

| 层级 | 技术 |
|------|------|
| 框架 | Electron 41 |
| 前端 | React 18 + TypeScript + Lit（<justdo-chat>） |
| 构建 | Vite 5 |
| 样式 | Tailwind CSS 3 |
| 状态 | Redux Toolkit（8 slices） |
| Agent 引擎 | OpenClaw Gateway（唯一引擎，预构建 npm 包） |
| 本地存储 | better-sqlite3（UI 缓存） |
| Markdown | markdown-it + highlight.js |
| 运行时 | Node.js >=24 <25 |

### 4.3 数据存储

所有本地数据存储在 SQLite，作为 Gateway 后端数据的 UI 缓存：

| 表 | 用途 |
|------|------|
| `kv` | 应用配置（键值对） |
| `cowork_config` | Cowork 设置 |
| `cowork_sessions` | 会话元数据 |
| `cowork_messages` | 消息历史（含 thinking_content） |
| `cowork_subagents` | 子 Agent 追踪（由 Gateway 驱动） |
| `session_groups` | 会话分组 |
| `agents` | 自定义 Agent 配置 |
| `mcp_servers` | MCP 服务器配置 |
| `scheduled_tasks` | 定时任务定义 |

> 注意：JustDo 的 SQLite 是 Gateway 会话数据的本地缓存，不负责 Agent 状态的持久化 —— 所有 Agent 状态由 Gateway 全权管理。

## 5. 用户场景

### 5.1 数据分析

用户上传 Excel 文件，Agent 自动分析数据、生成图表、输出报告。

### 5.2 文档生成

用户描述需求（"帮我做一个产品介绍 PPT"），Agent 自动调用 `pptx` skill 生成演示文稿。

### 5.3 视频创作

用户描述视频需求，Agent 使用 `remotion` 或 `seedance` skill 生成视频。

### 5.4 远程办公（规划中）

用户在外出时可通过 IM 平台发送指令，Agent 在桌面端执行任务，结果推送回手机。

### 5.5 定时提醒

用户通过自然语言设置定时任务（"每天早上 9 点收集科技新闻"），Agent 定时执行并推送结果。

## 6. 与类似产品的区别

| 特性 | JustDo | 传统 AI Chat | AI IDE |
|------|--------|--------------|--------|
| 任务执行 | 真正执行工具 | 仅对话建议 | 仅代码生成 |
| 本地运行 | 本地优先（Thin Frontend） | 云端 | 云端/本地 |
| IM 集成 | 规划中 | 无 | 无 |
| 定时任务 | 支持（内置 Cron 引擎） | 无 | 无 |
| 持久记忆 | Gateway 管理文件记忆 | 有限上下文 | 项目上下文 |
| 权限控制 | 明确授权 | 无 | 有限 |
| 引擎架构 | 单引擎（OpenClaw Gateway） | 无 | 多引擎 |

## 7. 项目发展

### 版本规划

- **v2026.4**：品牌重塑，稳定版本
- **v2026.5**：薄前端架构重构，OpenClaw Gateway 深度集成
- **v2026.7**：主进程领域重组，移除企业模式，精简为 OpenAI 兼容 providers only

### 版本历史

| 版本 | 日期 | 主要变更 |
|------|------|----------|
| 2026.7.1 | 2026-07 | 当前版本。主进程按领域重构（core/data/features/libs/cowork/infra/mcp/openclaw）。移除企业模式、Skill Security Scanner、OpenAI Compat Proxy。精简为 OpenAI 兼容 providers only。 |
| 2026.6.25 | 2026-06 | Lit `<justdo-chat>` 渲染管道替换 Redux 驱动渲染。Gateway WebSocket 直连。Subagent 逻辑完全移交 Gateway。运行时作为预构建 npm 包分发。 |
| 2026.5.x | 2026-05 | Thin Frontend 架构重构，Gateway 深度集成。移除 `yd_cowork` 和 Claude Agent SDK 引擎。 |
| 2026.4.x | 2026-04 | 品牌重塑为 JustDo，基础架构稳定。 |

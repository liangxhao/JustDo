# GucciAI 项目概述

## 1. 产品定位

GucciAI 是一款 **全天候个人助理 Agent** —— 一个能够自主执行任务的 AI 助手。它不仅能回答问题，还能真正帮你完成工作：数据分析、制作演示文稿、生成视频、撰写文档、网络搜索、发送邮件、定时任务等。

### 核心价值

- **真正执行任务**：不仅是建议，而是真正调用工具、操作文件、运行命令
- **7×24 小时在线**：通过 IM 平台远程控制，手机随时指挥
- **本地优先**：数据存储在本地 SQLite，隐私可控
- **跨平台支持**：macOS、Windows、Linux 桌面 + IM 移动端覆盖

## 2. 产品形态

### 2.1 桌面应用（主要形态）

基于 Electron + React 的跨平台桌面应用：

- macOS：支持 Intel 和 Apple Silicon 架构
- Windows：打包便携 Python 运行时，无需用户手动安装
- Linux：AppImage 和 deb 包

### 2.2 IM 远程控制

通过 IM 平台远程触发桌面 Agent（功能规划中）：

> 支持多个主流 IM 平台的 Bot 接入，实现远程消息触发和结果推送。

### 2.3 定时任务

通过自然语言或 GUI 创建定时任务：

- 每日新闻摘要
- 定期报告生成
- 邮件清理
- 内容监控

## 3. 核心功能

### 3.1 Cowork 模式

Cowork 是 GucciAI 的核心功能 —— 一个 AI 工作会话系统：

1. 用户发送任务指令（如"分析这份 Excel 数据")
2. Agent 解析任务，规划执行步骤
3. Agent 调用工具执行（可能需要用户授权）
4. 流式输出执行过程和结果
5. 会话保存到本地 SQLite，可随时回顾

### 3.2 Skills 技能系统

内置多个 Skills 技能，默认启用 8 个核心技能，覆盖文档生成、网络搜索、系统工具等场景：

| 类别 | 技能示例 |
|------|----------|
| 文档生成 | docx（Word）、xlsx（Excel）、pptx（PPT）、pdf |
| 网络工具 | web-search |
| 系统工具 | local-tools |
| 扩展管理 | skill-creator、create-plan |

### 3.3 持久化记忆

Agent 能够记住你的偏好和习惯：

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

用户可选择单次授权或会话级授权。

## 4. 技术概览

### 4.1 架构层次

```
┌─────────────────────────────────────┐
│           UI Layer                   │  React + Tailwind
│   CoworkView, Settings, IMSettings   │
├─────────────────────────────────────┤
│         Service Layer                │  Redux + IPC
│   coworkService, apiService, im      │
├─────────────────────────────────────┤
│          IPC Bridge                  │  Preload + contextBridge
│        window.electron               │
├─────────────────────────────────────┤
│          Main Process                │  Node.js + SQLite
│   CoworkStore, AgentEngine, IM       │
├─────────────────────────────────────┤
│         Agent Runtime                │  OpenClaw Gateway
│     Tool Execution, Memory           │
└─────────────────────────────────────┘
```

### 4.2 关键技术栈

| 层级 | 技术 |
|------|------|
| 框架 | Electron 40 |
| 前端 | React 18 + TypeScript |
| 构建 | Vite 5 |
| 样式 | Tailwind CSS 3 |
| 状态 | Redux Toolkit |
| Agent 引擎 | OpenClaw（主要） |
| 存储 | better-sqlite3 |
| Markdown | react-markdown + remark-gfm |
| 图表 | Mermaid |

### 4.3 数据存储

所有数据存储在本地 SQLite：

| 表 | 用途 |
|------|------|
| `kv` | 应用配置 |
| `cowork_config` | Cowork 设置 |
| `cowork_sessions` | 会话元数据 |
| `cowork_messages` | 消息历史 |
| `user_memories` | 用户记忆条目 |
| `agents` | 自定义 Agent 配置 |
| `mcp_servers` | MCP 服务器配置 |
| `im_config` | IM 网关配置 |
| `im_session_mappings` | IM 会话映射 |
| `scheduled_task_meta` | 定时任务元数据 |

## 5. 用户场景

### 5.1 数据分析

用户上传 Excel 文件，Agent 自动分析数据、生成图表、输出报告。

### 5.2 文档生成

用户描述需求（"帮我做一个产品介绍 PPT"，Agent 自动调用 pptx skill 生成演示文稿。

### 5.3 视频创作

用户描述视频需求，Agent 使用 remotion 或 seedance skill 生成视频。

### 5.4 远程办公

用户在外出时可通过 IM 平台发送指令，Agent 在桌面端执行任务，结果推送回手机。

### 5.5 定时提醒

用户通过自然语言设置定时任务（"每天早上 9 点收集科技新闻"），Agent 定时执行并推送结果。

## 6. 与类似产品的区别

| 特性 | GucciAI | 传统 AI Chat | AI IDE |
|------|---------|--------------|--------|
| 任务执行 | ✓ 真正执行工具 | 仅对话建议 | 仅代码生成 |
| 本地运行 | ✓ 本地优先 | 云端 | 云端/本地 |
| IM 集成 | 规划中 | 无 | 无 |
| 定时任务 | ✓ 支持 | 无 | 无 |
| 持久记忆 | ✓ 文件记忆 | 有限上下文 | 项目上下文 |
| 权限控制 | ✓ 明确授权 | 无 | 有限 |

## 7. 项目发展

### 版本规划

- **v2026.4**：品牌重塑，稳定版本
- **v2026.5**：扩展 Skills 技能库
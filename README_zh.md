# GucciAI — All-in-One Personal Assistant Agent

<p align="center">
  <img src="public/logo.png" alt="GucciAI" width="120">
</p>

<p align="center">
  <strong>7×24 小时帮你干活的个人助理 Agent</strong>
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
  <a href="README.md">English</a> · 中文
</p>

---

**GucciAI** 是全场景个人助理 Agent。它 7×24 小时待命，能够帮你完成日常办公中的各类事务 —— 数据分析、制作 PPT、生成视频、撰写文档、搜索信息、收发邮件、定时任务，以及更多。

GucciAI 的核心是 **Cowork 模式**，它能在本地或沙箱环境中执行工具、操作文件、运行命令，一切都在你的监督下自主完成。

---

## 目录

- [核心特性](#核心特性)
- [架构概览](#架构概览)
- [快速开始](#快速开始)
  - [环境要求](#环境要求)
  - [开发](#开发)
  - [生产构建](#生产构建)
  - [打包](#打包)
- [核心系统](#核心系统)
  - [Cowork 系统](#cowork-系统)
  - [技能系统](#技能系统)
  - [定时任务](#定时任务)
  - [持久记忆](#持久记忆)
- [技术细节](#技术细节)
  - [进程模型](#进程模型)
  - [目录结构](#目录结构)
  - [数据存储](#数据存储)
  - [安全模型](#安全模型)
  - [技术栈](#技术栈)
- [配置](#配置)
- [OpenClaw 集成](#openclaw-集成)
- [开发规范](#开发规范)
- [测试](#测试)
- [贡献](#贡献)
- [许可证](#许可证)
- [致谢](#致谢)

---

## 核心特性

| 特性 | 说明 |
|------|------|
| **全场景办公** | 数据分析、PPT 制作、视频生成、文档撰写、Web 搜索、邮件收发，覆盖日常办公全流程 |
| **本地 + 沙箱执行** | 任务执行支持本地直接运行或 OpenClaw 沙箱环境 |
| **内置技能** | Office 文档生成、Web 搜索、Playwright 自动化、Remotion 视频生成等 |
| **Windows Python 运行时** | Windows 安装包内置 Python 解释器；依赖按需安装 |
| **定时任务** | 对话式或 GUI 添加定时任务 —— 每日新闻收集、邮箱整理、周期性报告 |
| **持久记忆** | 自动提取偏好与个人信息，跨会话记住你的习惯 |
| **IM 集成** | 通过 IM 平台远程操控 —— Coming Soon |
| **权限门控** | 所有敏感工具调用需用户明确批准 |
| **跨平台** | macOS（Intel + Apple Silicon）、Windows、Linux 桌面端 |
| **数据本地化** | SQLite 本地存储，数据不离开你的设备 |

---

## 架构概览

<p align="center">
  <img src="docs/res/architecture.png" alt="架构概览" width="800">
</p>

---

## 快速开始

### 环境要求

- **Node.js** >= 24 < 25
- **npm**

### 开发

```bash
# 克隆仓库
git clone https://github.com/liangxhao/GucciAI.git
cd GucciAI
git checkout dev

# 安装依赖
npm install

# 启动开发环境（Vite + Electron 热重载）
npm run electron:dev
```

开发服务器默认运行在 `http://localhost:5175`。

#### 使用 OpenClaw Agent 引擎

GucciAI 使用 [OpenClaw](https://github.com/openclaw/openclaw) 作为 Agent 引擎。所依赖版本在 `package.json` 中声明。

```bash
# 首次运行：自动克隆并构建 OpenClaw（可能需要几分钟）
npm run electron:dev:openclaw

# 后续运行：版本未变时自动跳过构建
npm run electron:dev:openclaw
```

默认 OpenClaw 源码在 `../openclaw`。可通过环境变量覆盖：

```bash
OPENCLAW_SRC=/path/to/openclaw npm run electron:dev:openclaw
OPENCLAW_FORCE_BUILD=1 npm run electron:dev:openclaw   # 强制重新构建
OPENCLAW_SKIP_ENSURE=1 npm run electron:dev:openclaw   # 跳过版本切换
```

### 生产构建

```bash
# 编译 TypeScript + Vite 打包
npm run build

# ESLint 代码检查
npm run lint
```

### 打包

使用 [electron-builder](https://www.electron.build/) 生成各平台安装包，输出到 `release/`。

```bash
# macOS (.dmg)
npm run dist:mac
npm run dist:mac:x64        # 仅 Intel
npm run dist:mac:arm64      # 仅 Apple Silicon
npm run dist:mac:universal  # 双架构

# Windows (.exe NSIS 安装包)
npm run dist:win

# Linux (.AppImage & .deb)
npm run dist:linux
```

桌面端打包内置预构建的 OpenClaw runtime，版本自动拉取构建。

手动构建 OpenClaw runtime：

```bash
npm run openclaw:runtime:host        # 当前主机平台
npm run openclaw:runtime:mac-arm64   # macOS ARM64
npm run openclaw:runtime:win-x64     # Windows x64
npm run openclaw:runtime:linux-x64   # Linux x64
```

---

## 核心系统

### Cowork 系统

Cowork 是 GucciAI 的核心功能 —— 以 OpenClaw 为引擎的 AI 工作会话系统，能够自主完成数据分析、文档生成、信息检索等复杂任务。

#### 执行模式

| 模式 | 说明 |
|------|------|
| `auto` | 自动根据上下文选择执行方式 |
| `local` | 本地直接执行，全速运行 |

#### 流式事件

Cowork 通过 IPC 事件实现实时通信：

| 事件 | 说明 |
|------|------|
| `message` | 新消息加入会话 |
| `messageUpdate` | 流式内容增量更新 |
| `permissionRequest` | 工具执行需用户审批 |
| `complete` | 会话执行完毕 |
| `error` | 执行出错 |

#### 权限控制

所有涉及文件系统、终端、网络的工具调用需用户在 `CoworkPermissionModal` 中明确批准。

---

### 技能系统

GucciAI 内置 29 种技能，覆盖办公、创作、自动化等场景。

| 技能 | 功能 |
|------|------|
| `web-search` | Web 搜索 |
| `docx` | Word 文档生成 |
| `xlsx` | Excel 表格生成 |
| `pptx` | PowerPoint 制作 |
| `pdf` | PDF 处理 |
| `remotion` | 视频生成（Remotion） |
| `seedance` | AI 视频生成 |
| `seedream` | AI 图片生成 |
| `playwright` | Web 自动化 |
| `canvas-design` | Canvas 绘图设计 |
| `frontend-design` | 前端 UI 设计 |
| `stock-analyzer` | 股票深度分析 |
| `local-tools` | 本地文件和系统操作 |
| `skill-creator` | 自定义技能创建 |

支持通过 `skill-creator` 创建自定义技能并热加载。

---

### 定时任务

创建定时任务，让 Agent 按计划自动执行重复性工作。

#### 创建方式

- **对话式** — 直接用自然语言告诉 Agent（如「每天早上 9 点帮我收集科技新闻」）
- **GUI 界面** — 在定时任务管理面板手动添加

#### 典型场景

| 场景 | 示例 |
|------|------|
| 新闻收集 | 每天早上自动收集行业资讯并生成摘要 |
| 邮箱整理 | 定时检查收件箱，分类整理并汇总重要邮件 |
| 数据报告 | 每周自动生成业务数据分析报告 |
| 信息监控 | 定期检查指定网站内容变化 |

定时任务基于 Cron 表达式调度，支持分钟、小时、日、周、月等周期。

---

### IM 集成 — Coming Soon

GucciAI 将支持将 Agent 桥接到多种 IM 平台。在手机上通过 IM 发送消息即可远程触发桌面端的 Agent 执行任务，随时随地指挥你的个人助理。

> 支持多个主流 IM 平台的 Bot 接入，实现远程消息触发和结果推送。

**状态：Coming Soon** — 该功能正在开发中，将在未来版本中提供。

---

### 持久记忆

GucciAI 的记忆系统以文件形式持久化，让 Agent 跨会话记住你的信息。

#### 记忆文件

| 文件 | 用途 |
|------|------|
| `MEMORY.md` | 持久化事实与偏好，每次会话启动时自动加载 |
| `memory/YYYY-MM-DD.md` | 每日临时笔记 |
| `USER.md` | 用户档案（姓名、职业、习惯） |
| `SOUL.md` | Agent 个性与行为准则 |

#### 记忆写入方式

- **显式指令** — 对话中说「记住 xxx」，Agent 写入 `MEMORY.md`
- **Agent 自动记录** — Agent 可主动将重要发现写入记忆
- **GUI 手动管理** — 在设置面板中添加、编辑、删除条目

---

## 技术细节

### 进程模型

GucciAI 采用 Electron 严格进程隔离，所有跨进程通信通过 IPC。

#### Main Process（`src/main/main.ts`）

- 窗口生命周期管理
- SQLite 数据持久化
- OpenClaw Agent 引擎 + CoworkEngineRouter 调度层
- 40+ IPC 通道处理
- 安全：context isolation 启用，node integration 禁用，sandbox 启用

#### Preload Script（`src/main/preload.ts`）

- 通过 `contextBridge` 暴露 `window.electron` API
- 包含 `cowork` 命名空间用于会话管理

#### Renderer Process（`src/renderer/`）

- React 18 + Redux Toolkit + Tailwind CSS
- 所有 UI 和业务逻辑
- 仅通过 IPC 与主进程通信

---

### 目录结构

```
src/
├── main/                           # Electron 主进程
│   ├── main.ts                     # 入口，IPC 处理
│   ├── preload.ts                  # 安全桥接
│   ├── sqliteStore.ts              # SQLite 存储
│   ├── coworkStore.ts              # 会话/消息 CRUD
│   ├── skillManager.ts             # 技能管理
│   └── libs/
│       ├── agentEngine/
│       │   ├── coworkEngineRouter.ts      # 调度层
│       │   └── openclawRuntimeAdapter.ts  # OpenClaw 适配器
│       ├── openclawEngineManager.ts       # OpenClaw 生命周期
│       └── coworkMemoryExtractor.ts       # 记忆提取
│
├── renderer/                        # React 前端
│   ├── App.tsx                     # 根组件
│   ├── store/slices/               # Redux 状态
│   └── components/
│       ├── cowork/                 # Cowork UI
│       ├── artifacts/              # Artifact 渲染器
│       └── Settings.tsx            # 设置面板
│
SKILLs/                              # 技能定义
├── skills.config.json              # 技能配置
├── web-search/                     # Web 搜索
├── docx/                           # Word 文档
├── xlsx/                           # Excel 表格
├── pptx/                           # PowerPoint
└── ...                             # 更多技能
```

---

### 数据存储

所有数据存储在本地 SQLite（`gucciai.sqlite`）。

| 表 | 用途 |
|----|------|
| `kv` | 应用配置 |
| `cowork_config` | Cowork 设置 |
| `cowork_sessions` | 会话元数据 |
| `cowork_messages` | 消息历史 |
| `user_memories` | 用户记忆条目 |
| `agents` | 自定义 Agent 配置 |
| `mcp_servers` | MCP 服务器配置 |
| `scheduled_task_meta` | 定时任务元数据 |

---

### 安全模型

| 层面 | 保护措施 |
|------|---------|
| 进程隔离 | context isolation 启用，node integration 禁用 |
| 权限门控 | 敏感工具调用需用户审批 |
| 沙箱执行 | 可选 OpenClaw 沙箱隔离 |
| 内容安全 | HTML sandbox、DOMPurify、Mermaid strict mode |
| 工作区边界 | 文件操作限制在指定工作目录 |
| IPC 验证 | 所有跨进程调用类型检查 |

---

### 技术栈

| 层 | 技术 |
|----|------|
| 框架 | Electron 40 |
| 前端 | React 18 + TypeScript |
| 构建 | Vite 5 |
| 样式 | Tailwind CSS 3 |
| 状态 | Redux Toolkit |
| AI 引擎 | OpenClaw |
| 存储 | better-sqlite3 |
| Markdown | react-markdown + remark-gfm + rehype-katex |
| 图表 | Mermaid |
| 安全 | DOMPurify |

---

## 配置

### 应用配置

存储在 SQLite `kv` 表中，通过设置面板修改。

### Cowork 配置

- **工作目录** — Agent 操作的根目录
- **系统提示词** — 自定义 Agent 行为
- **执行模式** — `auto` / `local`

### 国际化

支持中文（默认）和英文，通过设置面板切换。

---

## OpenClaw 集成

GucciAI 将 OpenClaw 依赖锁定到指定版本，在 `package.json` 中声明：

```json
{
  "openclaw": {
    "version": "v2026.3.2",
    "repo": "https://github.com/openclaw/openclaw.git"
  }
}
```

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `OPENCLAW_SRC` | OpenClaw 源码路径 | `../openclaw` |
| `OPENCLAW_FORCE_BUILD` | 强制重新构建 | — |
| `OPENCLAW_SKIP_ENSURE` | 跳过版本切换 | — |

### 更新 OpenClaw 版本

1. 修改 `package.json` 中 `openclaw.version`
2. 执行 `npm run electron:dev:openclaw` 或 `npm run dist:win`
3. 提交变更

---

## 开发规范

- TypeScript 严格模式，函数式组件 + Hooks
- 2 空格缩进，单引号，分号
- 组件 `PascalCase`，函数/变量 `camelCase`
- Tailwind CSS 优先，避免自定义 CSS
- 提交格式：`type: 简短说明`（如 `feat: 添加工具栏`）

---

## 测试

单元测试使用 [Vitest](https://vitest.dev/)，与源文件同目录存放。

```bash
npm test                  # 全部测试
npm test -- logger        # 指定模块
```

测试文件使用 `.test.ts` 扩展名，放在源文件旁边。

---

## 贡献

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/your-feature`)
3. 提交改动 (`git commit -m 'feat: add something'`)
4. 推送到远程 (`git push origin feature/your-feature`)
5. 发起 Pull Request

---

## 许可证

[MIT License](LICENSE)

---

## 致谢

本项目参考 [LobsterAI](https://github.com/netease-youdao/LobsterAI) 开发而成。感谢 LobsterAI 团队在个人助理 Agent 领域的开拓性工作。
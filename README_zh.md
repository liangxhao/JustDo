# JustDo — 全场景个人助理 Agent

<p align="center">
  <img src="public/logo.png" alt="JustDo" width="120">
</p>

<p align="center">
  <strong>7×24 小时帮你干活的个人助理 Agent</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/Version-2026.6.12-green.svg?style=for-the-badge" alt="Version">
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

## 核心特性

| 特性 | 说明 |
|------|------|
| **全场景办公** | 数据分析、PPT 制作、视频生成、文档撰写、Web 搜索、邮件收发，覆盖日常办公全流程 |
| **本地 + 沙箱执行** | 任务执行支持本地直接运行或 OpenClaw 沙箱环境 |
| **内置技能** | Office 文档（Word/Excel/PPT/PDF）、浏览器自动化、数据分析、图表绘制、AI 艺术、技能创建 —— 共 17 个技能 |
| **Windows Python 运行时** | Windows 安装包内置 Python 解释器；依赖按需安装 |
| **定时任务** | 对话式或 GUI 添加定时任务 —— 每日新闻收集、邮箱整理、周期性报告 |
| **持久记忆** | 自动提取偏好与个人信息，跨会话记住你的习惯 |
| **IM 集成** | 通过 IM 平台远程操控（Telegram、Discord）—— 开发中，已有 UI 占位 |
| **子智能体** | 派遣子会话并行或限定域执行任务 —— 通过 `cowork_subagents` 追踪 |
| **权限门控** | 所有敏感工具调用需用户明确批准 |
| **跨平台** | macOS（Intel + Apple Silicon）、Windows、Linux 桌面端 |
| **数据本地化** | SQLite 本地存储，聊天记录、会话、配置不离开你的设备 |

## 架构概览

<p align="center">
  <img src="docs/res/architecture.png" alt="架构概览" width="800">
</p>

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

# 使用 OpenClaw Agent 引擎（首次自动克隆构建）
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
npm run dist:mac        # macOS .dmg
npm run dist:win        # Windows .exe (NSIS)
npm run dist:linux      # Linux .AppImage & .deb
```

桌面端打包内置预构建的 OpenClaw runtime，无需手动配置。

## 核心系统

### Cowork 系统

以 OpenClaw 为引擎的 AI 工作会话系统，自主完成复杂任务。

| 模式 | 说明 |
|------|------|
| `auto` | 自动根据上下文选择执行方式 |
| `local` | 本地直接执行，全速运行 |

所有涉及文件系统、终端、网络的工具调用需在 `CoworkPermissionModal` 中明确批准。

### 技能系统（17 个内置技能）

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

通过自然语言或 GUI 创建定时任务，底层使用 OpenClaw cron 引擎。示例：每日新闻收集、每周报告、邮箱整理。由 `cronJobService.ts` 管理。

### 持久记忆

| 文件 | 用途 |
|------|------|
| `MEMORY.md` | 持久化事实与偏好 |
| `memory/YYYY-MM-DD.md` | 每日临时笔记 |
| `USER.md` | 用户档案 |
| `SOUL.md` | Agent 个性与行为准则 |

## 技术细节

### 进程模型

Electron 严格进程隔离，通过 IPC 通信。

| 进程 | 职责 |
|------|------|
| **Main** (`src/main/`) | 窗口生命周期、SQLite、OpenClaw 引擎、40+ IPC 处理 |
| **Preload** (`src/main/preload.ts`) | `contextBridge` API、`cowork` 命名空间 |
| **Renderer** (`src/renderer/`) | React 18 + Redux + Tailwind，所有 UI 逻辑 |

### 目录结构

```
src/
├── main/           # Electron 主进程（IPC 处理）
│   ├── main.ts     # 入口
│   ├── preload.ts  # contextBridge 安全层
│   └── libs/       # 引擎管理、技能管理、MCP 桥接、Cowork 存储、配置同步
├── renderer/       # React 前端
│   ├── App.tsx     # 根组件
│   ├── components/ # Cowork UI、Settings、定时任务、快捷操作
│   └── store/      # Redux slices（agent、skill、mcp、cowork、scheduledTask、quickAction）
├── scheduledTask/  # Cron 引擎、迁移、策略
└── shared/         # 平台与 Provider 常量
resources/skills/   # 17 个内置技能定义（Gateway 管理）
```

### Cowork 引擎架构

Cowork 会话使用 Gateway 进程生命周期（`idle → downloading → installing → ready → running`）。历史记录通过 `historyReconciler.ts` 协调，子智能体通过 `subagentGateway.ts` 分发。

### 数据存储

本地 SQLite（`JustDo.sqlite`）：应用配置、会话、消息、子智能体、记忆、Agent、MCP 服务器、定时任务。

### 技术栈

| 层 | 技术 |
|----|----|
| 框架 | Electron 41 |
| 前端 | React 18 + TypeScript |
| 构建 | Vite 5 |
| 样式 | Tailwind CSS 3 |
| 状态 | Redux Toolkit |
| AI 引擎 | OpenClaw（运行时下载、自动安装、Gateway 生命周期） |
| 存储 | better-sqlite3 |

### 安全模型

- Context isolation 启用，node integration 禁用
- 敏感工具调用需用户审批
- 可选 OpenClaw 沙箱隔离
- HTML sandbox、DOMPurify、Mermaid strict mode
- 企业级配置同步支持（`enterpriseConfigSync.ts`）

## 配置

### 应用与 Cowork

- **工作目录** — Agent 操作的根目录
- **系统提示词** — 自定义 Agent 行为
- **执行模式** — `auto` / `local`

### OpenClaw 集成

版本锁定在 `package.json`：

```json
{
  "openclaw": {
    "version": "v2026.6.9",
    "repo": "https://github.com/openclaw/openclaw.git"
  }
}
```

更新方法：修改 `package.json` 版本 → 执行构建 → 提交变更。

### 国际化

支持中文（默认）和英文，通过设置面板切换。

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






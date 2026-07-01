# JustDo 设计文档

本目录包含 JustDo 软件的设计文档，按类别组织。

## 目录结构

```
docs/
├── architecture/     # 系统架构与核心模块设计
├── patches/          # OpenClaw Patch 适配文档
├── features/         # 功能实现与重构方案文档
├── res/              # 静态资源
└── README.md         # 本索引文件
```

---

## 文档索引

### 系统架构 (architecture/)

| 文档 | 说明 |
|------|------|
| [01-overview.md](architecture/01-overview.md) | 项目概述与产品定位 |
| [02-architecture.md](architecture/02-architecture.md) | 系统架构设计 |
| [03-process-model.md](architecture/03-process-model.md) | Electron 进程模型与 IPC 通信 |
| [04-cowork-system.md](architecture/04-cowork-system.md) | Cowork 会话系统设计 |
| [05-agent-engine.md](architecture/05-agent-engine.md) | Agent 引擎与 OpenClaw 集成 |
| [07-skills-system.md](architecture/07-skills-system.md) | Skills 技能系统设计 |
| [08-scheduled-tasks.md](architecture/08-scheduled-tasks.md) | 定时任务系统设计 |
| [10-data-storage.md](architecture/10-data-storage.md) | 数据存储与 SQLite 设计 |
| [11-security-model.md](architecture/11-security-model.md) | 安全模型与权限控制 |
| [12-tech-stack.md](architecture/12-tech-stack.md) | 技术栈与依赖说明 |
| [13-pure-frontend-design.md](architecture/13-pure-frontend-design.md) | 纯 OpenClaw 前端架构设计 |
| [14-openclaw-frontend-boundary-plan.md](architecture/14-openclaw-frontend-boundary-plan.md) | OpenClaw 前端边界与去自定义化规划 |
| [15-chat-rendering.md](architecture/15-chat-rendering.md) | 消息渲染系统（Lit 管线） |
| [openclaw-gateway-capability-matrix.md](architecture/openclaw-gateway-capability-matrix.md) | OpenClaw Gateway 能力矩阵 |

### OpenClaw Patch (patches/)

| 文档 | 说明 |
|------|------|
| [openclaw-patch-guide.md](patches/openclaw-patch-guide.md) | OpenClaw Runtime Patch 完整文档：规范、当前 patch 列表、运维指南 |

> **注意**：当前 OpenClaw 版本为 v2026.6.9，共有 6 个 patches。详见 patch guide。

### 功能实现 (features/)

| 文档 | 说明 |
|------|------|
| [openclaw-chat-migration-review.md](../openclaw-chat-migration-review.md) | OpenClaw WebChat 消息渲染管线迁移总结 |
| [thinking-stream-implementation.md](features/thinking-stream-implementation.md) | Thinking 流式显示功能实现详解 |
| [openclaw-thin-frontend-refactor-plan.md](features/openclaw-thin-frontend-refactor-plan.md) | OpenClaw 薄前端重构方案 |

---

## 版本历史

| 版本 | 日期 | 说明 |
|------|------|------|
| v2026.4 | 2026-04 | 项目品牌重塑，文档重构 |
| v2026.4.11 | 2026-04-14 | 添加 Thinking Stream 实现，文档目录整理 |
| v2026.5 | 2026-05 | 薄前端架构规划，Gateway 能力矩阵，OpenClaw 前端边界规划 |
| v2026.6 | 2026-06 | Thin Frontend 全面落地。消息渲染管线重写（Lit `<justdo-chat>`），Subagent 逻辑完全收缩至 Gateway，Runtime 以预构建 npm 包分发 |
| v2026.7 | 2026-07 | 主进程按领域重组（core/data/features/libs/cowork/infra/mcp/openclaw）。移除企业模式、Skill Security Scanner、OpenAI Compat Proxy。精简为 OpenAI 兼容 providers only。 |

---

## 架构演进摘要（v2026.7 重大变更）

v2026.7 是一次深度代码整理：

1. **主进程领域重组** — `src/main/` 按功能拆分为 `core/`、`data/`、`features/`、`ipcHandlers/`；`libs/` 按领域分为 `agentEngine/`、`cowork/`、`infra/`、`mcp/`、`openclaw/` 五个子目录
2. **移除企业模式** — 删除 `enterpriseConfigSync` 及相关 UI、IPC 通道
3. **精简 Provider** — 仅保留 OpenAI 兼容 providers，移除 16 个特定 provider 图标和配置
4. **移除 OpenAI Compat Proxy** — 删除 2900+ 行的 `coworkOpenAICompatProxy.ts`
5. **移除 Skill Security Scanner** — 删除 `skillSecurity/` 目录全部文件（1750 行）

v2026.6 是本项目架构演进的分水岭：

1. **Thin Frontend 全面落地** — JustDo 不再做 OpenClaw Runtime 的二次状态机，所有会话/历史/Subagent 生命周期以 Gateway 为唯一权威
2. **消息渲染系统重写** — 废弃 3800+ 行的 `CoworkSessionDetail.tsx`，采用 OpenClaw webchat 的 Lit 自定义元素 `<justdo-chat>` 直接对接 Gateway WebSocket
3. **Subagent 逻辑收缩** — 移除本地 Subagent 状态追踪，Parent/Child 关系完全由 Gateway 管理
4. **移除自定义 Prompt 注入** — 不再注入自定义 system prompt、AGENTS.md policy、per-agent workspace
5. **Runtime 分发方式变更** — 从本地 clone + build 改为预构建 npm 包直接下载

---

JustDo — All-in-One Personal Assistant Agent

## 致谢

本项目参考 [LobsterAI](https://github.com/netease-youdao/LobsterAI) 开发，感谢原作者的开源贡献。

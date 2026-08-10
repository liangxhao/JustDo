# JustDo 文档索引

本文档目录以当前实现为主，同时保留必要的设计、审查和验收记录。功能文档会明确标注其定位，避免读者把已完成的改造或仍有前置条件的设计误读为当前能力。

## 当前版本事实

| 项 | 当前值 |
| --- | --- |
| JustDo | `v2026.8.10` |
| OpenClaw Gateway | `v2026.6.11` |
| Electron | `42.6.0` |
| Node.js | `>=24 <25` |
| 开发端口 | `43127` |
| Redux slices | 6 |
| 内置 Skills | 7 个声明，7 个默认启用 |
| 当前 Runtime patches | 19 个，位于 `scripts/patches/v2026.6.11/` |

## 架构文档

| 文档 | 内容 |
| --- | --- |
| [01-overview.md](architecture/01-overview.md) | 产品和系统总览 |
| [02-architecture.md](architecture/02-architecture.md) | 分层架构、目录和核心边界 |
| [03-process-model.md](architecture/03-process-model.md) | Electron 进程模型与 IPC API |
| [04-cowork-system.md](architecture/04-cowork-system.md) | Cowork 会话系统 |
| [05-agent-engine.md](architecture/05-agent-engine.md) | OpenClaw 引擎集成 |
| [07-plugin-system.md](architecture/07-plugin-system.md) | Plugin 系统：Extensions、Skills、MCP、Hooks 与 Marketplace |
| [08-scheduled-tasks.md](architecture/08-scheduled-tasks.md) | 定时任务系统 |
| [10-data-storage.md](architecture/10-data-storage.md) | SQLite 和本地数据 |
| [11-security-model.md](architecture/11-security-model.md) | 安全模型 |
| [12-tech-stack.md](architecture/12-tech-stack.md) | 技术栈和构建工具 |
| [13-pure-frontend-design.md](architecture/13-pure-frontend-design.md) | OpenClaw 桌面前端边界 |
| [14-openclaw-frontend-boundary-plan.md](architecture/14-openclaw-frontend-boundary-plan.md) | Gateway/JustDo 职责矩阵 |
| [15-chat-rendering.md](architecture/15-chat-rendering.md) | Lit 聊天渲染管线 |
| [16-skill-marketplace-adapter.md](architecture/16-skill-marketplace-adapter.md) | Skill marketplace adapter |
| [openclaw-gateway-capability-matrix.md](architecture/openclaw-gateway-capability-matrix.md) | Gateway 能力边界矩阵 |

## 功能状态文档

| 文档 | 内容 |
| --- | --- |
| [current-state-v2026.8.10.md](features/current-state-v2026.8.10.md) | v2026.8.10 已落地能力、未完成边界和代码入口 |
| [openclaw-thin-frontend-refactor-plan.md](features/openclaw-thin-frontend-refactor-plan.md) | Thin frontend 当前完成状态 |
| [thinking-stream-implementation.md](features/thinking-stream-implementation.md) | Thinking stream 当前实现 |

### 功能设计与验收记录

以下文档不是统一的待办列表。带有 `plan` 的文件中，部分已标记 `Status: implemented`，其余仍保留设计、审查或前置条件；阅读时应以文件开头的状态和当前状态总览为准。

| 文档 | 当前定位 |
| --- | --- |
| [scheduled-task-in-app-results-implementation-plan.md](features/scheduled-task-in-app-results-implementation-plan.md) | 已实现的结果收件箱设计记录 |
| [openclaw-execution-plan-ui-implementation-plan.md](features/openclaw-execution-plan-ui-implementation-plan.md) | Goal UI 实现记录 |
| [openclaw-permission-management-remediation-plan.md](features/openclaw-permission-management-remediation-plan.md) | 已交付主链路 + 未完成安全验收项 |
| [browser-settings-design.md](features/browser-settings-design.md) | 当前 runtime 不支持 extension 的设计与前置条件 |
| [authentication-builtin-model-lifecycle.md](features/authentication-builtin-model-lifecycle.md) | 待认证 handler 接入的集成契约 |
| [chat-message-flow-review-2026-07-26.md](features/chat-message-flow-review-2026-07-26.md) | 聊天链路审查记录 |
| [chat-message-timeline-refactor-plan.md](features/chat-message-timeline-refactor-plan.md) | 聊天时间线重构设计记录 |
| [outbound-header-proxy-analysis-and-redesign.md](features/outbound-header-proxy-analysis-and-redesign.md) | 代理链路分析与测试计划 |

## Patch 文档

| 文档 | 内容 |
| --- | --- |
| [openclaw-patch-guide.md](patches/openclaw-patch-guide.md) | OpenClaw runtime patch 清单和维护规则 |

## 维护规则

- 更新 `package.json` 中版本、端口、OpenClaw 版本时，同步更新根 README 和本文件。
- 修改 IPC surface 时，同步更新 `03-process-model.md`。
- 修改 SQLite schema 时，同步更新 `10-data-storage.md`。
- 修改 Plugin 能力边界、skill manifest 或安装逻辑时，同步更新 `07-plugin-system.md`。
- 修改 runtime patch 时，同步更新 `patches/openclaw-patch-guide.md`。
- 完成功能实现后，更新当前状态文档或下一版本的当前状态文档，并在功能文档开头明确标记“已实现/设计记录/待接入”。

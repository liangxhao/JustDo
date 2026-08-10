# JustDo 文档索引

本文档目录描述 JustDo 当前实现。历史迁移计划已经收敛为“当前边界/当前状态”说明，避免读者把已完成的改造当成待办事项。

## 当前版本事实

| 项 | 当前值 |
| --- | --- |
| JustDo | `v2026.7.6` |
| OpenClaw Gateway | `v2026.6.11` |
| Electron | `42.6.0` |
| Node.js | `>=24 <25` |
| 开发端口 | `43127` |
| Redux slices | 7 |
| 内置 Skills | 15 个声明，14 个默认启用 |
| 当前 Runtime patches | 13 个，位于 `scripts/patches/v2026.6.11/` |

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
| [openclaw-thin-frontend-refactor-plan.md](features/openclaw-thin-frontend-refactor-plan.md) | Thin frontend 当前完成状态 |
| [thinking-stream-implementation.md](features/thinking-stream-implementation.md) | Thinking stream 当前实现 |

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

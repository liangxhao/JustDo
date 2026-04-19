# GucciAI 设计文档

本目录包含 GucciAI 软件的完整设计文档，按类别组织。

## 目录结构

```
docs/
├── architecture/     # 系统架构与核心模块设计
├── patches/          # OpenClaw Patch 适配文档
├── features/         # 功能实现详解文档
├── superpowers/      # Superpowers 技能规格文档
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
| [09-memory-system.md](architecture/09-memory-system.md) | 持久化记忆系统设计 |
| [10-data-storage.md](architecture/10-data-storage.md) | 数据存储与 SQLite 设计 |
| [11-security-model.md](architecture/11-security-model.md) | 安全模型与权限控制 |
| [12-tech-stack.md](architecture/12-tech-stack.md) | 技术栈与依赖说明 |
| [13-pure-frontend-design.md](architecture/13-pure-frontend-design.md) | 纯 OpenClaw 前端架构设计 |

### OpenClaw Patch (patches/)

| 文档 | 说明 |
|------|------|
| [openclaw-upgrade-analysis-v2026.4.11.md](patches/openclaw-upgrade-analysis-v2026.4.11.md) | OpenClaw v2026.4.11 升级分析 |
| [openclaw-patch-necessity-analysis.md](patches/openclaw-patch-necessity-analysis.md) | Patch 必要性分析 |
| [openclaw-patch-adaptation-v2026.4.11.md](patches/openclaw-patch-adaptation-v2026.4.11.md) | Patch 适配指南 |
| [openclaw-patch-status-v2026.4.11.md](patches/openclaw-patch-status-v2026.4.11.md) | Patch 状态追踪 |

### 功能实现 (features/)

| 文档 | 说明 |
|------|------|
| [thinking-stream-implementation.md](features/thinking-stream-implementation.md) | Thinking 流式显示功能实现详解 |

### Superpowers 规格 (superpowers/specs/)

| 文档 | 说明 |
|------|------|
| [2026-04-13-thinking-stream-display-design.md](superpowers/specs/2026-04-13-thinking-stream-display-design.md) | Thinking Stream Display 功能设计规格 |

---

## 版本历史

| 版本 | 日期 | 说明 |
|------|------|------|
| v2026.4 | 2026-04 | 项目品牌重塑，文档重构 |
| v2026.4.11 | 2026-04-14 | 添加 Thinking Stream 实现，文档目录整理 |

---

GucciAI — All-in-One Personal Assistant Agent

## 致谢

本项目参考 [LobsterAI](https://github.com/netease-youdao/LobsterAI) 开发，感谢原作者的开源贡献。
# JustDo 设计文档

本目录包含 JustDo 软件的设计文档，按类别组织。

## 目录结构

```
docs/
├── architecture/     # 系统架构与核心模块设计
├── patches/          # OpenClaw Patch 适配文档
├── features/         # 功能实现与重构方案文档
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

> **注意**：当前 OpenClaw 版本为 v2026.6.11，共有 6 个 patches。详见 patch guide。

### 功能实现 (features/)

| 文档 | 说明 |
|------|------|
| [thinking-stream-implementation.md](features/thinking-stream-implementation.md) | Thinking 内容当前渲染说明 |
| [openclaw-thin-frontend-refactor-plan.md](features/openclaw-thin-frontend-refactor-plan.md) | OpenClaw 薄前端当前边界说明 |

---

---

## 致谢

本项目参考 [LobsterAI](https://github.com/netease-youdao/LobsterAI) 开发，感谢原作者的开源贡献。

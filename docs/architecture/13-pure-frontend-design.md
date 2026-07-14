# JustDo 纯前端架构设计

> **状态**: JustDo 采用薄前端边界。OpenClaw Gateway 负责会话、历史和 Subagent，JustDo 负责 UI、配置与权限。

## 1. 设计目标

JustDo 作为 **OpenClaw Gateway 的纯前端**，不注入任何自己的上下文内容。所有 AI 推理、上下文管理、历史存储由 OpenClaw Gateway 处理，JustDo 仅负责：

- 用户界面（UI）
- 配置管理（API keys、provider、model）
- OpenClaw Gateway 进程管理
- Skill 构建时部署（从 JustDo resources/skills 复制到 OpenClaw Runtime）

### 设计动机

1. **简化架构**: 避免 JustDo 和 OpenClaw 之间的上下文冲突
2. **统一管理**: 历史、上下文由 OpenClaw Gateway 统一管理
3. **原生兼容**: OpenClaw 原生 channel sessions（Telegram、Discord 等）与桌面 UI 共享同一套上下文
4. **降低维护成本**: 减少 JustDo 的 prompt/policy 管理逻辑

## 2. 架构概述

```
┌─────────────────────────────────────────────────────────────┐
│                     JustDo (纯前端)                          │
│  ┌─────────────────┐  ┌─────────────┐  ┌─────────────────┐ │
│  │   React UI      │  │ Config Sync │  │  Chat Rendering │ │
│  │  + Lit <justdo  │  │ (API/model) │  │  (Lit custom    │ │
│  │   -chat>        │  │             │  │   element)      │ │
│  └─────────────────┘  └─────────────┘  └─────────────────┘ │
│  ┌─────────────────┐  ┌─────────────┐                       │
│  │  SQLite Cache   │  │ Permission  │                       │
│  │  (UI 数据缓存)  │  │ Modal       │                       │
│  └─────────────────┘  └─────────────┘                       │
└──────────────────────────┬──────────────────────────────────┘
                           │ IPC / localhost
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                  OpenClaw Gateway (唯一权威)                  │
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │  AI Engine  │  │  History    │  │   Skills System     │ │
│  │ (inference) │  │ (storage)   │  │  (17 built-in)      │ │
│  └─────────────┘  └─────────────┘  └─────────────────────┘ │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │  Sessions   │  │  Subagents  │  │  Channel Adapters   │ │
│  │ (lifecycle) │  │ (lifecycle) │  │  (Telegram/Discord) │ │
│  └─────────────┘  └─────────────┘  └─────────────────────┘ │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Cron Scheduler (定时任务引擎)                       │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## 3. 保留的配置同步

以下配置仍然同步到 OpenClaw（无 prompt 注入）：

| 配置项            | 说明              |
| ----------------- | ----------------- |
| Provider API keys | 环境变量形式注入  |
| Default model     | 默认模型配置      |
| Workspace path    | 工作目录配置      |
| Sandbox mode      | sandbox 配置      |
| Browser enabled   | browser 工具配置  |
| Plugins entries   | MCP bridge 等插件 |

## 4. Chat 渲染架构

### 5.1 Lit-based `<justdo-chat>` 自定义元素

Chat 渲染已从 React `CoworkSessionDetail.tsx`（3800+ 行）重构为 Lit-based 自定义元素 `<justdo-chat>`：

**目录**: `src/renderer/libs/openclaw-chat/`

```
openclaw-chat/
├── components/
│   ├── justdo-chat.ts       # 主 Lit 元素
│   ├── chat-avatar.ts       # 聊天头像
│   ├── markdown.ts          # Markdown 渲染
│   ├── tool-display.ts      # 工具调用展示
│   └── grouped-render.ts    # 消息分组渲染
├── pipeline/
│   ├── build-chat-items.ts  # 消息构建管道
│   ├── message-extract.ts   # 消息提取
│   ├── message-normalizer.ts# 消息归一化
│   ├── role-normalizer.ts   # 角色归一化
│   ├── stream-text.ts       # 流式文本
│   ├── tool-cards.ts        # 工具卡片
│   ├── tool-helpers.ts      # 工具辅助函数
│   ├── user-message-content.ts
│   ├── text-direction.ts
│   ├── heartbeat-display.ts
│   ├── search-match.ts
│   └── history-limits.ts
├── gateway/
│   ├── chat-controller.ts   # Chat 控制器（Gateway 连接）
│   └── client.ts            # Gateway 客户端
├── conversion/
│   └── cowork-to-gateway.ts # 数据格式转换
├── shims/
│   ├── backend-helpers.ts
│   ├── media-core.ts
│   └── normalization-core.ts
└── types.ts
```

### 5.2 React Wrapper

**文件**: `src/renderer/features/cowork/components/JustDoChatWrapper.tsx`

React 组件将 Lit 元素封装，管理 `ChatController`（直连 Gateway）的创建和生命周期：

- `ChatController` 直接连接 OpenClaw Gateway（与 WebChat 同方式）
- 不再经过 Redux → CoworkMessage → Gateway 的转换链路
- 身份验证、消息发送、流式接收均由 `ChatController` 处理

## 6. 当前历史管理

JustDo 不存储历史，历史完全由 OpenClaw Gateway 管理：

- Session 历史通过 Gateway API (`chat.history`) 实时获取
- UI 显示的历史来自 Gateway，而非本地存储
- Context Bridge 功能已移除（不再写入 JustDo 本地历史到 Gateway）
- SQLite `cowork_messages` 降级为 UI 缓存

## 7. Subagent 管理

Subagent 逻辑完全由 OpenClaw Gateway 负责：

- Gateway 管理 Subagent 生命周期（创建、执行、完成）
- Gateway 管理 Parent/Child session 关系
- Gateway 决定 Parent 何时恢复
- JustDo 不维护 Subagent 完成计数
- JustDo 不通过 toolCallId/sessionKey 猜测 Subagent 状态

## 8. 关键文件清单

| 文件                                                         | 职责                                    |
| ------------------------------------------------------------ | --------------------------------------- |
| `src/main/engine/openclawRuntimeAdapter.ts`                  | Gateway 客户端 + 事件映射（瘦身版）     |
| `src/main/engine/openclawConfigSync.ts`                      | 配置同步（仅同步配置，无注入）          |
| `src/main/engine/rpc/skillRpc.ts`                            | Skill RPC + 标题生成（从 adapter 拆分） |
| `src/renderer/libs/openclaw-chat/components/justdo-chat.ts`  | Lit-based chat 自定义元素               |
| `src/renderer/libs/openclaw-chat/gateway/chat-controller.ts` | Chat 控制器（直连 Gateway）             |
| `src/renderer/features/cowork/components/JustDoChatWrapper.tsx`       | Lit chat 的 React 包装器                |

## 9. 验证方法

### 消息透传验证

在 JustDo 中发送消息，通过 Gateway log 确认：

- 消息内容是纯用户输入
- 不包含 `[JustDo system instructions]` 或时间上下文

### AGENTS.md 验证

检查 OpenClaw workspace 的 AGENTS.md：

- 不包含 JustDo managed section
- 不包含 Web Search/Exec/Memory Policy

### 配置同步验证

检查 `openclaw.json`：

- providers/model 配置正常同步
- 无注入的额外 policy 或 system prompt

### 历史管理验证

- 删除或禁用 SQLite message cache 后，Agent Runtime 行为不受影响
- Gateway `chat.history` 始终是 UI 历史展示的权威来源

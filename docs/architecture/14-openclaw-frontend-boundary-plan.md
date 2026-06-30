# OpenClaw 前端边界与去自定义化实施规划

## 1. 背景

> **当前状态 (v2026.6.25)**: 本规划的目标已全部达成。JustDo 已从厚重编排层收缩为 OpenClaw Gateway 的纯前端。本文档保留作为历史记录和架构边界参考。

JustDo 当前定位是 OpenClaw 的桌面前端：负责 Electron 桌面体验、配置管理、权限交互、本地 UI 数据和 Artifact 预览，不再实现 OpenClaw Runtime 的会话调度、Subagent 状态机或消息历史权威层。

本规划来自一次 Subagent 回收问题排查：

- 用户在一个会话中开启 2 个 Subagent。
- 两个 Subagent 都已完成，OpenClaw child lane 显示 `active=0 queued=0`。
- Parent session 收到两个 Subagent 的 announce/handoff，但两次都表现为"已收到第 1 个祝福语，等待第 2 个"，最终主 Agent 没有继续聚合结果。
- 日志显示问题发生在 OpenClaw Subagent completion announce/handoff 语义附近，但 JustDo 的二次封装层放大了定位和修复成本。

关键判断：

1. 不应简单归因于 OpenClaw 不成熟。
2. 更可能是 JustDo 在 OpenClaw Gateway 外包了一层过厚的状态机，导致前端、缓存、Runtime 事件、Subagent 关系之间出现"双主数据源"。
3. 长期方向应是让 OpenClaw 作为唯一 Runtime 权威，JustDo 回归薄前端。

## 2. 总目标

目标一句话：

> JustDo 只做 OpenClaw 的桌面前端、配置壳、权限壳和本地 UI 数据层，不再做 OpenClaw Runtime 的二次状态机。

当前达成状态：

1. OpenClaw Gateway 是会话、消息历史、Subagent 生命周期、Parent/Child 关系的权威来源 -- **已完成**
2. JustDo SQLite 只保存本地产品数据、UI 元数据、缓存和权限审计 -- **已完成**
3. JustDo 不再通过自然语言 announce 内容、toolCallId 猜测、session key 猜测来判断 Subagent 状态 -- **已完成**
4. `openclawRuntimeAdapter.ts` 从"运行时代理层"瘦身为"Gateway client + event mapper" -- **已完成**
5. runtime patch 数量持续减少，仅保留 Electron/Windows/打包兼容所必需的补丁 -- **持续进行中**

## 3. 架构边界

### 3.1 OpenClaw Gateway 应负责 (已实现)

- Agent 执行调度
- Main/Subagent 生命周期
- Parent/Child session 关系
- Tool call 执行语义
- Session 状态
- Message history 权威存储
- Thinking stream 原始事件
- Completion/result 语义
- `chat.send`
- `chat.abort`
- `chat.history`
- `sessions.list`
- session/event subscribe 能力
- Cron 定时任务调度
- Skills 运行时管理
- Channel 适配 (Telegram/Discord/Webhook)

### 3.2 JustDo 应负责 (已收敛至边界内)

- Electron 主进程和窗口管理
- OpenClaw Gateway 启动、停止、连接状态展示
- Provider、MCP、skills 等配置 UI
- OpenClaw 配置同步（不含 prompt/policy 注入）
- Tool approval 前端交互和本地审计
- SQLite 本地 UI 缓存（非权威数据）
- 会话分组、重命名、置顶、最近访问
- `<justdo-chat>` Lit 自定义元素（聊天渲染）
- 文件打开、通知、托盘、deep link
- Renderer IPC 和 UI 状态

### 3.3 JustDo 不应负责 (已全部移除)

- 自己维护 Subagent 完成数量 -- **已移除**
- 自己判断 Parent 是否该恢复 -- **已移除**
- 自己维护 Parent/Child session 权威关系 -- **已移除**
- 自己重建 OpenClaw transcript 真相 -- **已移除**
- 自己从 toolCallId/session label 猜测 child session -- **已移除**
- 长期 patch OpenClaw Runtime 行为 -- **持续减少中**

## 4. 已完成的架构精简

### 4.1 `openclawRuntimeAdapter.ts` 瘦身

已从大文件抽离出独立模块：

- **`openclawGatewayClient.ts`** -- Gateway HTTP/IPC 调用封装
- **`openclawEventMapper.ts`** -- Gateway event 到 Cowork IPC event 的薄转换
- **`src/main/libs/agentEngine/rpc/skillRpc.ts`** -- Skill RPC + 标题生成 (已提取)
- `openclawRuntimeAdapter.ts` 保留 CoworkEngineRouter 兼容外观

### 4.2 SQLite transcript 降级为 UI Cache

- `cowork_messages` 定位为 cache，不再作为权威历史
- 会话打开时优先读取 OpenClaw `chat.history`
- Runtime 行为不依赖 SQLite transcript

### 4.3 Subagent 状态收敛

- `cowork_subagents` 降级为 UI cache
- Subagent 状态展示来自 OpenClaw Gateway 事件
- 不再维护 `subagentStatus`、`toolCallIdToSessionKey` 等本地状态映射

### 4.4 Chat 渲染重构

- `CoworkSessionDetail.tsx` (3800+ 行) 替换为 Lit-based `<justdo-chat>` 自定义元素
- `ChatController` 直连 Gateway，不再经过 Redux 转换链路
- 架构与 OpenClaw WebChat 保持一致

### 4.5 所有注入点移除

- `buildOutboundPrompt` 简化为纯透传
- `syncAgentsMd` 只移除 managed section，不写入内容
- `syncPerAgentWorkspaces` 空实现
- 无 `AGENTS.md` policy 注入
- 无自定义 system prompt 注入
- 无 per-agent workspace 注入

## 5. Runtime Patches 现状

当前保留的 patches (`scripts/patches/v2026.6.9/`):

| Patch | 用途 | 分类 |
|-------|------|------|
| `001-thinking-stream.cjs` | Thinking 流式输出 | 临时修复 |
| `002-session-write-lock-self-timeout.cjs` | 会话写锁超时 | Electron 兼容 |
| `003-agent-announce-reasoning-stream.cjs` | Agent announce 推理流 | 临时修复 |
| `004-openai-content-reasoning-tags.cjs` | OpenAI reasoning 标签 | 临时修复 |

所有 patch 已在 `scripts/patches/README.md` 中记录用途、风险、删除条件。

## 6. 能力边界矩阵

| 能力 | OpenClaw Gateway | JustDo | 备注 |
|------|-----------------|--------|------|
| 会话生命周期 | 权威 | 展示 | `chat.send`, `chat.abort` |
| 消息历史 | 权威 | 缓存 | `chat.history` |
| Subagent 生命周期 | 权威 | 无状态 | Parent/Child 关系 |
| Tool 执行 | 权威 | 权限 UI | `tool.approval` |
| Skills 管理 | 权威 | 管理 UI | `skills.*` RPC |
| 定时任务 | 权威 | CRUD UI | `cron.*` RPC |
| 配置存储 | 用户数据 | 同步至 Gateway | API Keys, model |
| UI 数据 | -- | SQLite cache | 会话列表、搜索等 |

## 7. 非目标

本规划不要求：

- 替换 OpenClaw
- 删除 SQLite
- 删除权限系统
- 删除 skills 系统
- 立即删除所有 runtime patches

本规划要求已全部达成：

- \[x] 明确 OpenClaw 是 Runtime 权威
- \[x] 明确 JustDo 是前端和产品壳
- \[x] 所有二次 Runtime 状态都有删除路线
- \[x] 注入点全部移除
- \[x] Chat 渲染直连 Gateway
- \[x] subagent 状态收敛

## 8. 最终验收标准 (全部达成)

1. 普通会话、Subagent、history、abort、permission 都正常工作 -- **已验证**
2. 多 Subagent 并发完成后 Parent 能稳定恢复 -- **已验证**
3. JustDo 不再维护 Subagent 完成计数 -- **已验证**
4. JustDo 不再通过猜测 toolCallId/session label 绑定 child history -- **已验证**
5. SQLite transcript 损坏不会影响 OpenClaw Runtime 行为 -- **已验证**
6. runtime patch 有清晰数量、用途和删除条件 -- **已完成**
7. `openclawRuntimeAdapter.ts` 职责清晰，新增 OpenClaw API 不再继续堆入同一个大文件 -- **已完成**

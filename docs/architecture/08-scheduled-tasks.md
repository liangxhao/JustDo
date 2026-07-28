# 定时任务系统

JustDo 的定时任务 UI 在 renderer 中实现，Main 进程通过 OpenClaw cron runtime 执行任务。JustDo 保存任务展示和运行关联所需的本地状态，Gateway 负责实际执行。

## 关键文件

| 文件 | 作用 |
| --- | --- |
| `src/renderer/features/scheduled-tasks/` | 定时任务 UI、service、Redux slice |
| `src/shared/scheduledTask/` | IPC constants、types、reminder text |
| `src/main/ipc/scheduledTask/` | 定时任务 IPC handlers 和 service manager |
| `src/main/scheduler/cronJobService.ts` | OpenClaw cron adapter/polling |
| `src/main/scheduler/scheduledTaskResultSyncService.ts` | Durable result reconciliation |
| `src/main/data/scheduledTaskResultStore.ts` | Result pagination and read receipts |
| `src/main/scheduler/enginePrompt.ts` | 执行 prompt 构造 |

## Preload API

`window.electron.scheduledTasks` 暴露：

- `list()`
- `get(id)`
- `create(input)`
- `update(id, input)`
- `delete(id)`
- `toggle(id, enabled)`
- `runManually(id)`
- `listRuns(taskId, limit?, offset?)`
- `resolveSession(sessionKey)`
- `listChannels()`
- `onStatusUpdate(callback)`
- `onRunUpdate(callback)`
- `onRefresh(callback)`
- `listResults(query?)`
- `markResultRead(runId)`
- `markAllResultsRead(taskId?)`
- `deleteResult(runId)`
- `reconcileResults()`
- `onResultUpserted(callback)`
- `onUnreadCountChanged(callback)`

IPC channel 常量位于 `src/shared/scheduledTask/constants.ts`。

## 执行流程

```mermaid
sequenceDiagram
  actor User
  participant UI as CronView
  participant IPC as scheduledTask IPC
  participant Service as CronJobService
  participant GW as OpenClaw Gateway Cron

  User->>UI: create/update/toggle task
  UI->>IPC: scheduledTasks.* invoke
  IPC->>Service: validate and map model
  Service->>GW: cron RPC/config
  GW-->>Service: task state
  Service-->>IPC: result
  IPC-->>UI: update Redux
  loop polling
    Service->>GW: query task/run status
    GW-->>Service: status changes
    Service->>Service: reconcile durable result snapshots
    Service-->>UI: StatusUpdate/ResultUpserted/UnreadCountChanged
  end
```

手动执行同样通过 `CronJobService` 委派给 Gateway，并用 session key 关联到可查看的 Cowork/Gateway 会话。

## UI 组件

| 组件 | 作用 |
| --- | --- |
| `CronView.tsx` | 主视图 |
| `RunSessionModal.tsx` | 查看任务运行关联会话 |
| `TaskRunHistory.tsx` | 运行历史 |
| `utils.ts` | UI 辅助函数 |

## 数据边界

| 数据 | 权威来源 | JustDo 角色 |
| --- | --- | --- |
| Cron 执行 | OpenClaw Gateway | 发起、展示、轮询 |
| 任务列表 | Gateway cron runtime + 本地 UI state | 管理 UI |
| Run session | Gateway session key | 解析和打开会话 |
| Result inbox | SQLite snapshot + Gateway run facts | 持久化摘要、状态和已读回执 |
| Reminder text | `src/shared/scheduledTask/reminderText.ts` | UI/Prompt 共享文本 |

## 维护规则

- 新增任务状态或 IPC channel 时，先更新 `src/shared/scheduledTask/constants.ts` 和 `types.ts`。
- Renderer 不直接轮询 Gateway；通过 Main IPC 和 service manager。
- 与自然语言 reminder 相关的用户可见文本需要 i18n 或共享纯函数覆盖测试。
- 修改 schedule parsing、run mapping、manual run 行为时补充 Vitest。

## 类型模型

定时任务契约位于 `src/shared/scheduledTask/`，目的是让 Main 和 Renderer 使用同一套领域语言。

核心概念：

| 概念 | 说明 |
| --- | --- |
| Schedule | 任务触发时间，可以是一次性、固定间隔或 cron |
| Payload | 执行内容，通常是一次 agent turn 或 system event |
| Delivery | 运行结果是否投递到外部 channel |
| Session target | 在已有会话执行，还是创建隔离会话 |
| Wake mode | 立即唤醒或等待下一次 runtime heartbeat |
| Run history | 每次执行的状态、错误、耗时、关联 session |

JustDo 只为主 Agent 配置 30 分钟 heartbeat，使 `main + systemEvent` 任务可以在
`wakeMode: "now"` 时立即唤醒主会话；自定义 Agent 不继承该周期。主 Agent 同时保留
OpenClaw 的常规 heartbeat 检查；`includeSystemPromptSection` 保持关闭，避免向普通
会话注入 heartbeat 说明。

共享 constants 中的 discriminant 必须使用 `as const` 对象，避免 renderer/main 写出不同字符串。

## Renderer 设计

```text
src/renderer/features/scheduled-tasks/
  scheduledTaskSlice.ts       Redux state
  scheduledTaskService.ts     preload API wrapper
  components/
    CronView.tsx              主页面、表单、列表
    TaskRunHistory.tsx        运行历史
    RunSessionModal.tsx       运行关联会话
    utils.ts                  展示辅助
```

Renderer 只负责：

- 表单输入和校验。
- 调用 CRUD API。
- 展示 next run、last run、last error。
- 订阅状态事件并刷新。
- 打开 run 对应的会话。
- 展示 SQLite 权威的未读数和分页结果列表。
- 按本地日期将结果组织为时间轴，并允许用户删除单条结果。

Renderer 不负责解析 Gateway cron 内部状态，也不直接访问 Gateway。

## Main 设计

```text
src/main/ipc/scheduledTask/
  index.ts
  handlers.ts
  helpers.ts
  cronJobServiceManager.ts

src/main/scheduler/
  cronJobService.ts
  scheduledTaskResultSyncService.ts
  enginePrompt.ts
```

`cronJobServiceManager` 负责在 Gateway adapter 可用后提供 `CronJobService`。这样应用启动早期即使 Gateway 未 ready，IPC handler 也可以返回清晰的“runtime not ready”状态。

`enginePrompt.ts` 负责把用户任务描述构造成 Gateway 执行 prompt。此处的变更会影响任务实际行为，应有测试覆盖。

JustDo 的内置 Gateway 会在原生 `cron` 工具边界为省略 `delivery` 的
`agentTurn` 任务补上 `{ mode: "none" }`。这适用于该 Gateway 服务的所有
Agent 会话；显式传入的 `announce` 和 `webhook` 保持不变。这样“仅在应用内”
是可靠的产品默认值，而不只依赖模型遵循 prompt。

```mermaid
flowchart TB
  subgraph Renderer["Renderer"]
    View["CronView"]
    History["TaskRunHistory"]
    Modal["RunSessionModal"]
    Slice["scheduledTaskSlice"]
  end

  subgraph Main["Main Process"]
    Handlers["scheduledTask handlers"]
    Manager["cronJobServiceManager"]
    Service["CronJobService"]
    Prompt["enginePrompt"]
  end

  subgraph Gateway["OpenClaw Gateway"]
    Cron["Cron scheduler"]
    Agent["Agent executor"]
    Delivery["Delivery channels"]
  end

  View --> Slice
  View --> Handlers
  History --> Handlers
  Modal --> Handlers
  Handlers --> Manager
  Manager --> Service
  Service --> Prompt
  Service --> Cron
  Cron --> Agent
  Agent --> Delivery
```

## Polling 与事件

当前 Main 进程通过 polling 把 Gateway cron 状态变化推给 renderer：

```text
CronJobService.startPolling()
  -> periodically query Gateway cron.list
  -> compare task state with local result cursors
  -> reconcile bounded cron.runs pages into SQLite
  -> BrowserWindow.webContents.send(StatusUpdate/ResultUpserted/UnreadCountChanged)
```

首次启用结果收件箱时，Main 最多导入 200 条全局历史并在同一事务中标记为已读；
之后启动/重连使用全局增量同步，普通轮询只对 `lastRunAtMs` 推进的任务读取历史。
每任务单次 reconciliation 最多导入 100 条。Renderer 不增加 timer。

删除单条结果时，Main 会先暂停该 run 的 reconciliation 投影。对于 OpenClaw
为该 cron run 独立创建的 session，Main 会递归调用 `sessions.delete` 清理
关联 session/子 session，并删除 Gateway 生成的 transcript 归档；共享 main
session 不会随单条结果一起删除。随后 Main 从
OpenClaw state SQLite 精确删除对应的 `cron_run_logs` 行，最后物理删除 JustDo
SQLite 中的结果并更新全局未读数。任何 OpenClaw 清理错误都会保留 JustDo
结果，避免界面显示“已删除”但原始数据仍存在。当前固定 OpenClaw 版本没有公开
单条 cron run 删除 RPC，因此 state SQLite 删除逻辑必须按 `job_id` 和
`run_id`（旧记录使用 `run_at_ms/ts`）精确匹配，并有版本升级回归测试。

Gateway 可能把应用内任务残留的“缺少 channel”投递错误计入退避。
`CronJobService` 只对已经明确为 `delivery.mode = none`（或完全缺少 delivery）
的任务重新提交 schedule，让 Gateway 按正常周期重算 `nextRunAtMs`。任何
`announce` 或 `webhook` 都视为外部投递意图，不会被静默改写；编辑界面也要求
`announce` 必须选择通道。

## Manual Run

手动执行不是简单地修改 next run time，而是用户主动触发一次 run：

```mermaid
sequenceDiagram
  participant UI as CronView
  participant Main as CronJobService
  participant GW as Gateway Cron
  participant Modal as RunSessionModal

  UI->>Main: runManually(taskId)
  Main->>Main: verify task
  Main->>GW: manual run
  GW-->>Main: runId/sessionKey
  Main-->>UI: RunUpdate
  UI->>Modal: open session details
  Modal->>Main: resolveSession(sessionKey)
```

手动执行应保留正常调度计划，不应破坏下一次 cron 触发时间。

## Session Resolution

`resolveSession(sessionKey)` 用于把 Gateway run 结果关联到 JustDo 可展示会话。可能情况：

- session 已在本地 `cowork_sessions` 中存在。
- session 只有 Gateway history，需要创建/补全本地 UI cache。
- session 已被 Gateway 清理，UI 展示不可打开状态。

## 失败处理

| 场景 | 处理 |
| --- | --- |
| Gateway 未运行 | 返回 engine not ready，不创建假任务 |
| Cron 表达式无效 | Main 返回 validation failure，Renderer 标记字段错误 |
| 手动运行失败 | 记录 run error，保留任务定义 |
| run session 无法解析 | 历史仍显示，但打开按钮禁用或提示不可用 |
| polling 失败 | 写日志，下一轮重试，UI 保留上次状态 |
| renderer reload | Main 继续持久化，renderer 通过 `listResults` 重建列表 |

## 测试建议

- schedule discriminant mapping。
- reminder text 生成。
- engine prompt 构造。
- handlers 对 invalid input 的返回。
- run history pagination。
- manual run 不改变正常 schedule。

# 定时任务系统

本文按当前 `src/main/scheduler/`、`src/main/ipc/scheduledTask/`、`src/shared/scheduledTask/`、SQLite result store 与 Renderer 页面重写。系统使用 OpenClaw 原生 cron；JustDo 不是第二个调度器。

## 1. 双层模型

| 数据                               | 权威                                | 说明                                  |
| ---------------------------------- | ----------------------------------- | ------------------------------------- |
| Job 定义、enabled、next/last state | Gateway `cron.*`                    | JustDo 每次 list/get 映射 wire object |
| Run history 与执行 session         | Gateway `cron.runs`/session         | 可分页、可追溯完整 transcript         |
| 应用内结果、未读、读取时间         | SQLite receipt                      | Gateway run 的本地投影                |
| 结果同步 cursor/watermark          | SQLite KV                           | 保证跨重启 catch-up                   |
| 删除过的本地结果                   | 同步 suppression + artifact cleanup | 防 reconcile 立刻复活                 |

“in-app”是阅读位置，不是 OpenClaw delivery channel。delivery mode 仍只有 `none`、`announce`、`webhook`。

## 2. 领域类型

### 2.1 Schedule

- `at`: ISO 时间字符串；一次性执行。
- `every`: `everyMs` 和可选 `anchorMs`。
- `cron`: 表达式、可选 timezone 和 `staggerMs`。
- `on-exit`: Gateway 监管的进程退出时触发，可带 cwd。
- `stream`: Gateway 监管的长驻命令产生事件批次时触发。

创建/编辑表单只生成 `at/every/cron`。`on-exit/stream` 可以由 OpenClaw CLI、Agent 或其他原生客户端创建，JustDo 会正确展示，但不把它们塞进旧表单做有损编辑。

### 2.2 Payload

- `agentTurn`: message，可选 timeout/model；使用隔离 scheduler agent。
- `systemEvent`: text；通常目标 main session。
- `command`、`script`: v2026.8.2 原生无人值守 payload；JustDo 只读展示，并在手动运行前以精确 argv/脚本文本二次确认。确认请求携带所展示配置的 revision，由 Main 在运行前重新读取并拒绝已变化的任务；这是运行前复核，不是 Gateway 原子 CAS。
- `heartbeat`、`skillCollectionReview`: Gateway 收敛的系统 payload；在 JustDo 中标记为 OpenClaw 管理。

### 2.3 Delivery 与目标

Delivery 包含 mode、channel、to、accountId、bestEffort。创建表单使用 `main/isolated`；列表还能安全读取 v2026.8.2 的 `current` 与 `session:*` target。wake mode 是 `now` 或 `next-heartbeat`。channel option 可标 disabled，并用 accountId 区分多实例 bot。

Job 映射额外给 Renderer 一个 management 分类：`editable` 是表单可无损 round-trip 的普通任务，`advanced` 可启停/试运行/删除但不进入旧表单，`managed` 是 declaration key 或系统 payload 收敛的任务，只读展示并保留运行历史。owner/account tool policy、pacing、trigger、failure alert、非默认 delete-after-run 和高级 delivery 字段都会把任务归为 advanced，防止基础编辑器覆盖隐藏权限或执行语义。

### 2.4 状态

产品状态：success/error/skipped/running；Gateway wire 的 `ok` 映射为 success。TaskState 包含 next/last/running timestamp、last error/duration 和 consecutive errors。Run 另外保存 session id/key、summary、delivery status/error。

## 3. 组件

| 组件                             | 职责                                                                    |
| -------------------------------- | ----------------------------------------------------------------------- |
| `CronJobService`                 | `cron.get/list/add/update/remove/run/runs` 映射、事件投影与低频兜底轮询 |
| `ScheduledTaskResultStore`       | receipt、未读、cursor 分页、baseline/catch-up metadata                  |
| `ScheduledTaskResultSyncService` | baseline、增量/强制 reconcile、durable catch-up、事件                   |
| `OpenClawCronRunCleanupService`  | 删除 result 对应的 session tree、transcript/archive/run log             |
| `cronJobServiceManager`          | 延迟组合 adapter、DB、services 和窗口广播                               |
| IPC handlers                     | 输入 normalize、job/result API、session history resolve                 |
| Renderer slice/UI                | CronView、history、ResultInbox、RunSessionModal                         |

## 4. Job CRUD

`CronJobService` 先 ensure Gateway ready，再调用 RPC。list 使用 `limit=200` 和 offset 遍历全部 job，显式设置 `includeDeliveryPreviews=false`，避免列表/轮询触发逐任务的 delivery target I/O；分页同时校验 `nextOffset` 单调增加和 `snapshotRevision` 一致。get/update/toggle/run 使用 v2026.8.2 原生 `cron.get` 精确读取，不再用模糊 query 扫描。

Create 映射 schedule/payload/delivery；Agent-turn 强制 `agentId = justdo-scheduler`。Update 根据 payload kind 原子调整：

- 转为 agentTurn 时默认 isolated、分配 scheduler agent；
- 转为 systemEvent 时清除 scheduler agent 和不再适用的 session key；
- delivery 显式设 none 时发 `{mode:'none'}`，不是遗漏字段；
- mutation 按 task id 串行，避免 toggle/update/run 互相覆盖。
- update/toggle 将最新 job 的 `configRevision` 作为 `expectedConfigRevision` 发回 Gateway；定义已被 Agent/其他客户端改写时拒绝覆盖，并由 Renderer 重载权威列表。
- declaration key 与 Gateway 系统 payload 任务在 Main 和 Renderer 两层都拒绝修改，避免下一轮 OpenClaw 收敛把 UI 操作覆盖。

新建 job 即使调用方省略 delivery，也必须显式发送 `delivery: {mode:'none'}`。这样应用内结果不会因 OpenClaw 默认 delivery 改变而意外 announce；只有用户明确选择外发模式时才发送 channel/webhook 字段。

## 5. Scheduler agent 隔离

`justdo-scheduler` 是受管 agent，JustDo 新建或把 system event 显式转换成 agent-turn 的 job 由它执行。由 Agent、OpenClaw core/extension 或其他客户端创建的任务保留原 owner；后台 list/poll、普通 update、toggle 和 manual run 均不得接管或改写其 `agentId`。这样 UI 中一次重命名、启停或试运行不会把 account-policy 任务静默提升到 scheduler 的 full/unattended policy。

模型可见的 `automations` 工具不经过 JustDo IPC，因此受保护的 `automation-permission` extension 在 OpenClaw `before_tool_call` 层读取当前原生 session permission mode：Full 放行，Ask/Auto 要求 one-shot approval，read-only 拒绝。只有同时具备 scheduler agent id 与原生 cron-run session key 的无人值守执行可以豁免；普通交互会话不能冒用该 agent id。每次 Gateway 连接都通过 status RPC 验证 policy 已加载，缺失时禁止普通 turn。

## 6. v2026.8.2 Delivery 语义

应用内结果不需要外部 channel，新建 job 仍显式发送 `delivery.mode=none`。v2026.8.2 已把执行 `status/error` 与 `deliveryStatus/deliveryError` 分开，JustDo 直接映射 Gateway 事实，不再用 v2026.6.11 的字符串启发式把 error 改写成 success，也不再在 list 读取路径中偷偷 update job 清 backoff。旧本地 receipt 的展示兼容可以保留，但不能反向改写新 Gateway 定义。

## 7. Polling 与事件

Gateway 启动成功后开始 polling，退出清理先停止 polling。v2026.8.2 的 `cron` event 携带 action、job snapshot 和终态字段；`started` 没有稳定 runId，因此只投影 job `StatusUpdate`，`finished` 才按 runId 投影 `RunUpdate` 并定向同步该 job 的 receipt（不得把单 job 当成权威全量集合）。结构增删改触发 Renderer 权威刷新，`scheduled` 不做全量请求，避免高频 stream 任务形成请求风暴。低频轮询仍负责断线/漏事件兜底；仅已初始化的运行历史缓存接收 live/result upsert，从而在漏掉 finished event 时最终收敛且不会无限积累未查看任务的历史。

`cron.run` 是 enqueue RPC，不代表任务已开始或完成。Main 显式发送 `mode=force`，要求响应包含 `enqueued=true` 与非空 `runId`；UI 只提示“已加入队列”，不伪造 running 历史。未入队、already-running 或缺少 runId 都作为失败返回，最终状态由 Gateway event / `cron.runs` 事实产生。

轮询失败记录 module-prefixed error并等待下轮；不能用空成功列表覆盖 UI，因为启动时事件可能早于 Renderer 订阅。`isCoworkBusy` 可用于降低后台竞争，但不是永远暂停调度的理由。

## 8. Result baseline

首次启用本地结果收件箱时不能把全部历史突然标未读：

1. 记录 `baselineAt`。
2. 全局取最近 200 个 run，每 task 最多 20 个。
3. 作为已知 baseline 写入 receipt/watermark，不产生 new-unread event。
4. 后续只把 baseline 后完成的新 run 作为 unread。

任务不在有限 baseline 窗口时，使用该任务 Gateway `lastRunAtMs` watermark 或 baseline timestamp，防止漏掉下一次运行。

## 9. 增量 reconcile 与 durable catch-up

普通轮询仅处理 lastRun 超过本地 completed-through 的任务。启动/手工刷新先 upsert 有界全局窗口，再按 task 分页向旧方向 catch-up：

- 页面 50；每轮最多收集 100；
- 以 boundary run id、startedAt、stopAt、ignoreKnown、resumeOffset 表达 continuation；
- continuation 持久化，应用重启后继续；
- run 按时间正序 upsert，因此事件和未读语义稳定；
- id 去重，校验 task/run id 和时间；坏数据跳过并记录脱敏警告；
- 已存在 receipt 可更新 summary/status/delivery，但保留已读状态。

同一时刻只允许一个 sync。force reconcile 在当前 sync 后排队；删除期间 reconcile 等待，避免竞态复活。

## 10. Result Store

`scheduled_task_run_receipts` 以 run id 为主键，保存任务名快照、session、状态、summary/error、delivery、时间、observed/read/updated。列表按 `(started_at DESC, run_id DESC)` keyset cursor 分页，limit 在 IPC 限为 1..100。unread 查询排除 running，mark read 使用 `COALESCE` 保留第一次阅读时间。

`scheduled_task_result_cleanup` 记录清理过程中归档路径/进度，支持失败重试。Baseline/watermark/catch-up metadata 位于 KV 的受管 key，不是 Gateway job 定义。

## 11. 删除结果

删除不是简单 `DELETE receipt`：

1. 校验 run id，读取 receipt；running 结果拒绝删除。
2. 对该 run 加 suppression，等待在途 sync。
3. Cleanup service 验证 session key属于 cron run，枚举最多 1000 个 session tree。
4. 通过 Gateway 删除 child -> root session/transcript，清 session approval grants。
5. 清 OpenClaw run log/受管 archive artifacts；路径必须在 state dir。
6. 全部成功后才物理删除 receipt；失败保留 receipt 以便重试。
7. 更新 unread count，解除 suppression。

删除 job 不自动等同删除所有已同步结果；两者生命周期独立。

## 12. Session resolve

结果详情先显示 receipt summary；用户打开完整运行时，用 `sessionKey` 调 adapter `fetchSessionHistoryByKey`，沿用 canonical chat projection。它依次尝试 `chat.history`、`sessions.resolve` 和 `sessions.get` fallback。

重试耗尽的诊断只记录 run id 规范化值、status、session kind、session key SHA-256 前 12 位 fingerprint 和是否有 sessionId，不记录完整 key 或消息内容。

## 13. Renderer

`scheduledTaskSlice` 保存 tasks、runs、Gateway nextOffset、result pages/unread 等共享状态。`CronView` 管理 create/edit/toggle/manual run，并给 advanced/managed job 明确徽标和受限动作；高级与系统任务提供只读详情，展示 schedule/payload/session/delivery 及不会进入基础编辑器的原生能力。command/script 手动运行前必须二次确认。`TaskRunHistory` 展示加载/失败反馈并防止同一 cursor 重复请求；`ResultInbox` 提供未读筛选、分页、标记和删除；`RunSessionModal` 复用 chat pipeline 展示完整历史。

编辑普通任务时必须保留表单未暴露但 Gateway 已有的 agent-turn model/timeout/fallback/toolsAllow 等字段、cron timezone/stagger 和 announce target/account/bestEffort，不能因为只改名称或提示词而清空原生配置。

事件订阅后仍需主动首次 list/results，不能依赖可能已错过的 startup refresh。optimistic toggle/run 应以 handler 返回或下次权威 list 回正。

## 14. IPC

Job：List/Get/Create/Update/Delete/Toggle/RunManually/ListRuns/ResolveSession/ListChannels。RunManually 返回 enqueue receipt，ListRuns 透传 Gateway 的 `hasMore/nextOffset`，不能再用“页长等于 limit”猜测下一页。事件：StatusUpdate/RunUpdate/Refresh。Result：ListResults/MarkResultRead/MarkAllResultsRead/DeleteResult/ReconcileResults，以及 ResultUpserted/UnreadCountChanged。

结果收件箱 IPC 对 run id/taskId 做规范化并校验 limit/cursor；原生 cron job id 保持精确值交给 Gateway 校验，run-history 分页边界由 Gateway schema 限制。失败对 Renderer 返回稳定通用信息，详细内部错误只进日志且不能含 prompt/credential。

## 15. 失败处理

| 故障                        | 行为                                                |
| --------------------------- | --------------------------------------------------- |
| Gateway 未 ready            | handler 等待 ensureReady 或返回失败，不返回空成功   |
| list pagination cursor 异常 | 终止并报错，防无限循环                              |
| reconcile 某批失败          | 恢复批前 continuation，下次从同边界重试             |
| artifact cleanup 失败       | 保留 receipt，不产生“已删除”假象                    |
| session history 暂不可用    | receipt仍可读；UI重试并做 fingerprint 诊断          |
| job 定义并发变化            | `expectedConfigRevision` 冲突，拒绝覆盖并刷新列表   |
| managed/advanced job        | managed 全只读；advanced 禁止表单编辑、保留安全动作 |
| manual run 未入队           | IPC 返回失败，不显示“触发成功”                      |

## 16. 测试与维护

修改 scheduled tasks 必须同步 shared、Main scheduler/IPC、Renderer 和数据文档。测试至少覆盖三类 schedule、payload 转换、assignment、pagination、manual run、polling、baseline、跨多页 catch-up、重启恢复、重复 upsert、read preservation、删除竞态/失败、session tree 安全和 UI 初始查询/事件。Gateway API 变更还需更新 capability matrix 与相关 runtime patch 测试。

## 17. Job 与 Result 是两套生命周期

```mermaid
flowchart LR
  Job[Gateway cron job]
  Run[Gateway cron run]
  Session[Gateway session artifact]
  Sync[Result sync service]
  Receipt[(SQLite receipt)]
  Inbox[Renderer inbox]

  Job --> Run --> Session
  Run --> Sync --> Receipt --> Inbox
  Inbox -.open full result.-> Session
```

禁用/删除 job 不等于删除已经产生的 result；删除 receipt 也不改写 job。Result summary 可以在 Gateway artifact 清理前存在，但用户请求删除时必须先完成或记录 artifact cleanup，避免 UI 消失而敏感内容仍遗留。

## 18. Polling 并发与游标

- 同一轮 reconcile 使用稳定分页边界，cursor 无进展或重复必须终止，防止无限循环。
- 批量 upsert 保留已有 `readAt`，重复观察同一 run 不应重新变未读。
- 失败时保存批次前 continuation；不能越过失败页提交更后的 cursor。
- startup baseline 区分“安装前历史”和“离线期间新结果”，durable catch-up 状态跨重启保存。
- poll、手工 refresh 和 Gateway event 可能并发，service 需串行/去重而不是并行覆盖 unread count。

## 19. Unattended 安全不变量

JustDo 创建的 `agentTurn` 任务必须绑定 `justdo-scheduler` 隔离 agent，并使用受管无人值守 policy；外部或 Agent 创建的任务必须保留原 owner/policy。交互会话中的 automation mutation 由原生 session mode 门禁，不能通过改写 scheduler assignment 绕过审批。Webhook/channel delivery 中的 credential 由 Gateway/受管配置处理，receipt/log 只保留脱敏错误。

## 20. 代码与测试地图

| 行为                     | 入口                                                  |
| ------------------------ | ----------------------------------------------------- |
| Cron API mapping         | `src/main/scheduler/cronJobService.ts` 及测试         |
| Service composition      | `src/main/ipc/scheduledTask/cronJobServiceManager.ts` |
| IPC validation           | `src/main/ipc/scheduledTask/handlers.ts` 及测试       |
| Result reconcile         | `scheduledTaskResultSyncService.ts` 及同名测试        |
| Receipt/cleanup schema   | `src/main/data/scheduledTaskResultStore.ts` 及测试    |
| Shared schedule/delivery | `src/shared/scheduledTask/` 及测试                    |
| Renderer state/views     | `features/scheduled-tasks/`、`scheduledTaskSlice.ts`  |

## 21. 变更完成条件

表单支持的新 cron 字段必须从 shared type 到 Gateway mapping、create/update/read-back、UI edit 和测试全链路对称；只读取的新版本字段必须显式进入 advanced/managed 展示，不能强塞进不支持的编辑器。新增 run status 要更新 result normalize、排序/终态、delivery error 和展示。任何 polling 优化必须验证跨多页、重启、重复事件和 read preservation，不能只测空列表与单页。

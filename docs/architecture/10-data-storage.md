# 数据存储

本文按 `v2026.8.12` 的 `SqliteStore`、`CoworkStore`、`GroupStore`、`ScheduledTaskResultStore` 和相关测试重写。JustDo 的核心产品数据使用 SQLite；OpenClaw 自己的 transcript、runtime 和 cron 数据仍位于其 state directory，不归入本 schema。

## 1. 数据库位置与初始化

数据库文件名是稳定内部标识 `justdo.sqlite`，位于 Electron `app.getPath('userData')`，即 `<appData>/<package.json.productName>/justdo.sqlite`。产品名变化会得到不同 userData 目录，旧品牌数据不自动迁移。

`SqliteStore.create()` 的顺序：

1. 解析 userData 和 database path。
2. 检测已知 legacy schema；只在明确缺少必需列时删除 database、`-wal`、`-shm` 并新建。
3. 打开 `better-sqlite3` 连接。
4. 设置 foreign keys、WAL、sync/cache/checkpoint。
5. 创建表/索引并执行兼容迁移。
6. 清理孤立 message，执行 `PRAGMA optimize`。
7. 若 KV 仍为空，从旧 `config.json` 一次性导入 electron-store 数据。

数据库只在 `app.whenReady()` 后初始化；退出时在 Gateway/extension host 停止后关闭，以 flush WAL 和释放文件锁。

## 2. SQLite 参数

| PRAGMA               | 当前值   | 目的                           |
| -------------------- | -------- | ------------------------------ |
| `foreign_keys`       | `ON`     | session 删除级联 message/run   |
| `journal_mode`       | `WAL`    | 读写并发与崩溃恢复             |
| `synchronous`        | `NORMAL` | WAL 下的性能/耐久折中          |
| `cache_size`         | `-8000`  | 约 8 MiB page cache            |
| `wal_autocheckpoint` | `1000`   | 约每 4 MiB WAL 自动 checkpoint |

WAL 是持久设置。备份不能只在运行中复制主 `.sqlite` 而忽略 WAL；优先退出应用后复制，或使用 SQLite backup API。

## 3. Schema 总表

当前共有 12 张核心表：

| 表                              | 用途                         | Owner                      |
| ------------------------------- | ---------------------------- | -------------------------- |
| `kv`                            | 应用配置与内部同步元数据     | `SqliteStore`、领域 store  |
| `cowork_sessions`               | 产品会话索引/元数据          | `CoworkStore`              |
| `cowork_messages`               | 本地消息显示缓存             | `CoworkStore`              |
| `cowork_session_runs`           | client turn/root run receipt | `CoworkStore`              |
| `cowork_external_sessions`      | 外部 session 映射与运行状态  | Multica integration        |
| `cowork_config`                 | Cowork/runtime 设置          | `CoworkStore`              |
| `agents`                        | Agent 产品定义               | `CoworkStore`              |
| `mcp_servers`                   | 用户 MCP 配置                | `McpStore`                 |
| `openclaw_hooks`                | Hook 状态/config             | `OpenClawHookStore`        |
| `session_groups`                | 会话分组和顺序               | `GroupStore`               |
| `scheduled_task_run_receipts`   | 应用内 cron 结果/未读        | `ScheduledTaskResultStore` |
| `scheduled_task_result_cleanup` | 结果 artifact 清理进度       | cleanup service            |

`scheduled_task_result_cleanup` 也是独立核心表；任何漏掉 cleanup 或 run receipt 的旧清单均不准确。`sqliteStore.ts` 的 `CREATE TABLE` 清单是最终依据。

## 4. `kv`

| 列           | 类型/约束        | 语义          |
| ------------ | ---------------- | ------------- |
| `key`        | TEXT PK          | 稳定配置 key  |
| `value`      | TEXT NOT NULL    | JSON 序列化值 |
| `updated_at` | INTEGER NOT NULL | Unix ms       |

`SqliteStore.get/set/delete` 解析/序列化 JSON，set 使用 upsert，并通过进程内 EventEmitter 触发 `onDidChange(key)`。事件不是跨进程数据库监听；只覆盖同一 Main 实例通过该 Store 写入的变化。

主要内容包括 `app_config`、自动启动/防休眠标记、自动更新检查频率与上次自动检查时间，以及 scheduled result baseline/task watermark/catch-up。自动更新使用 `app_update_check_frequency` 和 `app_update_last_automatic_check_at`；领域 prefix 是兼容接口，改名需迁移。

## 5. `cowork_sessions`

| 列                        | 说明                                    |
| ------------------------- | --------------------------------------- |
| `id`                      | UUID/稳定本地 session id，主键          |
| `title`                   | 用户/模型生成标题                       |
| `status`                  | idle/running/completed/error 等产品快照 |
| `pinned`                  | SQLite integer boolean                  |
| `cwd`                     | task workspace                          |
| `execution_mode`          | 当前使用 local；legacy container 被迁移 |
| `permission_mode`         | ask/auto/full 之一，经 shared normalize |
| `active_skill_ids`        | JSON array                              |
| `agent_id`                | 默认 `main`                             |
| `model_ref`               | qualified provider/model，可空          |
| `group_id`                | 指向 session_groups，可空               |
| `created_at`,`updated_at` | Unix ms                                 |

索引：

- `idx_cowork_sessions_order(pinned DESC, updated_at DESC)`；
- `idx_cowork_sessions_agent_order(agent_id, pinned DESC, updated_at DESC)`。

运行状态不能只信该表；启动会把遗留 running 重置为 idle，实时状态需结合 Gateway。

## 6. `cowork_messages`

列：id、session_id、type、content、metadata JSON、created_at、sequence、thinking_content、model_name、usage JSON。foreign key 对 session 使用 `ON DELETE CASCADE`。

索引：按 session id；按 `(session_id, sequence, created_at)`。Store 支持 add、按 session 读取、update、delete 单项、从某消息开始删除等。

这是 UI cache：Gateway history 是 transcript 权威。metadata 可包含 tool、plan、attachments、identity 等结构，读取时必须容忍旧/坏 JSON。启动会删除 foreign-key 引入前遗留的 orphan message。

## 7. `cowork_session_runs`

| 列                                    | 语义                             |
| ------------------------------------- | -------------------------------- |
| `id`                                  | 本地 receipt id                  |
| `session_id`                          | 级联关联 session                 |
| `client_turn_id`                      | Renderer/Main 幂等键，UNIQUE     |
| `root_run_id`                         | Gateway 接受后绑定的真实 run id  |
| `model_ref`                           | 本 turn 模型快照                 |
| `state`                               | admission/accepted/terminal 状态 |
| `started_at`,`accepted_at`,`ended_at` | 各阶段 Unix ms                   |
| `created_at`,`updated_at`             | receipt 时间                     |

`idx_cowork_session_runs_session_started` 支持时间线；partial unique `idx_cowork_session_runs_open` 保证每个 session 最多一个 `ended_at IS NULL` 的 receipt。Start 先查 client turn 实现幂等，Adapter 收到真实 run id 后 bind；终态填 ended_at。启动 `interruptOpenSessionRuns(now)` 把上一应用进程遗留的开口 receipt 记为零时长 `aborted` checkpoint，避免恢复期间误报运行且不把离线时间算入耗时；若 Gateway 随后确认该 session 仍有 active work，runtime reconciliation 会重新打开该 checkpoint（root run id 暂缺时也原位恢复）并从当前进程重新计时。首次对账前若用户提交新 turn，main 进程会强制刷新该 checkpoint 的 Gateway 状态：active 时恢复旧 receipt 并拒绝新建，unknown 时 fail closed，只有 confirmed idle 才创建新 receipt。

## 7.1 `cowork_external_sessions`

该表保存外部工具 session 与本地 Cowork/OpenClaw session 的稳定映射。当前 `source` 为
`multica`；记录首次外部 session key、OpenClaw runtime session id/key、本地 cowork session
id、工作目录、运行状态和时间戳。`(source, external_session_key)` 是主键，runtime id 与 cowork
session 均有唯一索引；cowork session 删除时通过 foreign key 级联删除映射。

首次 `multica-*` session 会得到稳定的 `agent:<agent>:multica:<hash>` key，恢复运行可通过外部
id 或 runtime id 复用同一映射。外部会话在 JustDo 中只读；删除本地映射和展示数据不会删除
Multica 任务或 OpenClaw transcript，消息正文仍以 Gateway history 为权威。

## 8. `cowork_config`

结构同 KV：key/value/updated_at，但 owner 是 Cowork/runtime domain。`CoworkStore.getConfig/setConfig` 对 execution mode、working directory、permission mode 等做默认与 normalize；版本化 runtime settings 通过 `agentRuntimeSettings:v1` 保存。旧记录缺少 AskUserQuestion 或 MCP 配置时分别补入默认 10 分钟与 60 秒，损坏或越界值按 shared contract 回退。

修改配置的 IPC 使用 promise queue 串行，并在成功写入后同步 OpenClaw。Subagent 设置生成 `agents.defaults.subagents`；AskUserQuestion 等待时限生成 `plugins.entries.ask-user-question.config.timeoutMinutes`；全局 MCP 请求时限作为每个用户 `mcp.servers.<name>.timeout` 的默认值。同步失败会恢复上一份数据库值；数据库保存成功不自动证明 Gateway config active。

## 9. `agents`

字段：id、name、description、system_prompt、identity、model、icon、skill_ids JSON、enabled、is_default、created/updated。启动确保 `main` agent 存在；若是首次迁移，可继承旧 `cowork_config.systemPrompt`。

空 model 可从默认 provider 回填；裸 model 仅在唯一 provider 匹配时升级为 qualified ref。默认/受管 agent 的删除和关键字段限制应由 store/handler 执行，不靠 UI。

## 10. `mcp_servers` 与 `openclaw_hooks`

MCP：id PK、唯一 name、description、enabled、transport_type（默认 stdio）、config_json、created/updated。`config_json.requestTimeoutSeconds` 是可选的单 Server 请求超时覆盖；缺失时继承全局默认。Hook：id PK、enabled（默认 false）、config_json、created/updated。

两表保存产品配置，不等于 runtime 已应用。CRUD 后必须调用 config sync；sync 失败需向 UI 报告并允许恢复。config JSON可能含 environment/credential，禁止原样记录日志。

## 11. `session_groups`

字段：id、name、color（默认 `#6366f1`）、sort_order（默认 0）、created_at。GroupStore 提供 list/get/create/update/delete、moveSessionToGroup 和 reorder。

Reorder 应在 transaction 中更新所有传入 id；删除 group 时要明确 session 的 `group_id` 如何置空/处理。由于 `cowork_sessions` 建表文本在 group 之前，SQLite 允许引用后创建表；foreign keys 已开启。

## 12. `scheduled_task_run_receipts`

run_id PK；task id/name；session id/key；status；summary/error；delivery status/error；started/finished/duration；observed/read/updated。索引分别支持全局时间、task 时间和 partial unread。

Store 行为：

- upsert Gateway runs，保留已有 `read_at`；baseline 可把旧记录设为已读；
- list 用 `(started_at, run_id)` base64url cursor keyset 分页，默认 30、最大 100；
- unread 排除 running；markRead 首次时间用 `COALESCE`；
- baseline、per-task watermark、durable catch-up 存入 KV prefix；
- malformed cursor 抛 `Invalid result cursor`，IPC 转为稳定错误。

## 13. `scheduled_task_result_cleanup`

run_id PK、`archived_paths_json`、updated_at。它不是结果内容表，而是删除 Gateway cron session/transcript/run artifacts 时的恢复记录。只有外部 artifacts 清理成功后才删除 receipt；失败保留两者，便于重试。

## 14. 兼容与迁移

当前迁移机制是幂等建表、`ensureColumn` 和小型数据修正，没有独立版本表：

- 为 session 加 permission_mode/model_ref；
- 为 session run 加 accepted_at；
- 为 MCP 加 description；
- 建立 main agent并继承旧 prompt；
- `container` execution mode -> `local`；
- 清 orphan messages；
- KV 空时导入旧 `config.json`。

另有 destructive legacy detection：若已有关键 cowork 表却缺少一组基础必需列，整个 DB/WAL/SHM 会被删除重建。新增列时必须谨慎更新 `REQUIRED_TABLE_COLUMNS`；误把可迁移 schema 判 legacy 会造成数据丢失。

## 15. 数据访问规则

- Renderer 只能通过 preload/IPC；不得打开数据库。
- Store 方法使用 prepared statements；动态 SQL仅允许由内部生成的固定 table/column。
- 多步不变量用 `better-sqlite3` transaction，例如 run、reorder、批量 upsert。
- JSON 边界要 parse/normalize并容忍坏值，不把 unchecked object带入 config sync。
- timestamp 内部用 Unix ms，IPC domain 通常转 ISO；游标必须稳定排序。
- 密钥可能存在配置中；数据库不应被当作可公开日志或随意附到 issue。

## 16. 备份、恢复与排障

正常备份：退出应用后复制 `justdo.sqlite`；如在线备份则用 SQLite backup/checkpoint 机制。排障先备份数据库、WAL、SHM，再运行只读 `PRAGMA integrity_check`/`table_info`。不要在应用运行时手工修改 row。

典型检查：表/列是否存在、foreign_keys 是否开启、WAL 是否堆积、open run partial unique 是否冲突、JSON parse warning、result catch-up key 是否损坏。原始数据库可能包含用户 prompt、路径和 credentials，分享前需脱敏。

## 17. Schema 变更清单

1. 明确权威/生命周期与现有用户兼容策略。
2. 添加幂等 schema/migration；破坏性操作必须有严格检测与备份策略。
3. 添加真实查询所需索引和 transaction。
4. 更新 store/IPC/shared types，处理旧 JSON/NULL/default。
5. 为全新、旧 schema、重复启动、失败中断和级联行为加测试。
6. 同步本文件及受影响架构文档。

## 18. 写入原子性边界

| 操作                           | 应保持的原子性                                       |
| ------------------------------ | ---------------------------------------------------- |
| Session create + 初始 metadata | row 必填字段一致，失败不留下不可打开 session         |
| Turn begin + root run receipt  | 幂等 client turn 与 open clock 同步建立              |
| Run terminal                   | terminal 状态、duration/clock 只结算一次             |
| Group reorder                  | 同一事务更新稳定顺序，避免重复/空洞造成 UI 抖动      |
| Result page upsert             | 同批 run 写入且保留已有 readAt                       |
| Result delete/cleanup          | 跨 Gateway 非数据库事务，用 cleanup table 做补偿记录 |

SQLite transaction 只能保护本数据库，不能回滚 Gateway、文件系统或子进程。跨边界操作要用 durable receipt、幂等 key 和补偿流程，不应让 transaction 长时间包住网络调用。

## 19. 并发与进程假设

当前 store 使用 `better-sqlite3` 同步 API并运行在 Electron Main；Renderer 和 Gateway 不直接打开该文件。WAL 改善读写，但不意味着支持多个 JustDo 实例任意写入；single-instance 与优雅关闭仍是产品约束。prepared statement/transaction 内避免异步等待，关闭时先停上游工作再 close database。

## 20. JSON 与枚举兼容

`kv`/配置字段中的 JSON 是长期数据接口。读取时应对缺字段、旧 enum、坏 JSON 和 `NULL` 设置安全默认；写入时使用当前 canonical shape。Goal 的历史 usage/budget limited、旧 model ref、旧 agent model 空值等通过读取归一/启动迁移处理，不要让 Renderer 同时支持多套旧 shape。

## 21. 数据保留与隐私

数据库可能包含 prompt、路径、provider/MCP 配置和任务摘要；Gateway state/history 与 plugin 目录则在数据库之外。所谓“删除用户数据”必须列出所有 owner，不能只删 SQLite row。日志导出/issue 附件不得默认包含数据库、WAL、SHM 或 raw config。

## 22. 测试证据

- `sqliteStore.test.ts` 覆盖 schema 初始化、兼容与 startup stale-state 处理。
- `coworkStore` 测试覆盖 session/run/clientTurn 幂等、查询和终态。
- `scheduledTaskResultStore.test.ts` 覆盖 baseline、upsert、read、pagination 和 cleanup。
- 各领域 store 测试需使用全新库和旧 schema fixture；只在空库通过不能证明升级安全。

## 23. Schema Definition of Done

提供幂等 DDL、旧用户迁移、真实查询索引、事务边界、坏值 fallback、备份/失败策略和测试。更新表数量/字段/权威文档，并验证重复启动与强制中断后可恢复。任何会触发 destructive legacy detection 的规则调整都必须单独审查其误判与数据丢失风险。

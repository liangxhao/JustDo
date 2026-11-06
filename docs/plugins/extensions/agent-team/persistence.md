# Agent Team 持久化与恢复

本页维护本包的房间、成员、投递、讨论、资源偏好和发起回执。用户流程及执行语义见[业务说明](guide.md)，适配端口见[宿主集成](integration.md)，实际验证范围见[验证边界](validation.md)。

## 数据权威与 schema 注册

插件通过公开 App SDK 注册自身 schema，并借宿主提供的同一 SQLite 连接执行同步事务；数据库连接、通用产品会话和通用资源保护账本仍由宿主拥有。此契约不要求业务表位于另一个数据库，也不授权插件直接打开宿主数据库。房间创建与对应成员产品会话写入保持同库原子事务，网络请求在事务外完成。

OpenClaw 拥有消息、公开群发言、Thinking、工具结果与待发正文。下列表及原生磁盘收据只保存元数据、定位与恢复证据，不建立插件、Main 或 Redux transcript 缓存。包内 schema 实现见 [`host/data/`](../../../../plugins/extensions/agent-team/host/data)；数据库初始化与资源声明由插件 Main 入口注册。

## 业务表清单

| 表                                 | 责任与关键身份                          |
| ---------------------------------- | --------------------------------------- |
| `collaboration_rooms`              | 唯一 anchorSessionId                    |
| `collaboration_members`            | room 内唯一 agent；session/key 全局唯一 |
| `collaboration_rounds`             | 用户轮次及 stopped_at                   |
| `collaboration_deliveries`         | 路由、摘要哈希、原生接收和状态          |
| `collaboration_execution_receipts` | 精确 sessionKey/runId 的 whole-run 终态 |
| `collaboration_reviews`            | 原生验收执行、封闭结论及对应批次        |
| `collaboration_review_deliveries`  | 验收报告到具体工作回执的关联            |
| `collaboration_deletions`          | 删除冻结记录                            |
| `collaboration_deleted_members`    | 已确认原生删除的成员                    |
| `team_discussion_rooms`            | 固定成员、来源身份及房间状态            |
| `team_discussion_runs`             | 请求指纹、批次身份与汇总抑制            |
| `team_discussion_executions`       | 成员精确原生执行、结算和清理证据        |
| `team_discussion_summaries`        | 来源汇总的 outbox 与执行回执            |
| `team_discussion_task_links`       | 获准读取群历史的关联产品任务            |
| `team_discussion_deleted_rooms`    | 已删除房间的持久墓碑                    |
| `team_discussion_queue_control`    | 每群待发控制 generation                 |
| `team_discussion_pending_inputs`   | holding 引用、请求指纹与 FIFO 状态      |

## 群组讨论元数据

Agent Team schema 定义 team_discussion_rooms（固定成员映射、cwd、只读/权限、revision、generation、状态及来源任务）、team_discussion_runs（requestId / fingerprint / active slot / 状态）、team_discussion_executions（discussionId、成员、精确 sessionKey / sessionId / lifecycleRevision / runId / outcome）、team_discussion_task_links 和 team_discussion_deleted_rooms。

只有房间元数据，不存正文。部分删除记录在成员元数据，compare-and-delete 成功后逐一标记；删除墓碑阻止复用旧 roomId。SDK 准备的 `state/plugin-data/agent-team/discussion-receipts/` 保存无正文 admission / close receipt；消息与公开 channel-final mirror 均属于 OpenClaw native transcript。

详见 [Agent Team 现行契约](guide.md)。

team_discussion_runs 的可空 initiator_agent_id 标识主助手通过工具发起的消息；正文仍从原生 transcript 读取。该列由当前完整建表定义声明，不再通过缺列检测补充旧表；用户请求指纹继续按当前幂等规则核对。详见[组织者与来源汇总](guide.md#群聊组织者与来源汇总)。

## 团队结果与执行回执

`team_discussion_rooms.summary_source_json` 固定来源 agentId/sessionKey/sessionId/lifecycleRevision；borrowed-source 成员存在 members_json，只借用身份，群删除不删除来源。`team_discussion_runs.summary_suppressed` 持久阻止用户停止后的迟到汇总。

`team_discussion_summaries` 以 discussion_id 为主键，外键关联批次/房间，保存 pending/running/stopping/delivered/failed/cancelled/unknown、run_id、updated_at，并按状态/更新时间索引。终态与 outbox 插入同一事务；网络提交在事务外。每轮最多轮询 16 条未终态汇总，每次尝试（包括传输失败）都推进 updated_at，使旧异常记录不会长期占满窗口；推进时间不覆盖并发停止或终态。

附件准备等发生在原生提交前的失败只记录批次失败，不创建汇总 outbox；已提交但响应丢失仍保持未知状态，待原生回执确定终态后再汇总，不自动重发。

`collaboration_rounds.closing_run_id` 记录显式 seal；seal 与新 delivery 注册事务互斥。`collaboration_execution_receipts` 按 `(room_id, session_key, run_id)` 保存 completed/failed/cancelled，房间删除级联；延迟接受回执可关联早到的 whole-run 证据。其数据不包含正文，不把接收状态改写为执行结果。

房间停止操作在同一事务内依据批次派生状态，只为 open/closing 批次写入 `stopped_at`。已经 settled/failed 的历史批次保持原终态与验收状态；重复停止及后续迟到回执不把旧历史改成停止，也不重新开放已 seal 的批次。

SDK 准备的 `state/plugin-data/agent-team/summary-receipts/` 保存指纹、执行与可见输出 entryId；同一受管根下的 `discussion-receipts/` 增加公开输出引用。群公开正文和最终总结始终在原生 transcript，Main 不存消息副本。上述产品字段由当前完整 schema 声明，不再为旧中间房间补列；原有独立 main 会话不迁移。停止和 unknown 恢复边界见[Agent Team 契约](guide.md)。

## 精确执行的独立验收

当前产品 schema 包含 `collaboration_reviews` 和 `collaboration_review_deliveries`，重复初始化不改写已有记录；这与已撤回的历史运行时迁移无关。报告以房间、验收助手及原生 runId 唯一，保存批次、验收投递回执、`passed / changes_requested / unverified` 和时间；关联表以 `(review_id, delivery_id)` 唯一绑定 1–16 个工作回执。报告/回执/房间删除级联，`(room_id, round_id, created_at)` 索引服务当前批次显示。

写入在同步事务中验证：验收 run 是组织者向独立成员已登记的真实入站；待验工作在同房间同批次、已原生接受且具有成功 whole-run 回执；不能验自己或组织者。重复相同报告返回原记录，更改结论或范围必须使用新验收执行。报告状态通过验收 admission、确切 whole-run 终态和 stopped_at 派生；工具报告成功先是 pending，原生接受且整次验收成功才 confirmed，失败、取消和 unknown 不显示通过。

数据库不保存检查标准、交付物、证据、结论正文或文件版本；这些留在原生任务/验收历史。confirmed 是该助手对列出的确切执行报告完成，不是文件散列证明、全任务质量门禁或对后来返工的自动认可。丢失 whole-run 证据时保留待确认，不靠 chat final、空闲或重启猜测通过。

Agent Team 的表初始化、房间/投递/验收/待发输入及资源偏好事务由本包的 [`host/data/`](../../../../plugins/extensions/agent-team/host/data) 持有实现，通用桌面宿主按清单加载 schemas 与 Main 入口，不保留 Team 稳定门面。实际 SQLite 连接及通用产品表仍由宿主提供；同一连接内的成员会话创建与团队记录写入保持原子事务。此归属调整不移动数据库或变更表、外键、持久化路径和恢复契约，也不创建插件 transcript 缓存。

## Agent Team 参数元数据

全局默认存储于 `kv` 键 `agentTeam.settings`，含 version、revision 和严格限定的数值/布尔值。`collaboration_rooms.settings_json` 与 `team_discussion_rooms.settings_json` 保存独立 revision 的团队覆盖；不改变 roster 的 revision。删除团队时随房间行清理。

`collaboration_rounds.message_budget` 在开始用户轮次时固定，当前列默认 16；所有已登记投递（包括 failed/unknown、回复与验收）计数，幂等重放先查同一摘要，不重复扣额度。`team_discussion_runs.resources_json` 保存 settingsRevision/maxRounds/maxTurns/maxConcurrent，`requested_rounds` 保存数值以处理模型省略参数的重放；原输入摘要继续区分请求。没有资源快照的批次仍使用已保留的默认语义，不按新的全局设置重算已接受请求。

这些列与房间 `settings_json`、`summary_source_json`、批次 `summary_suppressed`、
协作轮次 `stopped_at` / `closing_run_id` 一起由 Agent Team 的完整 `CREATE TABLE`
定义声明，不再使用缺列探测和 `ALTER TABLE`。它们是当前产品 schema，不是已移除的
原生存储迁移。没有 prompt、消息正文、工具结果或新的 transcript 缓存。

精确原生 unknown 回执使用既有 interrupted 产品状态投影，保留 active_discussion_id 和 generation，占用不释放也不创建 summary。确认 running 可恢复显示，不能覆盖 stopping；已有记录 requested_rounds 为空时，同模型请求仍沿用旧 room.rounds 默认语义。

## Agent Team 结算证据与删除门禁

扩展的 identity-only receipt 增加 `settledRunIds` 和 `cleanupComplete`，只有全部已接纳 run 的精确 native whole-run 终态和 dispatcher 清理均确认后才写终态。owner 换代不推断 failed；旧 failed/completed/cancelled 无证据仍投影 unknown，`cancelled-before-admission` 的空执行 tombstone 单独保留。Main 不读取原生文件、不复制正文，也不对缺失证据做原生迁移。

`team_discussion_summaries(room_id,state)` 增加索引，准入和删除按全房间 pending/running/stopping/unknown 查询，独立于 worker 的 LIMIT 16。同请求幂等读原回执不受新准入阻断；新发送、成员参与变更、团队删除以及单个/批量来源删除均等待结算。普通 Stop 可以返回仍待核实，删除专用路径必须拒绝，borrowed source 永不作为群成员删除。

来源删除使用进程内计数 lease，在第一次异步操作之前冻结来源及团队成员准入，并关闭现有来源 run 的建立团队窗口。单删和批删的外层 lease 覆盖 standalone fallback；内层团队删除可嵌套，不提前解锁。停止后重读全部相关群聊，不仅依赖最初快照；异步准备、发送和成员变更提交前重新核对。lease 不写正文或新增数据库，删除失败后释放操作 lease，但不会复活已经关闭的旧 run。

## Agent Team 待发输入元数据

`team_discussion_queue_control` 按 room_id 保存独立 queue generation；它与房间执行 generation 分离，正常重启不取消已经保存的输入。`team_discussion_pending_inputs` 以 room_id/request_id 为主键，保存 generation、原请求及原生规范化指纹、附件内容摘要、房间/权限快照摘要、轮次/通知对象/资源快照、状态、native identity 和 entry_id。

没有正文、文件名、附件路径或 transcript 内容。接收容量与 request 指纹检查在 SQLite 事务中完成；同群最多 3 条活动待发输入，unknown 和 blocked 不释放名额，也不允许后续输入绕过队头。

正文只进入常驻 Runtime Services 拥有的通用 `inert-custody` 原生会话，使用 custom-role/customType、`display:false` 与 `excludeFromContext:true`；native owner 标记在 `pluginExtensions.runtime-services.custody`。

`stateDir/runtime-custody/` 只保存 opaque resourceId、epoch、owner、摘要、接收和取消元数据，不识别 Team 房间或轮次；Team 自己序列化业务内容并保存映射。原生稳定 idempotencyKey 与精确 raw delta 读回用于确认 saved。保存/读取需要当前写租约，关闭后的维护只能处理既有资源。ACK 丢失变为 unknown，重启仅核对原生条目，不再 append；无法核对则保留未知。

Renderer 按需读取当前面板投影，不建立 Redux 或 Main 正文缓存。

逐项取消写持久 tombstone，全量 Stop/明确禁用推进 queue generation。已经开始原生派发而未取得结算证据的输入保持 unknown，不能因取消请求推断未执行。Main disable lease 在改扩展开关前同步关闭接收/建群/派发并持久取消，离线原生清理失败也不使产品输入恢复；快速重新启用在同一配置 lane 排队。正常 runtime shutdown 保留 saved，不能等同于明确禁用。

附件复制为项目 `.agent-tasks/team-discussions/` 产物，原生 holding 条目保存稳定路径，产品只保存 SHA-256 摘要。启动前重新核对内容及当前权限；未知执行仍可能引用产物，取消 ACK 不授权删除。

房间删除先关闭原生 holding admission，Main 按 exact sessionId/lifecycleRevision 归档，owning SDK 确认归档后解除锁，再由 Main `archivedOnly:true` 精确删除；确认全部 holding 身份缺失才清理产品待发行。

已解锁后正常退出可能清除 native marker；只有持久 closed slot 的精确 key/SID/revision/harness/root 与 archived/unlocked 原生条目一致且没有冲突 marker，才允许补完删除，不放宽正文接收/读取。中途未知保留任务，不删除同 key 的替代 incarnation。详见[业务与删除契约](guide.md#数据禁用与删除的所有权)。

## Agent Team 发起守卫元数据

Main KV 记录产品候选与提交边界；Team 自己的发起账本使用 SDK 准备的 `state/plugin-data/agent-team/launch-receipts/`，保存 generation、来源 incarnation、clientTurnId、prompt SHA-256、owner、业务状态及精确 whole-run 元数据。该目录采用卸载保留策略；不迁移、扫描或回退读取旧目录。

Required 服务的通用 `stateDir/runtime-services/execution-admissions/` 只保存精确 run、owner 租约、generation、接纳、终态和 cleanup attestation，不读取 Team schema。两者均不保存正文。持久写入使用 fsync 和原子替换；读取失败、损坏和写入未知不能转为空状态。原生 namespace 不作为跨重启唯一权威，退休 owner 不自动重放。SDK 受管恢复账本保留，不增加旧协议回退、旧目录扫描或迁移桥。

released tombstone 的历史身份在合法 reset/revision 后仍可核对，原 SID 或当前精确 SID 可读取前代 generation；身份变化后旧 whole-run proof 不转移到当前 incarnation。新候选必须绑定当前 SID/revision 且 CAS 下一代，不能复用旧 clientTurnId。未 released 的身份变化不作历史完成推断。

## 数据路径与保留策略

Team 自有原生磁盘账本统一使用 SDK 准备的 `state/plugin-data/agent-team/`：`discussion-receipts/`、`summary-receipts/`、`launch-receipts/`。此受管根采用 `retain` 策略，关闭、更新及卸载均不清空恢复账本；重新安装也不自动重放未知任务。路径由 SDK 提供，不由模型参数或旧目录猜测。

原生 transcript、通用 Required 服务账本、宿主产品数据库与项目 `.agent-tasks/team-discussions/` 附件有各自的所有权。取消 ACK、插件退休或本地对象释放都不能证明原生已停止引用文件，也不能授权删除 borrowed source。完整业务删除顺序见[禁用、卸载与删除](guide.md#禁用卸载与删除的区别)。

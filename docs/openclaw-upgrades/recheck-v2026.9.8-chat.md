# v2026.9.8 聊天与执行功能逐项复查

复查日期：2026-10-04。依据当前应用代码与 `../openclaw` v2026.9.8 源码重新核对；没有恢复旧 schema、旧配置或旧补丁兼容。测试使用模拟 Gateway／离线 DOM，不调用付费模型，不操作真实账户，不切换 SQLite ABI。诊断采集和 worktree 由主审查线程负责，本文不重复声称验证其修改。

## 本轮发现与修复

### 1. 已失效的截断待处理输入仍可能显示（P2）

`gateway/chat-pending-inputs.ts` 原先把补全的明确 `not_found`／`not_visible` 与临时失败统一当作无法补全，继续显示旧截断内容。原生允许 pending 项省略 runId，此时无法依靠精确回执清理。Main 浏览器读取 `runtimePendingHistory.ts` 也漏掉 `not_found`。

对照上游 `packages/gateway-protocol/src/schema/logs-chat.ts` 和 `src/gateway/server-methods/chat-message-get-handler.ts`，现在只在 `ok:false` 的明确缺失／不可见响应后退役该项。Renderer 缺失触发正式历史刷新；Main 继续原有游标追读。网络错误／超限继续保留原生占位。已确认退役且 runId 匹配的乐观输入，在后续回执失败时也不会重新出现。无 raw transcript fallback，无正文缓存。

新增回归覆盖无 runId 的两种明确退役、暂时传输失败以及退役后回执失败；主聊天与 Main 两条链均测试。

### 2. 未确认整轮结束的 lifecycle 事件可提前收敛产品状态（P2）

`runtimeGatewayEvents.ts` 以前对任何 `end`／`error` 都设置结束状态并启动 1.5 秒兜底，`openclawRuntimeAdapter.ts` 随后清除 activeTurn、发 complete。共享准入层仅检查身份与序列，不校验整轮终态。因此未 settled 事件会让后续执行仍在继续时产品提前显示结束。

对照上游 `src/agents/command/lifecycle.ts`：finishing 是 attempt fence；外层执行发布的 end/error 携带 `executionSettled:true`。现仅该确认终态可启动 Main 兜底；Goal 仍接收完整事件序列。新增用例验证 undefined／false 均持续 active，随后 true 正常结束；原有正式终态测试补齐真实协议字段。该修复由事件注入测试验证，不声称本轮已用真实模型触发重试。

## 功能清单与核查结果

下列路径省略 `src/`；聊天模块统一位于 `renderer/libs/openclaw-chat/`。

| 功能 | 当前入口与协议核查 | 风险、结果与测试证据 | 实际边界 |
| --- | --- | --- | --- |
| Thinking | `model/agent-event-reducer.ts`、timeline；原生 thinking item、owner、sequence | reasoning／redacted thinking 与正文分段；乱序、历史恢复、段替换相关 reducer 测试通过 | 模型不提供 reasoning 时不能推测；未进行真实模型可见性测试 |
| Tool | 同一 reducer、tool presentation；原生 toolCallId、item progress、terminal status | progressText 有序更新，结果到达清除进度；skipped/failed/cancelled 显示与执行状态分开；tool-sequence 和 presentation 测试通过 | 工具卡成功不代表整轮或结果交付完成 |
| Content | reducer、history display normalizer、`justdo-chat` | delta／累计 snapshot／replaceable、preamble owner、防重复与终态迟到事件测试通过 | 展示层不生成模型未返回正文 |
| 原生历史及冷恢复 | `gateway/chat-controller-history.ts`、history protocol | Gateway 为唯一历史权威；快照、分页、连接 generation、session fence、读取失败阻止发送与重试测试通过 | 当前导出快照不等于完整原生备份；本轮未解压／读取真实用户历史文件 |
| pendingInputs | `gateway/chat-pending-inputs.ts`、共享 `openclaw/pendingInputs.ts`、Main `runtimePendingHistory.ts` | 独立 pendingBefore 分页、回执最多50、接受时间排序；空 receipt 消费仍追读 canonical；runId:user 去重；本轮修复明确缺失退役 | queuedCount=0 不代表没有 durable pending；取消记录只有 display:false 才隐藏，不增加独立队列管理 UI |
| 发送与乐观输入 | controller send／history reconciliation | 原生接受与正式用户正文分离；按身份退役，不因相同文字误吞新输入；并发历史失败不提前压掉未确认乐观输入 | 不把 pending body 写入 Redux／Main transcript 缓存 |
| SubAgent 列表与详情 | `main/engine/openclaw/subagentGateway.ts`、subagents 组件 | sessions.list/describe 的真实身份与 spawnedBy 关系；500项原生分页和应用游标；执行状态与交付状态分离；相关 Main/Renderer 测试通过 | native 状态未知不冒充完成；本轮未跑真实多模型并发子任务 |
| 子任务停止与归属 | 同上；native sessions.abort | 祖先链校验、循环／深度限制；取消前重读身份，clearQueued:true 交由原生级联；伪造归属测试通过 | 原生 abort 接口以 key 为目标；无法凭 UI 自行承诺多 RPC 之间原子性 |
| Ask 权限 | `shared/security/approvals.ts`、权限协调器、approval UI | 应用 ask 映射原生 guarded；审批属于原生策略，UI 不绕过；权限／审批定向测试通过 | 有权限不等于所有外部环境可执行 |
| Auto 权限 | 同上 | auto 映射 workspace；每轮准备核对 native permissionMode；活动轮修改延后应用，不伪造即时生效 | 延后模式变更与原生可选热变更能力是应用产品策略区别 |
| Full 权限 | 同上 | full 映射 full；与 Plan 只读覆盖分开；失败不以本地字段冒充成功 | Full 不能绕过原生宿主、插件或沙箱限制 |
| Plan 开关／展示 | `runtimePlanInteractions.ts`、`openclaw-extensions/plan-mode`、plan preview | active 时启用限制、会话 key、native read-only tool policy；Plan artifact 与进度卡分开；Plan plugin／preview 测试通过 | Plan 是执行策略覆盖，并非第四个权限档位 |
| Plan 审批与实施 | 同上及 approved-plan handoff | requestId／sessionKey 校验，持久化 dispatching/admitted/resolved、稳定 implementation runId，先退出规划再按批准 artifact 实施；handoff 回归通过 | 重复点击不应产生重复实施；真实复杂计划 UI 仍需人工走查 |
| run 绑定与终态 | `runtimeGatewayEvents.ts`、shared messageDomain、controller terminal | provisional run 到原生 run、physical sessionId、lifecycleGeneration、sequence、已结束 run fence；本轮补 settled 门槛 | Chat final 是显示终态，诊断整轮结论仍只认 executionSettled |
| 会话停止与队列 | `openclawRuntimeAdapter.ts` abortSessionAndSubagents | 全停止调用 sessions.abort(key, clearQueued:true)，指定旧轮取消用 runId；严格检查原生成功回执；stop/reconnect 测试通过 | 原生负责队列、后代、审批级联，应用不建立替代队列 |
| 断线／恢复 | runtime reconnect／turn lifecycle、controller session lifecycle | 未知 admission 重新核对，不把 socket close 当完成；旧连接事件不能污染新投影；压缩期间暂停结束计时 | 离线时无法证明远端已停，不给假成功 |
| Goal／续行 | `main/openclaw/goals`、goals 组件 | 目标预算、执行归属与 terminal settlement 分开；完整工具／生命周期送给协调器，chat final 后也不截断目标观察；定向测试通过 | Goal 不等于 Plan 或 progress card；本轮未跑长时真实模型目标 |
| 助手配置与角色文件 | `main/ipc/cowork/agents.ts`、agents.files | profile／文件写入串行；活动原生会话防配置重启；角色文本由 native API 管理；删除软保留，不调用破坏历史的 agents.delete；agents IPC 回归通过 | 禁用是聊天入口限制，不是原生授权撤销；实际多助手项目引导未做真实 UI 测试 |
| 助手会话身份 | adapter prepareSessionKey/toSessionKey | 优先保存的 nativeSessionKey，其次 agent-scoped key；工作区、权限、physical session 校验；不把切换助手实现为移动旧历史 | 诊断中的独立助手 key 修复由主线程负责验证 |
| 平级协作 | `main/ipc/cowork/collaboration.ts`、agent-team extension | native-send hook 约束、expectedSessionId、membership／receipt metadata；计划只读限制发消息；extension 单测通过 | accepted 仅代表接受，不代表完成；真实 SQLite 协作持久化本轮交主线程统一跑，不能据插件单测声称已覆盖 |

## 本轮测试与未覆盖范围

- 初始独立域回归：121 个测试文件、1,727 项通过，含 Renderer chat、SubAgent、Goal、Plan preview、Main engine（排除 SQLite diagnostics）、permissions/goals、agents IPC、plan-mode、协作 extension。日志 `.tmp/recheck-chat-domain-tests.log`。
- pending 修复定向：3 文件、27 项通过。
- 生命周期修复定向：45 项通过；其后整个 Main engine 非 SQLite 域 14 文件、253 项通过。日志 `.tmp/recheck-chat-final-engine.log`。
- 六个修改源码／测试文件 ESLint 通过；没有执行全量 npm test 或调整 native ABI。全量、实际 Gateway smoke 由主线程统一运行。

人工验证仍需真实交互：切换模型后观察 reasoning 可见性；长工具进度与取消；三个权限档位分别执行允许／拒绝场景；Plan 批准、拒绝、断连重开；子任务级联停止；助手切换新会话及协作成员的真实收发。自动化证明的是协议和状态机边界，不能替代这些真实账户／模型体验结论。

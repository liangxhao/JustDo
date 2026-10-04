# OpenClaw v2026.9.8 聊天、子任务与权限专项复查

审查对象：JustDo 升级检查点 `98bc2299d`，以及 OpenClaw 源码 `v2026.9.6..v2026.9.8`。本文区分源码契约检查、自动化测试和真实 Gateway 验证；单元测试通过不等于桌面端人工验收完成。

## 已发现并修复的问题

### 工具被跳过时显示为失败或普通完成

原生 `packages/agent-core/src/agent-loop.ts` 在 steering 等场景产生 `details.status: skipped`、`executionStarted: false`，兼容工具结果封装仍可带 `isError: true`；`src/agents/agent-activity-presentation.ts` 也将 skipped 单独计数。应用之前没有保留该展示结果，可能误导用户认为工具执行失败。

修复 `src/renderer/libs/openclaw-chat/model/tool-presentation.ts`：保留原始执行证据，展示结果识别 skipped，并计入工具汇总。时间线通过双语翻译显示“已跳过 / Skipped”。回归覆盖实时 item、实时工具结果 details、历史 activity 和时间线标签；不会把具有明确非零退出码的实际失败改成成功。

### 会话列表事件提前结束当前执行

原生 `packages/gateway-protocol/src/schema/sessions-row.ts` 包含 queued 状态，`src/gateway/session-event-payload.ts` 带 sessionId、lastRunId。应用原先只排除 running，因此队列行，以及同 key 下旧 session/run 的终态行，都可能清理当前 turn。

修复 `src/main/engine/openclaw/runtimeGatewayEvents.ts`：queued 不作为终态；存在原生 session/run 标识时必须匹配当前执行才清理。明确的 reset/delete 继续作为会话边界处理；缺少标识的事件保留原有兼容路径。新增三项回归先证明旧行为失败，再检查拒绝错误事件后正确的当前终态仍能结束执行。

## Thinking、Tool、Content 与历史恢复

| 检查项 | 源码依据与判断 | 验证范围 |
| --- | --- | --- |
| 实时流与身份 | `src/shared/openclaw/agentEvent.ts` 统一 agent/session.tool，保留 transport seq、源 seq、run/session/lifecycle 身份；Main 连接显式声明 tool-events capability | 聊天 reducer、事件顺序和 runtime adapter 测试；真实 worker 验证另见下文 |
| 内容与工具顺序 | `src/renderer/libs/openclaw-chat/` 的 live reduction、工具展示及时间线继续接收原生事件，未建立 Main/Redux 消息副本 | 回归包含乱序、迟到事件、工具进度和终态；此次补齐 skipped |
| 历史及大消息 | 原生 chat.startup/chat.history 与 chat.message.get 分块读取仍由 Gateway 提供；恢复逻辑直接消费原生消息 | 历史、hydration、消息合并测试覆盖；不直接扫描原生数据库文件 |
| 断线恢复 | 会话订阅建立后读取 startup/history，避免快照与实时订阅之间丢事件；生命周期身份阻止旧执行污染 | 订阅、重连、恢复及 lifecycle 测试；此次补齐旧 session/run 的 sessions.changed 处理 |

9.8 的 chat schema 增加 pendingInput 收据（queued/count/cancelled）、discardPendingInput、waiting_for_state 和 state_contention。应用尚未将收据中的排队数、取消数显示为专门的待处理输入管理功能，不能将接口可用描述为该 UI 已集成。现有界面对后两者采用通用等待/错误流程，没有独立队列管理界面。未把普通停止改为 discardPendingInput:true，避免将“停止当前执行”偷偷扩大为删除待处理输入。

## SubAgent 状态、消息、停止与后续交互

`src/main/engine/openclaw/subagentGateway.ts`（行为测试：`subagentGateway.operations.test.ts`、`subagentGateway.test.ts`） 使用原生 sessions.list/describe/history/abort，不再依赖已移除的 tasks.list/get 或应用任务账本。列表按 spawnedBy 及 archived:all 分页；完整快照和部分结果分别处理，未知状态不伪造为成功或排队。子任务抽屉只读原生历史，没有在应用重建消息缓存。

停止操作沿 spawnedBy/controlOwner 校验父子归属，并在异步遍历后重新读取叶节点身份、run 和归属，防止误停导航相邻或重建的会话。原生 sessions.abort 当前没有 expectedSessionId 的原子比较参数，因此“重新读取到提交之间”的理论竞争窗口仍属于原生 API 限制，不能声称客户端提供原子 CAS。相关归属、重建和取消测试验证应用能做的防护。

后续交互需明确区分两条路径：抽屉没有独立用户 followup 按钮；模型侧使用原生 sessions_send。`openclaw-extensions/runtime-services/collaboration-history.ts` 允许合法子任务/ACP 路径，普通 peer 发送仍受 agent-team 开关控制。原生 `src/agents/tools/sessions-send-followup.ts` 保留 caller 身份、mutation authority 和撤销监听；新版 schema 的 watched、sentBeforeError、no_reply 结果由工具展示直接消费，没有应用旧版严格解码器将其截掉。审查没有添加虚假的应用 followup RPC，也没有把父会话导航字段当成授权依据。

## 三档权限与审批

| 应用模式 | 原生 permissionMode | 原生执行策略 | 审查结论 |
| --- | --- | --- | --- |
| 请求确认 ask | guarded | ask | 需确认操作走原生审批 |
| 智能 auto | workspace | auto | 保留原生自动判断与工作区限制 |
| 完全 full | full | full | 使用原生完全权限语义，显式更严格约束仍可收紧 |

映射来源：应用共享 approvals 合约与原生 `src/agents/session-permission-exec-mode.ts`。`sessionPermissionModeCoordinator.ts` 串行应用设置，执行中变更延后，失败保留待重试；新 turn 前要求准备完成。工作树会话采用 describe 后带 expectedSessionId/expectedPermissionMode 的 patch，并核验返回身份；普通托管会话由 sessions.create 确认根目录和权限。没有把 UI 选择成功等同于运行时已生效。

原生审批 schema 在 9.8 集中 policy snapshot，并增加 plugin policySubject；决定值没有破坏性变更。应用审批恢复先取得 pending 快照，再重放期间缓冲事件。exec 的会话内复用按命令参数、cwd、host、agent、security、ask、环境与系统计划等精确绑定；无法绑定环境时禁止复用，reset/delete 时清除。插件审批仍由原生管理 standing grant，应用只提交对应请求的决定，未自行扩大授权范围。

## Plan 与 Goals

Plan：`openclaw-extensions/plan-mode/index.ts` 使用原生 session extension state 与 trusted tool policy；原生 `plugin-api.types.ts` 的相关注册接口仍存在。计划阶段阻止已识别的变更工具及 code_mode_exec，并在 Tool Search 解析后再次检查具体工具；PresentPlan 的等待、列表、决定由原生交互请求管理器负责。Main 的 `runtimePlanInteractions` 保持只读阶段直至终态，并通过归属明确的 approved handoff 切入实施。该插件不是任意第三方工具的通用沙箱：未知插件隐藏副作用仍需权限系统和插件自身配合，不能承诺所有扩展绝对只读。

Goals：原生 sessions.goal.update/clear 契约未发生语义迁移，handler 主要调整参数校验包装。应用 `runtimeGoalOperations` 保留会话身份和幂等键，sessions.describe 读取目标；`goalContinuationCoordinator` 区分工具进度、chat final 和 executionSettled 全执行终态，后续执行使用 suppressPromptPersistence、deliver:false 与幂等标识。此次未新增目标消息缓存，也未用 chat final 代替整轮完成证据。

## 自动化结果

- 聊天、权限、目标、计划、子任务相关：102 个测试文件、1496 项通过；记录 `.tmp/review-chat-permissions-tests.log`。
- 工具展示、时间线及翻译：3 个文件、73 项通过；记录 `.tmp/review-chat-final-tests.log`。
- lifecycle、审批及子任务：3 个文件、78 项通过；记录 `.tmp/review-chat-terminal-after.log`。
- 最后增强三个 lifecycle 回归，增加“拒绝旧事件后接受正确终态”断言：43 项通过；记录 `.tmp/review-chat-terminal-final.log`。

上述集合有重叠，不能简单相加。测试不切换原生 SQLite ABI，不改验证 runtime 的 manifest/proof。

### 真实 Gateway 离线验证

新增 `tests/openclaw/runtime/chat-stream-smoke.cjs`，启动隔离配置和原生 Gateway/worker，模型端使用本地回环 SSE 服务，真实执行 read 工具读取临时文件，再由模型确认返回内容；不使用外部模型凭据。脚本检查实时 Thinking/Tool/Content、终态与原生历史。运行命令为 `node tests/openclaw/runtime/chat-stream-smoke.cjs <已验证的9.8运行时目录>`。

最终构建产物上验证通过（`.tmp/review-chat-native-smoke-final.log`）：2 次本地模型请求，实际 read 返回文件内容；观察到 run_status、lifecycle、thinking、item、tool、usage、assistant 流；最终状态成功，原生历史返回 5 条消息。初次 Tool 断言失败源于测试连接遗漏 tool-events capability，按生产连接补齐后通过。这里验证的是当前 run 订阅的 tool 流；同连接不会重复接收 session.tool 镜像，未将该镜像或桌面断线重连人工操作计为此脚本覆盖。

## 人工验收清单（尚未执行）

- 执行中追加多条输入，核对原生排队、取消与 stop 的关系；当前未提供队列计数/逐条取消 UI，需要将此差异作为新版功能验收缺口记录。`waiting_for_state`/`state_contention` 的实际竞争场景也尚未人工复现。
- 桌面端真实模型连续输出 Thinking → Tool → Content；中途切换会话、断网重连、刷新历史，核对无丢失、重复或旧流串入。
- 子任务跨 profile、父子会话导航后读取消息与停止；执行中再次发 sessions_send，检查新版本 watched/no_reply 结果和完成状态。
- 三档权限各测试工作区内外文件写入、命令审批；执行中切换模式，验证下一轮生效与拒绝路径。
- 断线期间发生审批、审批过期、同请求重复操作；确认恢复列表不重复授权。
- Plan 拒绝/修改/批准与实施交接；Goals 达标、失败、停止、重连及预算耗尽，确认没有重复继续执行。

这些操作依赖桌面交互及真实模型/插件策略，自动化和源码审查不能代替用户验收。

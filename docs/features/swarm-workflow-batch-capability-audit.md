# Swarm Workflow 批量长任务能力调研

本文记录 2026-10-06 实施前的基线证据，下面的“当前限制”“未做”不是实施后的支持状态。实施结果、完整验证及保留限制见[实施计划与验收记录](swarm-workflow-batch-execution-plan.md)。

日期：2026-10-06。对象：100 份独立数据，每份超过一小时，按全局额度限流，全部成功后汇总。对应[实施计划](swarm-workflow-batch-execution-plan.md)。

结论：当前 Swarm Workflow 不满足这个场景；可以扩展，但不仅是增加节点数。批次存储、全局预算、原生精确运行核对、取消收敛、输入快照、产物发布和可分页汇总均需实际实现。Windows 不启用 sandbox 时能提供协作并行，不能保证任意脚本只能修改自己的文件。调研完成不代表新增功能完成或长时性能通过验收。

## 调研基线

- JustDo 当前工作目录 E:/workspace/JustDo；本轮未改生产代码、依赖、用户配置和共享运行时。
- 相邻 OpenClaw 源码版本 2026.9.8，commit `fc23bc864e4553c2d215e479eeec47b67a0bf943`。下文 `../openclaw/` 路径相对仓库根。
- 隔离 Gateway 使用已经准备的 vendor/openclaw-runtime/current，buildAt 2026-10-05T16:22:09.238Z、npm 2026.9.8、patchSetSha256 `843f5ff604fcb4bfd5844a892fcb57b1628b1b78c83ebda2c08c13c29417ed4c`。
- Hermes 官方文档与源码在当日核对；源码基线 `9d4dfde81721caf8e65f242e55002a35692582ba`。没有核实的性能数据不作为依据。
- 实验只使用生成的测试任务、固定本地模型、独立 state/config/project 和 43131/43132 端口，未操作用户 Gateway。测试日志留在忽略目录 .work，不提交原始日志。

## 当前插件的实际限制

| 能力               | 实际行为                                                   | 证据                                                                                                            |
| ------------------ | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 100 个同层工作节点 | 规划最多 8 个工作节点，产品列表最多 11 个节点              | `openclaw-extensions/swarm-workflow/contract.ts:186`、`src/shared/cowork/swarmWorkflow.ts:150`；100 项计划 probe 被拒绝 |
| 全局并发           | 同一 project 最多 3；不同 project 分别计数                 | `engine.ts:613–627`；两项目实测 6 个工作节点同时活跃                                                            |
| 独立写结果         | 任何写节点与该项目全部其他运行互斥                         | `engine.ts:622–625`；8 个无依赖写节点实测仅运行 1 个                                                            |
| 超过一小时         | 从 prepare 前计时，超一小时阻塞流程，不自动取消 native run | `engine.ts:391–396,629`；模拟 90 分钟后 blocked，cancel 调用 0 次                                               |
| 单项失败           | 任一提交 blocker/native 失败阻塞整个流程                   | `engine.ts:163–167,404–407,544–547`                                                                             |
| 单项重试           | 当前要求整个流程所有原生运行收敛                           | `engine.ts:208–219`、`intervention.ts:15–20`                                                                    |
| 汇总提示           | verify/deliver 注入全部工作结果；deliver 禁用工具          | `engine.ts:273–281`、`index.ts:181–190`；8 项结果就生成 51051 字符验收提示                                      |
| 数据读写           | 每次 all 读取完整 flow JSON；单项提交/调度反复扫描全库     | `store.ts:14–33`、`engine.ts:130–133,617–620`                                                                   |
| 配置 UI            | 目前只有敏感凭据/字符串输入；managed config 会覆盖用户参数 | `openclawExtensionImportService.ts:507–512,1169–1261`、`openclawConfigBuilders.ts:1179–1189,2084–2093`          |

这些数值属于现状。原生 tools.swarm 的 children/group/maxConcurrent 设置不等于本插件的批量模型与额度，不能改了原生设置就声称解除上表限制。

## 原生队列与时限

### 公开能力可直接复用

runtime.subagent.run 当前不传 lane，执行落到 main lane。会话名称里有 subagent 不决定执行容量。传 lane=subagent 则生成按父/当前会话区分的 lane，100 个独立节点可能得到不同队列；不能用它冒充共享全局预算。

首版保留 main lane，读取 api.runtime.config.current 的已规范化 agents.defaults.maxConcurrent 计算有效额度，预留一个普通聊天槽位：`min(用户 Swarm 额度, 原生 main 容量 - 1)`。原生容量为 1 时等待容量调整。实施没有另外调用公开 config-runtime 的 resolveAgentMaxConcurrent；字段缺失时保守按 4 处理，非法值不准入。该预留仅阻止 Swarm 占满所有 main 槽，不保证普通聊天固定响应延迟。无需新建队列 patch。

已有 before_tool_call 可按 owned 叶子会话与当前 attempt/run 禁止 sessions_spawn、sessions_send、openclaw、automations 及其他 flow/team 控制。Code Mode agents.run 也经 runtime.callExactId 和同一原生 hook。无需通用 toolsDeny patch；工具可发现不等于可执行。主机脚本/第三方插件另行调用模型不在此额度保证内。

证据：`../openclaw/src/agents/code-mode-swarm.runtime.ts:103,177–183`、`src/agents/tool-search-catalog.ts:120–124,203–211`、`src/agents/agent-tools.before-tool-call.wrapper.ts:415–451`、`src/plugins/hooks.ts:1101–1110`。仅拦已确认的入口，不将 subagents(list/wait/cancel) 或 conversations_turn 错称新建本地运行。

证据：`../openclaw/src/plugins/runtime/types.ts:16`、`src/gateway/server-plugin-subagent-runtime.ts:396–436`、`src/agents/embedded-agent-runner/lanes.ts:21–43`、`src/plugin-sdk/config-runtime.ts:78`。capacity group 不能简单把 Main/Subagent 加到新组：`src/process/command-queue.capacity-groups.ts:51–78`。

### 一小时不是 OpenClaw 总执行上限

JustDo 默认 agents.defaults.timeoutSeconds=0。原生 resolver 返回计时器安全哨兵；正式 attempt 将其解释为 unlimited，不设置总执行 abort timer，不能将哨兵约 24.85 天误解成实际截止。未设置该字段时原生默认 48 小时。

证据：`src/shared/agents/agentRuntimeSettings.ts:114`；`../openclaw/src/agents/timeout.ts:6–51`、`src/agents/embedded-agent-runner/run/attempt-timeout-prepare.ts:132–148`。直接执行生产 timeout/lane helper 已核对 0 与 lane 解析。

公开 SDK run 没有每次运行 timeout，但 agent RPC 已有秒单位 timeout。应新增通用 timeoutSeconds 透传，保留现有准入及 registry 登记，不直接绕过 SDK 调用裸 agent RPC。显式取需求、插件配置与非零原生上限的较小值。特别注意 subagent lane 无显式 timeout 时会强制不限时，不能借此放宽原生短上限。

证据：`../openclaw/src/plugins/runtime/types.ts:16`、`packages/gateway-protocol/src/schema/agent.ts:315`、`src/agents/command/prepare.ts:190–203`。

工具与网络还有独立时限：exec 默认 1800 秒，一小时命令需要受支持的 timeout/background/process 路径；模型请求有首事件/空闲期限。agent 不限时不意味着一条命令或一次网络请求无限期等待。

原生 timeout 不是整份数据硬墙钟预算：内部 retry/fallback 会重新使用 attempt timeout，审批可暂停计时，compaction 有一次 grace。计划因此把四小时定义为插件从精确开始累计的尝试预算；到期请求停止并等清理，不声称瞬间结束，不借纠错重置累计时间。

证据：`../openclaw/src/agents/embedded-agent-runner/run/attempt-timeout-prepare.ts:77–84,117–129`、`src/agents/embedded-agent-runner/run-loop.ts:299,335`、`src/agents/command/run-embedded-attempt.ts:499–501`。

证据：`../openclaw/src/agents/exec-tool-timeout.ts:6`、`src/agents/embedded-agent-runner/run/llm-idle-timeout.ts:23`。真实超过一小时的 agent+工具运行仍是发布关卡，本轮没有把模拟时间当作长时实测。

## 持久化、取消与精确恢复

原生 plugin_subagent run 会在接受启动前登记原生 Subagent registry，cleanup=keep；并不是只创建一个会话名字。Gateway 重启会核对旧运行、标记 interrupted，避免自动重复执行未知副作用。插件应复用此原生持久登记。

证据：`../openclaw/src/gateway/server-plugin-subagent-runtime.ts:436`、`src/gateway/agent-turn/agent-run-subagent.ts:109–129`、`src/gateway/server-methods/agent-subagent-registration.ts:127`、`src/agents/subagents/registry/subagent-registry-restart-recovery.ts:201–222`。

然而 agent.wait 查询进程内 Map，TTL 10 分钟、最多 5000 条，Gateway 生命周期重置清空。status=timeout/no endedAt 不区分正在运行、过期或未知。重启 registry 恢复发布 session/subagent lifecycle，没有保证重新填普通 agent wait 缓存。只靠 wait 的当前插件恢复路径不充分。

证据：`../openclaw/src/gateway/agent-turn/agent-job.ts:31–67`、`src/gateway/agent-turn/agent-turn-service.ts:684–691`、`src/agents/subagents/registry/subagent-registry-terminal-effects.ts:210–249`。

sessions.describe 可显示 queued/running/startedAt 和最新终态，但并非按任意旧 runId 查询。纠错/跟进可能覆盖会话投影，重启恢复也不补 lastRunId。活动列表为空不证明实际结束：原生 isEmbeddedRunHandleInProgress 在 handle.isAborted 后即返回 false，清理 finally 可能仍未结束。

证据：`../openclaw/src/gateway/session-utils.types.ts:79–87`、`src/gateway/session-utils-display.ts:180–187`、`src/agents/subagents/registry/subagent-registry-helpers.ts:181–214`、`src/agents/embedded-agent-runner/runs.ts:1065,1141–1149`。

取消回执也不能替代收敛证据。sessions.abort 可在 signal 后立即写取消 endedAt 与 dedupe 终态，此时执行器仍可能 unwind。当前 SDK wait 没有 executionSettled；新调度必须保留槽位/写锁直到原生 outer execution 真正结束，并验证受管理工具子进程清理。

证据：`../openclaw/src/gateway/chat-abort.ts:595–631`、`src/gateway/server-methods/sessions-abort.ts:648–673`。

确定方案是通用 describeRun({runId, sessionKey})：按真实插件/运行所有权读原生 registry 及执行者状态，返回 exact run 时间、Gateway epoch、outcome、executionSettled 和有界 terminal reply。只增加必要原生元数据，不复制 transcript 或另建运行数据库。不存在的行不能自动视为从未启动；还需原生确认旧 epoch 退役、恢复完成且旧准入被阻断。插件重载代际和 Gateway epoch 分开。未知运行保留槽位，允许人工核对，不承诺所有副作用 exactly-once。

还需工具 scope 清理能力：exec 默认 yield/background 可以超过 Agent turn 存活，普通 run 不自动清理所有 exec。通用 run 的可选 managedToolsLifetime='run' 复用 one-shot 清理样式，但不启用改变其他语义的 oneShotCliRun。describeRun 区分 managedTool/cleanupSettled，通用 cancelRun 复用 native supervisor cancelScope/acquireScopeCleanup 和 waitForExecScope；现有内部原语没有公开 SDK 入口，不能只查 Agent endedAt。当前 owner/会话范围检查、Gateway 死亡后的清理证据须在 P0b 验证；旧元数据缺失返回 unknown，不用插件 Node 猜 PID 杀进程。

该 scope 只证明本地 Gateway host 的管理范围，host=node/nodes 远端执行不在本机 process registry。首版按有效后端拒绝未验证远端派发，不将“本机无活动命令”当远端已结束；开放远端需 adapter 等价证据。证据：`../openclaw/src/agents/bash-tools.exec-host-node.ts:4`。

证据：`../openclaw/src/agents/bash-tools.exec-runtime.ts:578,905`、`src/agents/agent-tools.ts:204–223`、`src/agents/bash-process-scope.ts:16–19`、`src/agents/bash-process-registry.ts:379–391`。实时 lifecycle settled 的事件接口已经公开，见 `src/plugins/runtime/types-core.ts:503–505`，不需要新增事件订阅 patch。

## 输入、输出、权限和规则

单一 cwd/root 不提供多输入只读根+单输出可写根的执行权限契约。full 模式文件工具 workspaceOnly=false；workspace 的 exec auto 是审批策略；未启用 sandbox 时执行普通主机 shell。独立目录提供协作边界，不提供 OS 防写保证。

证据：`../openclaw/src/agents/tool-fs-policy.types.ts:3`、`src/agents/session-permission-exec-mode.ts:16,31`、`src/infra/exec-approvals-core.ts:129–131`、`src/agents/bash-tools.exec-runtime.ts:811,871`。

首版不暗开 sandbox：只接受父项目已核验材料，生成内容身份冻结的输入快照和每项独立工作区，结果按输入/尝试/run/路径/size/hash 服务核验后发布。共享项目写入继续排他。读清单的插件 service 不自动继承 fsPolicy；枚举前后与提交前须检查父身份/准入，不把 Node fs 能读视为会话已授权。

内部业务状态不能授予用户项目写权限。最终实施把输入快照与本项工作区统一置于父已授权项目的 `.agent-tasks/swarm-workflow` 下，创建前核验真实根及写权限；不提供旧工作流目录的兼容或迁移，stateDir 仅保存工作流业务数据库。只读父会话不能通过服务发布文件报告。要求文件结果却无法取得有效写权限的批次，在启动前拒绝。

证据：`../openclaw/src/plugins/plugin-registration.types.ts:370`、`src/plugins/services.ts:554`、`src/plugin-sdk/file-access-runtime.ts:16`；另一个插件显式消费 tool ctx.fsPolicy，见 `openclaw-extensions/stt-local-cli/index.ts:37`。

父项目 AGENTS.md 必须显式保留。原生项目规则只加载 resolvedWorkspace/AGENTS.md，独立 cwd 不自动继承原项目。通过已有 extraSystemPrompt 携带经核验的规则来源和本次快照，保留助手原生角色工作区，不复制/改写角色文件。规则来源与权限根分别管理。

证据：`../openclaw/src/agents/embedded-agent-runner/run/attempt-bootstrap-prepare.ts:119–137`、`src/plugins/runtime/types.ts:16–36`。

强隔离另行实施。准备包 MXC 2026.9.8/SDK0.8.0 的额外 readonly/readwrite 路径来自插件级 mxcPolicyPaths，没有 per-run 封套；Windows 后端拒绝可写根和只读根重叠。需要通用运行权限、文件工具、多根 bridge 和 exec/MXC 配套，不能称小 cwd patch。输入根和输出根应分离。

证据：`vendor/openclaw-runtime/win-x64/dist/extensions/mxc/dist/index.js:594,624,700,1158`。本轮只读验证包，未修改或开启用户沙盒。

## 参数热应用与产品入口

通用插件配置需新增数字类型、schema 范围、默认/当前值、类型化 IPC 和保存状态。助手 roster 归产品，用户参数按字段合并保留，不能整块覆盖。Swarm 仍用户可开关，关闭后加号菜单不出现它。

现有 reload.hotPrefixes/api.registerReload 和 runtime.config.current 支持精确参数热应用，不需单独原生 patch。所有可在运行中编辑的非秘密参数分别声明精确热路径，不能只声明并发；其他创建默认值仅影响新流程快照。service.reload.configPrefixes 会 stop/start 服务，不能用来改一个运行预算。enabled 与产品名单仍走各自生命周期，不包含在普通参数热路径。

源码与真实规划函数隔离验证结果：未声明普通参数会 reloadPlugins；精确 hotPrefixes 不重启 Gateway、不换插件、不重启服务；service configPrefixes 会重启服务。证据：`../openclaw/src/plugins/plugin-definition.types.ts:24`、`src/plugins/plugin-registration.types.ts:196`、`src/gateway/config-reload-plan.ts:302,351,407,572`、`src/plugins/services.ts:413–426`、`src/gateway/config-reload.ts:847`。

Main 当前日志 ack 失败后会强制重启 Gateway，不能沿用到无中断参数。reload.mode=off 时 config.patch/apply 自身会安排重启，也不能盲调。保存返回已生效/待生效/需重启/失败，核对原生 config hash 与插件当前有效预算；超时不自动杀长任务。

证据：`src/main/plugins/extensions/openclawExtensionImportService.ts:1271–1293`、`../openclaw/src/gateway/config-get-response.ts:29–35`、`src/gateway/server-methods/config-write-flow.ts:147`。

## Hermes 对照

官方 Kanban 提供 SQLite 任务、父依赖门禁、看板及 profile 并发限制、逐任务时限与完成协议；fleet farming 示范 N 个业务对象入队。swarm helper 构建 worker→verifier→synthesizer，未写死 8 worker。可借鉴机制，不能声称官方已实测 100×超过一小时。其 worker 是独立 OS 进程，dir 工作区明确为本机用户权限模型，目录不是任意脚本的强隔离。训练/评测 batch_runner 则不是业务 DAG。

来源：[Kanban](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban)、[fleet farming](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban-tutorial#story-2--fleet-farming)、[固定版本 swarm 源码](https://github.com/NousResearch/hermes-agent/blob/9d4dfde81721caf8e65f242e55002a35692582ba/hermes_cli/kanban_swarm.py)。

## 实验与证据强度

| 验证                                                   | 结果                                                            | 能证明什么                                                                                                           |
| ------------------------------------------------------ | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 当前插件 6 个目标测试文件                              | 157/157 通过                                                    | 当前小流程回归；不能证明新增批量功能                                                                                 |
| 当前引擎隔离 probe，实际 SQLite/FlowEngine             | 5/5 通过                                                        | 100 拒绝、两项目 6 并发、写串行、90 分钟阻塞不取消、8 项验收提示 51051 字符                                          |
| native timeout/lane 生产 helper                        | 通过                                                            | unlimited/lane 解析，不是队列性能测试                                                                                |
| native config reload 规划函数                          | 通过；注册元数据为隔离 stub                                     | 规则匹配和计划，不等于 Main→Gateway 保存链已热应用                                                                   |
| 已准备 9.8 Gateway 小流程 smoke                        | 8 次模型请求，4 节点，交付成功；全部活跃工作收敛后重启成功      | 正常推进/暂停后重启，不是运行中恢复                                                                                  |
| 新增运行中 Gateway 重启实验                            | 启动 worker 后固定模型挂起，确认 running，杀独立 Gateway 再重启 | 原生 session 为 interrupted/endedAt；agent.wait 仍 timeout；lastRunId 缺失；插件节点 uncertain，精确恢复缺口实测成立 |
| native queue helper 执行                               | 未运行成功，现有依赖缺 readFileDescriptorBounded 导出           | 环境限制；未修依赖，不声称队列实验通过                                                                               |
| 真实超过一小时、100 项公平派发、取消清理、热应用端到端 | 未做                                                            | 新接口和业务实现后必须完成发布验证                                                                                   |

可复现的正式回归命令：

```powershell
node node_modules/vitest/vitest.mjs run tests/openclaw/extensions/swarm-workflow.test.ts tests/openclaw/extensions/swarm-workflow-contract.test.ts tests/openclaw/extensions/swarm-workflow-policy.test.ts tests/openclaw/extensions/swarm-workflow-submission.test.ts tests/openclaw/extensions/swarm-workflow-plugin.test.ts tests/openclaw/extensions/swarm-workflow-management.test.ts --maxWorkers=2 --pool=forks
```

本地临时 probe 为 `.work/swarm-batch-audit/probe.cjs` 和 `native-recovery-probe.cjs`；固定实验结果在同目录 results.json，以及 `.work/native-flow-smoke-1791285618375/active-restart-audit.json`。它们不是生产实现和永久测试资产，后续应将新能力的稳定契约纳入正式测试。本轮隔离脚本首次使用了错误的 sessions.describe 参数 sessionKey，经原生 schema 拒绝后改为 key，重新完整运行成功；未把被拒绝的一次计为有效验证。

## Review 记录与实施门槛

三个 Agent 分别独立审计原生容量/时限、权限/配置、恢复/汇总；第一轮指出以下问题，已写入实施计划：

1. 原生时限不应误归为一小时；main/subagent 队列容量不能混淆。
2. 取消回执与执行收敛不同；重启/过期查询需精确原生 run 核对。
3. 独立 cwd 不是 OS 隔离；清单服务读授权和父项目规则需明确。
4. 通用数值配置尚不存在，参数同步和重启兜底会影响长任务。
5. 单项失败隔离要改服务端；有工具汇总与可分页产物索引才适配 100 项。

第二轮恢复、权限和原生容量 review 又补充：历史 attempt 的 sessionKey 不能全表 UNIQUE；缺失 settled/工具清理元数据须 unknown；全部新普通参数要精确热应用；内部快照写入与用户项目写入授权分开；owned cancel/scope 清理必须有实际接口；原生 attempt 时限不能冒充整项硬墙钟截止。这些约束已纳入计划。生产实施以 P0b 原生原型为先：验证 timeout、exact run/settled、背景命令取消/清理、节点额外派发准入，再做批次与公平调度。强隔离独立增强，不把未实现能力称为已支持。

修订后最终复核：audit_runtime_capacity、audit_batch_permissions、audit_batch_recovery 均确认本轮审阅范围没有剩余 P1/P2 方案问题；文档相对链接、源码路径、真实重启结果断言和 git diff --check 已通过。该结论只覆盖调研和方案，未证明新增接口、100 项调度、超过一小时真实执行或取消清理已实现。

# 流式、执行与恢复

与[总清单第 3–6、14–16 节](checklist.md)共同核对。
本专题是升级要求，未勾选项不表示当前已复现缺陷或目标版本已验证。

## 消息身份、Thinking 与 commentary 交接

- [ ] 对照 026/028/034：finalize hook 的 admission 在本 attempt 首字节前固定；
      普通正文不会因无关 hook 全程缓冲，真实 finalize revision 仍能撤回被拒草稿。
      经过真实订阅入口及其参数复制、事件包装和 agent/message reset 验证动态准入；
      不能只将 getter 参数直接交给底层 delivery 来代替完整订阅链路。
- [ ] 同一 Completions 源消息的 UUID/scope 在 plain、inline-only、strict 和
      structured reasoning 路径都保留。身份本身不放开私有内容或持久化门禁。
      Renderer 仅按同 scope 交接 preview/commentary，不能按相同文本或 run 顺序去重。
- [ ] 仅有明确 `assistantTextScope.commentarySnapshot: 'message'` 的累计 commentary
      在同一原生消息 scope 内按最新已接纳文本序号展示，终态 retained IDs 优先。
      非 Responses 的累计快照保留原生整条消息的过滤与 Markdown 容器，验证跨 block 的
      内部上下文标记和 fenced XML 不泄露；普通未标记前言、不同消息、Responses 和 final
      仍按各自原生身份展示，不以文本前缀或内容相等猜测归并。
- [ ] 仅真实且完整的 `message_end` 发布 retained commentary IDs；缺失事实与明确空集合
      分开处理。`text_end` 或 generic final flush 不冒充完成；最终全文 replace 不能追加到
      已由历史补入的前缀。工具回滚、Stop、异常及历史接管后，已撤回内容不复活。
- [ ] `<think>` 等 inline 标签覆盖跨包、属性、Markdown 代码与不闭合标签；
      原生 reasoning 字段保持独立，未闭合私有 Thinking 不作为正文 flush。
      reconnect 按 keyed owner 恢复，超大正文保留身份事实，不恢复 run 累计正文副本。
- [ ] 在 Chrome 侧栏实际消费 Main 转发的事件，覆盖迟订阅、累计 commentary 与分段历史
      交错、只追加未落盘尾段、完整历史接管和不同 scope 的相同文字。桌面 Stop 后侧栏
      及时停止计时，迟到进度不会复活；模型、时间和复制只出现在最后一条正文的页脚。
- [ ] 展示层按原生可见性和 `internal_system` 来源过滤内部输入，桌面、侧栏和历史接管
      保持一致，用户或助手写下相同文案仍可见。真实失败只展示一次，并保留先前有效的
      partial、工具和交付件；验证实时错误、原生终态和随后历史投影同时到达。
- [ ] 普通 MCP `image` 工具结果使用认证 `artifacts.download` 懒加载原生 artifact，核对
      物理会话、连接代次、MIME 和大小。实时缺元数据时允许既定历史补全，刷新不重复显示，
      越界、断线或 ID 失效不使用文本中的路径或 Base64 兜底。SVG 保留原始字节，工具
      图片不进入助手交付列表。
- [ ] 同一原生交付的 `MEDIA` 原件与托管副本只显示一张可用卡片，副本生成失败仍可
      打开已核实原件。仅同名但无法证明同一交付的文件分组显示，打开和下载保持独立。
      用当前会话的托管文档验证另存、旧/外部地址拒绝，播放验证单段 Range 和换会话释放。

依据：[聊天渲染](../architecture/15-chat-rendering.md)、[媒体与文件工具](../architecture/chat-runtime-presentation.md#5-媒体与文件工具)、
[028 审计](../features/execution/session-diagnostics.md)、[补丁总账](../../scripts/patches/v2026.10.7/README.md)。

## 首发、重连与整轮结算

- [ ] 普通桌面新会话的临时占位不发会话级订阅、历史或状态查询。提升为实际会话后，
      用当前认证连接、真实 sessionKey 和消息订阅确认准入；无待恢复运行时，单次委托
      首发可与 `chat.startup`／历史并行。被动子任务查询让出首条传输回执，保留发起和
      停止所需的定点核验。切会话时废弃旧结果，已有会话沿原准入流程。
- [ ] 在附件/App 上下文准备、重复 yield、等子任务回交及接收回执丢失时验证发送和 Stop。
      Stop 绑定已确认的前台运行或阻止尚未提交的准备。上一条结果不明时保留原输入身份，
      新输入仍按原生发送或排队准入，迟到旧 history/tool/ACK 不接管新草稿或当前运行。
- [ ] 自动重试仅认领有精确整轮失败证据及登记原因的前驱；测试桌面、CLI、入站 ACP、
      通用 app-server 和普通 Chrome 共用的链预算与未知 ACK，以及与 Goal 竞争时只有
      一个后继。原生回传、子任务、Team、Workflow、cron 和网页发起任务沿各自 owner。
      桌面重连用同 run/session、revision/generation、可信 `endedAt` 和原生成功
      yield/paused 证据释放现有重试认领（若返回 `stopReason`，须为 `end_turn`），
      由原生继续子任务回交。身份不明时继续核对原运行，Stop 取消未派发项。
- [ ] 验收原生子任务结算的全部已交付、部分未交付、仍有同级运行、显式 yield 及准备
      派发期间送达。只转交仍应回报的结果，检查重复唤醒和重启后的结算证据；子任务列表
      读取失败保留上次权威结果，独立验证成功空列表和旧父会话/连接响应失效。模型校验
      回归父运行的插件清单已退役，读取当前有效模型清单，实际启动仍保留父运行权限。

依据：[聊天渲染](../architecture/15-chat-rendering.md)、[自动重试](../features/execution/automatic-error-retry.md)、
[助手与子任务](../features/assistants/profiles-and-subagents.md)、[补丁总账](../../scripts/patches/v2026.10.7/README.md)。

## 已登记错误的自动续跑

- [ ] 以 [规则注册表](../../src/main/engine/openclaw/automaticErrorRetry/rules.ts)和
      [原生错误识别](../../src/main/engine/openclaw/automaticErrorRetry/failureCode.ts)为准，
      逐规则核对旧版与目标版的错误生产者、Gateway 终态、历史回执和应用匹配结果。
      对照下表在目标冻结产物上验证真实命中及相近错误不命中，报告逐条记录「仍适用 / 需适配 /
      可退役 / 未验证」、脱敏原生证据和复验结果。只有证实目标版原生已覆盖或该失败路径
      已移除，且没有留下等价的未恢复终态，才可退役对应规则。

| 当前规则 | 目标版本逐项复核 | 需确认不触发续跑的场景 |
| --- | --- | --- |
| 连续相同工具失败 `openclaw_repeated_tool_error` | 触发原生重复工具失败保护，检查同一 run 最后一条 assistant 的 `stopReason:error` 与该 `errorCode`，以及 `runtimeServices.executionFailure` 返回的精确身份与错误码。确认续跑沿用原会话但不原样重试失败调用。 | 原生在同一 run 通过改变方案恢复、单次工具失败、较早 attempt 的错误、旧 run，或用户和助手正文引用同一报错。 |
| 上下文溢出 `context_overflow` | 分别以模型 HTTP 400 `context_length_exceeded` 和工具结果后的[本地预算预检](#工具轮预检后压缩摘要为空)触发。原生恢复后仍失败时，核对 `phase:error`、`executionSettled:true`、`livenessState:blocked`、`errorObservation.failoverReason:context_overflow`，以及同轮 `executionFailure` 的精确身份和错误码为 `null`、`context_overflow` 或 `context_length_exceeded` 时的映射。 | 只有 HTTP 状态、报错正文或 `agent.wait` 失败；普通压缩失败、原生压缩已恢复、取消、超时或压缩后会话身份变更。 |
| 会话读取许可失效 `session_reader_not_current` | 核对 `Session reader operation is no longer current` 及其已知前缀、包装。若只有 `chat.error`，以精确 `agent.wait` 已结束失败及 `sessions.describe` 的 SID、revision、`lastRunId` 补证；`executionFailure` 身份匹配且无结构化错误码时，核对当前分支最后的原始输入幂等键与其后同 run 的 `run-failed-before-reply` 精确回执。续跑仍关联原始输入。 | 只有错误气泡，缺原输入或原生自定义回执，历史正文伪装成回执，或较新输入、分支和 run 已接管。 |
| 会话历史索引重建 `session_transcript_projection_rebuilding` | 核对本轮实时整轮失败的 `error` 精确为 `Session transcript projection is rebuilding: <sessionId>`，其中 SID 与本轮一致。若目标版增加原生恢复，分别验证原 run 恢复和原生仍以该错误结算。后者走共用额度，同一前驱只准入一个后继。 | 读取历史窗口变化 `Session transcript history window changed: <sessionId>`、其他 SID、普通历史查询失败、未结算、让出、超时或旧 run 被替换。 |
| 原生补答耗尽 `reply_generation_exhausted` | 用普通桌面聊天重放连续两次 HTTP 200、可见内容为空且 `stopReason:stop` 的模型响应。核对原生一次补答耗尽后，以同一 run 的已结算失败发布 `stopReason:error` 和结构化耗尽标记。用目标安装包的 Gateway 和 Main 联合验证同一物理会话的后继派发、成功后隐藏中间错误，以及原生诊断保留。 | 泛化失败文案、未联系模型的失败、尚未耗尽的空尝试、正常静默、取消和超时。 |

- [ ] 核对 `runtimeServices.executionFailure` 在目标 SDK 下仍按精确 sessionKey、SID、
      revision 和 run 读回，读取前后身份核验与 `identityMatched` 语义保持有效。读取失败或证据
      不足时保留原失败。适配新增错误码或原生文案时，保留同等原生身份和结算证明，避免
      通过通配文案、HTTP 状态或扩大重试范围补齐。验证默认阶梯等待、关闭重试、跨规则
      沿用同一额度、未知 ACK 占用额度、Stop／新输入取消未派发后继及 Goal 单后继。
      成功仅隐藏匹配的中间报错和内部反馈，保留原失败回执及已有成果，额度耗尽展示
      最后一次实际失败。

若以 `v2026.11.7` 为目标，优先核对两处源码差异。`reply-turn-admission-lifecycle.ts` 有
`Session reader operation is no longer current. Retry the turn.` 分支，当前精确匹配不接受
该变体。用目标 Gateway 分别确认 WS、wait 与历史回执实际输出。历史索引重建仍有同名异常，
`attempt-session-projection-recovery.ts` 已有原生等待后再打开的路径，分别验证原生成功接管
和失败终态仍可由应用接续。这两处的实际产物行为待验收。

### 工具轮预检后压缩摘要为空

2026-11-27 的脱敏现场日志记录了同一会话的三个运行，时间为 UTC+8。

| 运行 | 已确认的顺序 |
| --- | --- |
| 原运行 | 11:20 已收到聊天模型响应。11:26 工具结果后的 `mid-turn precheck` 拦下下一次聊天请求，`trigger=budget` 进入恢复压缩。压缩期间有 HTTP 200。11:27 原生报告 `Turn prefix summarization failed: model returned no summary text`，以 `guard_blocked` 取消提交并以 `compaction_failure` 结束。日志记录了 `runtimeServices.executionFailure` 调用成功，其响应内容和 Main 的续跑判定缺失。下一次手动输入前未见后继 `agent` 派发。 |
| 第一次「继续」 | 11:31:26、11:31:29 都收到聊天模型 HTTP 200。第一次空回复触发一次原生补答，第二次仍是 `stopReason=stop`、`payloads=0`、`tools=0`，随后耗尽并报告无回复。Main 的续跑支持已在 `59280cb3c` 合入，需验证候选安装包的编译产物实际包含该逻辑。 |
| 第二次「继续」 | 11:31:53 收到聊天模型 HTTP 200。随后执行工具，并在 11:32 再次触发预算恢复压缩。现场日志到下一条模型 HTTP 200 为止，该轮最终结算未采集。 |

锁定的 OpenClaw v2026.10.7 已用隔离 Gateway 和本地合成模型复现。先用普通聊天建立可压缩
历史，再让短输入调用工具，把结果加入模型上下文。预算预检拦下工具后的聊天请求后，第一份
整段对话摘要返回有效文本，独立的工具轮前缀摘要连续三次返回 HTTP 200 空正文。原生取消
压缩，未发起下一次聊天模型请求，并以相同物理 SID/revision 发布 `context_overflow` 的
已结算终态。精确 `executionFailure` 返回 `identityMatched:true`、`errorCode:null`，匹配现有
JustDo 续跑规则。这组隔离证据无法定位现场在错误读回、规则匹配或派发前复核的哪一步停止。

- [ ] 在候选冻结 Gateway 上重放同样的请求序列，分开计数普通聊天请求与
      `request_purpose=context_compaction`。记录预检来源、有效预算、两种摘要结果、
      是否提交原生压缩边界以及最终同轮结算。使用正常摘要作为成功对照。
- [ ] 如果候选版可在同一轮恢复，验收原生提交一次通过质量及预算校验的压缩，保留本轮用户
      请求、已结算的工具结果及调用配对，继续模型请求时不重执行已完成工具。若主摘要也为空、
      必需上下文无法保留或发生取消，核对原历史和真实失败或取消状态。另测输出长度耗尽、
      供应商错误及超时，避免把它们误作空摘要。
- [ ] 如果候选版仍取消压缩，先核对上游空前缀摘要的恢复能力，以及能否用已有的专用压缩模型
      配置和明确授权的内网模型解决。若需要调整原生恢复，评估仅在已取得有效主摘要且前缀空
      正文重试耗尽时，复用原生有界的工具轮前缀、预算和质量审查。预算无法保留该段或审核失败
      时保留原历史。提示文案、软阈值或错误归因的变化均需单独验证。
- [ ] 在候选安装包的桌面发送入口验证已结算失败后的 Main 决策。对照同一 run 的终态、
      `executionFailure` 返回值、剩余次数、会话身份和后继是否派发，区分原生已恢复、
      应用续跑已派发和应用退回失败。确有应用映射差异时才调整 JustDo，保留 Stop、
      新输入及原生身份围栏。

## 长参数与真实活动

- [ ] 对照 032 的 `toolcall_start/delta/end` → 原生 status item → WS → Renderer 链路。
      用 `tool_call → show_widget` 的长 HTML 参数验证执行前持续收到进度，不能仅测试
      直接工具或向 reducer 注入事件；参数接收期间不能错误显示无后续内容的等待提示。
- [ ] 同一长参数分别经现代 `tool_calls` 与旧格式 `function_call` 传输；后者的正式工具
      事件可延迟到终态，但实际请求活动仍需跨原生 callback、WS 和 Renderer。保活不算模型进展。
      `run-request-activity` 与 `run-stream-progress` 分别恢复，源时间不重置，通用活动不清除
      已有工具计数或阶段；取消、旧请求通知及发射失败不改变执行或 watchdog。
- [ ] 进度只保留 UTF-16 计数等闭合元数据，不解析/复制参数、正文或私有 Thinking；
      保留节流、并行调用上限、原观察时间和精确 owner/generation。
      区分生成参数、准备调用、实际执行、重试与清理；字符数不是百分比或工具成功证明。
- [ ] 主聊与 Chrome 侧聊均回归长参数、稀疏恢复、fallback、切会话和静默播报。
      原生快照可能短暂恢复旧阶段，不添加第二套执行状态库；Windows 关闭动画时仍保留产品动画。
- [ ] 覆盖长 Thinking 后 writer superseded、实时结果刷新后消失的场景，分别核对实时发布、
      原生持久化、历史截断/补全和 Renderer 恢复。已有文件成果不能证明结果已持久化，
      历史占位不能证明数据库缺记录；不通过重放工具来验证。

入口：`native-support/run-progress.mjs`、chat 的 `run-progress`/controller 测试、
真实 SDK 的 `buffered-run-progress.test.ts`，以及以下两次隔离 Gateway 验证：

```text
node tests/openclaw/runtime/chat-stream-smoke.cjs <runtime-directory> --run-progress
node tests/openclaw/runtime/chat-stream-smoke.cjs <runtime-directory> --buffered-run-progress
```

`<runtime-directory>` 必须指向本次构建的最终目标产物，不能省略或使用旧 runtime。
两种 Gateway 用例均验证执行前的实际 WS 进度、原生快照的源时间、参数完整性及精确整轮成功结算。
SDK 用例另行验证 `tool_call → show_widget` 的 70 KiB HTML 参数缓冲；Gateway 用例使用原生 `read`。
这些隔离模型验证不能替代真实内网模型完整调用链路的验证。

## 格式纠正、Goal 与问答

- [ ] 对照 029：完成且可信的派发前拒绝才进入同一原生 Agent 循环纠正，额外请求
      上限按目标版本总账核验并计入原生预算。覆盖普通 Completions 工具前 commentary
      后出现坏 JSON、显式 final 和未闭合流。区分 JSON producer 整批拒绝与 schema
      批次允许有效 siblings 执行；已完成工具不会重放，外层 attempt 不开启新纠正链。
- [ ] JSON/对象格式纠正仅准入原生事实确认的初始模型候选与完整响应，当前响应的已执行
      调用、已提交片段和执行批次均为零；有可见正文时逐块确认 commentary 身份。
      未完成流、refusal、已提交异步片段、取消、模型变更或已发生终止交付均不取得纠正机会；
      schema、未知工具及执行异常保持各自原生处理，不占用 JSON 格式纠正预算。
- [ ] 纠正反馈仅含固定类别、索引、长度与可信偏移；不带参数原文或异常预览。
      Stop、审批、超时、yield、finalize rejection 保留原生语义；子任务/Workflow
      只显示当前精确终态的有界错误，不能被普通 `summary: failed` 吞掉或泄漏私有诊断。
- [ ] 对照 031：`sessions.describe` 的 Goal continuation 前驱结算与 lastAccepted、
      sessionId/revision、原生实例、队列和子任务回交 owner 参与最终原子准入。
      普通 final 仍可能有回交，不能仅判断 yielded 或 active subagent。
- [ ] `GOAL_CONTINUATION_DEFERRED` 是提交前拒绝；超时或 ACK 失配则保留原候选 runId
      与 `identityPending`，用精确 wait/回执核对。累计 `continuationTurns` 只在接纳时增加，
      重连不重置，配置 0 禁止自动追加；Stop 和旧 revision 围栏跨退避保留。
- [ ] 工具已完成、原生补答耗尽且只产出 Thinking 或空回复时，保留真实失败终态和精确
      前驱，验证同一失败前驱只准入一个后继、工具只执行一次。对照普通失败、用户暂停和
      Stop，确保特殊失败处理不会额外恢复这些运行。
- [ ] 已交付成果的精确 Goal 自动后继先成功更新完成，再单独调用
      `finish_goal_turn({ goalId, reply: "none" })`。验证直接调用和原生 Tool Search 封装
      都可按原生 `terminate` 契约结束且不补写答复；新成果仍正常交付。普通用户回合、错误
      Goal 或 revision、Code Mode 伪结果、含非终止结果的混合批次、取消或超时不获静默结束授权。
- [ ] ask_user_question 默认启用配置的超时（当前默认十分钟）；超时返回原工具结果后
      当前轮继续。点击单题/多题弹窗的 × 取消时，开启和关闭超时两种设置都立即解除提问，清除计时器，
      不提交答案、不触发 Stop/Goal 暂停；问答结束本身不提前创建 Goal 后继轮。

依据：[Goal](../features/execution/goal-mode.md)、[交互回答](../features/chat/interactive-answers.md)、
[工具格式纠正](../architecture/05-agent-engine.md#工具调用格式纠正)及补丁总账。

## 重放拒绝与诊断

- [ ] `Persisted user turn changed before replay admission` 保留原生失败来源和错误展示。
      公开失败回执、受控 hook 的 run/trace/span 与历史证据共同诊断；普通正文或引用不能
      伪造该错误类别。当前观察仍不能精确区分全部原生抛错点。
- [ ] 诊断导出保留历史运行、晚到日志、来源/行号索引和采集缺口；部分扫描不显示完整。
      取消、切会话和窗口关闭后迟到结果不覆盖新报告。不因缺少 hook 日志断言阶段未发生，
      不新增私有 loop-exit 补丁或直接扫描 transcript。
- [ ] 右键导出独立从认证 Gateway 分页读取选定会话，覆盖未打开的会话、已截断消息补全、
      读页失败和取消，验证失败时不会产出看似完整的文件。诊断包另核对运行、请求和
      时间范围，注明原生历史或观测缺口。见[会话导出](../features/app/navigation-and-session-list.md#导出对话)。

依据：[会话诊断](../features/execution/session-diagnostics.md)。

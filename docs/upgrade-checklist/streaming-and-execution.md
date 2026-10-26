# 流式、执行与恢复

与[总清单第 3–6、14–16 节](checklist.md)共同核对。
本专题是升级要求，未勾选项不表示当前已复现缺陷或目标版本已验证。

## 消息身份、Thinking 与 commentary 交接

- [ ] 对照 026/028：finalize hook 的 admission 在本 attempt 首字节前固定；
      普通正文不会因无关 hook 全程缓冲，真实 finalize revision 仍能撤回被拒草稿。
      经过真实订阅入口及其参数复制、事件包装和 agent/message reset 验证动态准入；
      不能只将 getter 参数直接交给底层 delivery 来代替完整订阅链路。
- [ ] 同一 Completions 源消息的 UUID/scope 在 plain、inline-only、strict 和
      structured reasoning 路径都保留。身份本身不放开私有内容或持久化门禁。
      Renderer 仅按同 scope 交接 preview/commentary，不能按相同文本或 run 顺序去重。
- [ ] 仅真实且完整的 `message_end` 发布 retained commentary IDs；缺失事实与明确空集合
      分开处理。`text_end` 或 generic final flush 不冒充完成；最终全文 replace 不能追加到
      已由历史补入的前缀。工具回滚、Stop、异常及历史接管后，已撤回内容不复活。
- [ ] `<think>` 等 inline 标签覆盖跨包、属性、Markdown 代码与不闭合标签；
      原生 reasoning 字段保持独立，未闭合私有 Thinking 不作为正文 flush。
      reconnect 按 keyed owner 恢复，超大正文保留身份事实，不恢复 run 累计正文副本。

依据：[聊天渲染](../architecture/15-chat-rendering.md)、
[028 审计](../features/chat/session-diagnostics.md)、[补丁总账](../../scripts/patches/v2026.10.7/README.md)。

## 长参数与真实活动

- [ ] 对照 032 的 `toolcall_start/delta/end` → 原生 status item → WS → Renderer 链路。
      用 `tool_call → show_widget` 的长 HTML 参数验证执行前持续收到进度，不能仅测试
      直接工具或向 reducer 注入事件；参数接收期间不能错误显示无后续内容的等待提示。
- [ ] 进度只保留 UTF-16 计数等闭合元数据，不解析/复制参数、正文或私有 Thinking；
      保留节流、并行调用上限、原观察时间和精确 owner/generation。
      区分生成参数、准备调用、实际执行、重试与清理；字符数不是百分比或工具成功证明。
- [ ] 主聊与 Chrome 侧聊均回归长参数、稀疏恢复、fallback、切会话和静默播报。
      原生快照可能短暂恢复旧阶段，不添加第二套执行状态库；Windows 关闭动画时仍保留产品动画。
- [ ] 覆盖长 Thinking 后 writer superseded、实时结果刷新后消失的场景，分别核对实时发布、
      原生持久化、历史截断/补全和 Renderer 恢复。已有文件成果不能证明结果已持久化，
      历史占位不能证明数据库缺记录；不通过重放工具来验证。

入口：`native-support/run-progress.mjs`、chat 的 `run-progress`/controller 测试、
`node tests/openclaw/runtime/chat-stream-smoke.cjs <runtime-directory> --run-progress`。
`<runtime-directory>` 必须指向本次构建的最终目标产物，不能省略或使用旧 runtime。
模拟 64 KiB 参数通过不能替代真实内网模型完整调用链路的验证。

## 格式纠正、Goal 与问答

- [ ] 对照 029：完成且可信的派发前拒绝才进入同一原生 Agent 循环纠正，最多两次额外
      请求并计入原生预算；不重放此前已完成工具，不回到外层 attempt 开启新纠正链。
      JSON producer 整批拒绝与 schema 批次允许有效 siblings 执行分别验证。
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
- [ ] ask_user_question 默认启用配置的超时（当前默认十分钟）；超时返回原工具结果后
      当前轮继续。点击单题/多题弹窗的 × 取消时，开启和关闭超时两种设置都立即解除提问，清除计时器，
      不提交答案、不触发 Stop/Goal 暂停；问答结束本身不提前创建 Goal 后继轮。

依据：[Goal](../features/chat/goal-mode.md)、[交互回答](../features/chat/interactive-answers.md)、
[工具格式纠正](../architecture/05-agent-engine.md#工具调用格式纠正)及补丁总账。

## 重放拒绝与诊断

- [ ] `Persisted user turn changed before replay admission` 保留原生失败来源和错误展示。
      公开失败回执、受控 hook 的 run/trace/span 与历史证据共同诊断；普通正文或引用不能
      伪造该错误类别。当前观察仍不能精确区分全部原生抛错点。
- [ ] 诊断导出保留历史运行、晚到日志、来源/行号索引和采集缺口；部分扫描不显示完整。
      取消、切会话和窗口关闭后迟到结果不覆盖新报告。不因缺少 hook 日志断言阶段未发生，
      不新增私有 loop-exit 补丁或直接扫描 transcript。

依据：[会话诊断](../features/chat/session-diagnostics.md)。

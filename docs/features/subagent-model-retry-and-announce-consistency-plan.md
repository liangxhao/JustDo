# Subagent 模型请求恢复与 Completion 上下文一致性整改方案

## 背景

2026-08-14 的回归日志验证了现有双层并发限制和消息审计链路：

- 同一父会话并行发起 9 次 `sessions_spawn` 时，严格得到 5 次
  `accepted` 和 4 次 `forbidden`。
- native subagent 峰值运行数为 3，其余 accepted child 保持 pending。
- 消息界面的 Tool Call、父会话原始 transcript 和 Runtime 实际调用数量一致。
- completion announce 已按父会话 FIFO 执行，不存在相互重叠的模型回合。

其中 canonical branch 提升时序已在当前改动中修复，后续新会话只需实现模型请求
恢复部分：

1. 已修复：completion announce 的 canonical branch 改为在 outer delivery 完整提交
   后、FIFO 释放前提升。
2. 待实现：subagent 在模型流发生 `timeout`、`terminated` 或不完整响应时，即使当前模型
   请求没有产生 Tool Call，也会立即结束为 failed，缺少安全的同模型请求重试。

本方案不按 `taskName` 去重。同名任务在新鲜上下文中仍然合法，所有一致性判断基于
父会话、run、Tool Call、模型调用边界和 transcript 顺序。

## 事故证据

### Completion 仍可能读取旧上下文

回归中共发生 16 次 `sessions_spawn`：12 次 accepted、4 次 forbidden。12 个
accepted child 中包含 9 个目标任务、2 个合理失败重试，以及 1 个多余的 PDF
任务。

第二批已在一个 announce 回合中 accepted：

- docx retry
- pdf
- pptx
- skill-creator
- xlsx

但紧随其后的 docx completion announce 的 pre-prompt 又退回到旧的 16 条消息，
没有看到上述 Tool Call 和 Tool Result，于是再次 accepted 了一个 PDF child。

父 transcript 中可见对应 leaf control 仍指向旧的 `sessions_yield` 锚点：

```text
targetId=5374be3f
appendMode=side
```

现有 `promotePromptReleasedSideBranch()` 在 embedded run finalizer 内执行。外层
completion delivery 随后仍会写入 delivery mirror/leaf control，因此可能再次把
canonical target 恢复到旧锚点。最终 JSONL 会在更晚的回合收敛，但下一次模型 prompt
已经基于旧 leaf 启动。

### Subagent 模型异常被立即终态化

三个 child 均使用 `builtin_models/deepseek-v4-flash`，配置的 provider 请求超时为
1800 秒，subagent run timeout 为 7200 秒，但实际在远早于配置截止时间时收到：

```text
error=LLM request timed out.
rawError=terminated
decision=surface_error
next=none
```

具体结果：

- data-analysis：已完成 `read`，下一次模型请求中断，未写文件，后续新建 child
  重试成功。
- docx：已完成 `read`，下一次模型请求中断，未写文件，后续新建 child 重试成功。
- diagram-generator：已完成 `read`、`write`、`exec` 和产物验证，最终总结流异常
  收尾，Runtime 仍标记 failed，但产物完整。

当前 OpenClaw 使用整个 attempt 的 `toolMetas` 和 `assistantTexts` 计算
`canRestartForLiveSwitch`。只要 run 之前使用过任何工具，即使发生异常的当前模型请求
没有产生新 Tool Call，也禁止同模型重试。当前只配置 primary model，没有 fallback，
所以错误直接暴露为 child terminal failure。

## 目标

- 下一次 completion announce 必须在上一次 announce 的外层 delivery、Tool Call、
  Tool Result、`sessions_yield` 和 leaf control 全部提交后，使用最新 canonical
  transcript 构造 prompt。
- 对可恢复的模型传输异常，优先重试当前模型请求，而不是创建新 child 或从原始任务
  重新开始。
- 已完成的历史 Tool Call/Result 不阻止当前模型请求重试。
- 当前失败模型请求一旦产生或执行 Tool Call，不得简单重放；必须先对账并从最新
  transcript continuation。
- 不隐藏调用、不按名称去重、不放宽 021 admission 或 native lane 限制。

## 方案一：将 Completion Branch Promotion 移到完整提交边界（已实现）

### 行为要求

同一父会话的 completion FIFO 锁必须覆盖完整事务：

```text
等待前序 delivery 完成
  -> 执行 direct agent turn
  -> 提交 assistant/Tool Call/Tool Result
  -> 提交 final 或 sessions_yield
  -> 写入 delivery mirror/leaf control
  -> 提升最新 side branch 为 canonical leaf
  -> 标记 delivery 完成
  -> 释放 FIFO，唤醒下一项
```

branch promotion 不应继续放在 embedded run finalizer，因为该位置早于外层 delivery
mirror/leaf control 的最终写入。

### 实现方向

- 继续扩展 `005-history-thinking-and-subagent-yield.cjs`，不新增职责重复的补丁。
- 在 `deliverSubagentAnnouncement()` 获得 direct response 并完成外层 transcript
  提交之后、持久化 delivery success 之前执行 canonical promotion。
- promotion 必须位于现有 per-requester FIFO 锁内部。
- 使用 canonical requester session key 重新打开或刷新 `SessionManager`，从磁盘读取
  外层刚提交的最新 leaf/appendParent 状态。
- promotion 应以最新 side-branch append parent 为目标，写入新的 active leaf control；
  下一次 direct turn 重新打开 transcript 时据此构建最新 context。
- 若 Gateway 关闭、delivery 未提交、模型回合失败或 transcript 持久化失败，不提升
  branch，也不把 delivery 标记为成功；保留现有恢复重试语义。
- 删除 embedded run finalizer 中过早的 promotion/rebuild，避免双重 leaf control。

### 必须满足的不变量

- FIFO 后一项启动前，前一项的 Tool Call/Result 必须出现在其 pre-prompt。
- canonical message count 只能单调前进，不得从 19/37 等新状态退回旧的 16 条。
- delivery mirror 不能在 promotion 后再次把 active target 指回旧锚点。
- 不同父会话的 completion delivery 继续并行。

## 方案二：按“当前模型请求”安全重试

### 核心原则

不要再使用“整个 run 是否调用过工具”决定能否重试。改为记录每一次模型请求的增量：

```ts
type ModelRequestCheckpoint = {
  toolCallCount: number;
  completedToolResultCount: number;
  outboundDeliveryCount: number;
  transcriptRevision: string | number;
};
```

模型请求开始前建立 checkpoint。请求异常后只检查该请求期间发生了什么。

### 简单安全路径

当以下条件全部满足时，丢弃当前请求未完成的 assistant 流，并原模型重试一次：

1. 错误属于明确可恢复的传输异常：timeout、`terminated`、连接中断或不完整 stream。
2. 当前模型请求没有产生 Tool Call。
3. 当前没有 active tool execution。
4. 当前请求没有完成 outbound delivery、审批提示或其他不可撤销输出。
5. transcript 已成功持久化到请求开始前的 checkpoint。
6. 同一模型请求尚未执行过自动恢复重试。

之前模型请求已经完成的 Tool Call 和 Tool Result 保留在 transcript 中，不影响该路径。

伪代码：

```ts
const checkpoint = captureModelRequestCheckpoint();

try {
  return await invokeCurrentModelRequest();
} catch (error) {
  const delta = inspectModelRequestDelta(checkpoint);
  if (
    isRetryableModelTransportError(error) &&
    delta.toolCalls === 0 &&
    delta.activeToolExecutions === 0 &&
    delta.outboundDeliveries === 0 &&
    retryCount === 0
  ) {
    discardIncompleteAssistantOutputSince(checkpoint);
    return await invokeCurrentModelRequest({ retryCount: 1 });
  }
  throw error;
}
```

### 当前请求已产生 Tool Call 时

不得原样重放请求。先等待所有已发出 Tool Call 收敛：

- 每个 Tool Call 都有 terminal Tool Result：从最新 transcript 使用 continuation prompt
  继续，不重复原始用户 prompt。
- 存在 active/unknown Tool Call：等待或对账，超时后保持 failed，不能猜测结果。
- Tool Result 持久化失败：保持失败并交给恢复机制，不执行新模型请求。

continuation prompt 应明确要求：

```text
The previous model response ended because its transport stream was interrupted.
Continue from the latest transcript. Do not repeat completed tool calls unless
their recorded results explicitly show failure or missing output.
```

### 最终文本异常收尾

像 diagram-generator 这样已经生成完整最终文本、没有新 Tool Call，但 stream 缺少正常
结束标记的情况，首选策略仍是同模型重试一次。不要仅凭“文本看起来完整”直接改为 done，
除非能够验证 provider stop reason、消息结构和 transcript terminal 状态；否则容易吞掉
真正截断的回答。

### 重试预算与诊断

- 同一模型请求最多自动重试 1 次。
- 第二次仍失败时，按既有 fallback 流程处理；没有 fallback 才标记 failed。
- 日志必须包含 runId、model-call ordinal、错误分类、是否产生 Tool Call、retry decision，
  但不得记录 prompt、凭据或原始敏感内容。
- 建议增加结构化原因：`same_model_request_retry`、
  `retry_blocked_tool_call_delta`、`retry_exhausted`。

## 更强的可选保障

当前模型请求无 Tool Call 时，上述简单路径已经不会重复工具副作用。若未来要允许传输层
重放包含 Tool Call 的响应，则需要 Tool Call 执行账本：

```text
(sessionId, toolCallId) -> running | completed | failed + cached result
```

相同 `toolCallId` 再次出现时返回缓存结果，不重复执行。此项不是本轮简单修复的前置条件，
不要因此扩大实现范围。

## Patch 职责

- `005-history-thinking-and-subagent-yield.cjs`
  - completion FIFO
  - history Tool Call 保留
  - 外层 delivery 完成后的 canonical branch promotion
- `006-sessions-yield-active-guard.cjs`
  - `sessions_yield` 的活动 child 与待投递 completion 检查
  - 排除当前正在消费的 completion，确保只等待未来唤醒源
- 新的模型请求恢复逻辑优先并入与 embedded agent/failover 路径最贴近的现有补丁；若 005
  会因此同时修改过多无关 chunk，可新增一个职责单一的 patch，并在 patch guide 说明移除
  条件。不要把模型重试塞入 021 或 022。
- `021-atomic-sessions-spawn-admission.cjs` 继续只负责 per-parent admission、reservation
  和活动 child 上限。
- `022-subagent-pending-status.cjs` 继续只负责 pending/running/terminal 状态投影。

## 测试计划

### Completion canonical consistency

- 同一父会话同时收到多个 completion，确认严格 FIFO 且无模型回合重叠。
- 第一个 announce 产生 `sessions_spawn` Tool Call/Result 并 `sessions_yield` 后，第二个
  announce 的 prompt 必须包含这些新记录。
- 模拟 outer delivery mirror 和 side leaf 在 embedded finalizer 之后写入，确认 promotion
  发生在它们之后。
- canonical message count 单调递增，不回退到旧 anchor。
- 复现事故：第二批已派发 pdf 后，紧随其后的 completion 不得再次派发 pdf；测试不得
  通过 taskName 去重实现。
- delivery/persist 失败时不错误提升、不丢 FIFO 队首，恢复后仍按顺序执行。

### Current model request retry

- run 之前已经完成 `read`，下一次模型请求在零新 Tool Call 时 `terminated`：同模型请求
  自动重试一次，child 最终 done，不创建新 session。
- run 之前已经完成 `write`，最终总结请求在零新 Tool Call 时中断：重试不会再次执行
  write。
- 当前失败请求已经产生 Tool Call 且 Tool Result 已落盘：不原样重放，使用最新
  transcript continuation。
- 当前失败请求存在 active/unknown Tool Call：不启动重试。
- 当前请求产生 partial assistant text 但无 Tool Call：清理未完成片段后重试，最终历史
  不出现重复文本。
- retryable error 只重试一次；第二次失败后走 fallback/failed。
- schema、权限、billing、永久认证错误不进入该重试路径。
- 主 Agent 与 subagent 使用相同模型请求恢复规则，避免两套分叉逻辑。

### 完整验证

- 扩展补丁 fixture 和真实 bundle 形状测试。
- 对补丁执行 fresh apply、repeat apply、verify 和单锚点漂移测试。
- `npm run openclaw:bundle`
- `npm run openclaw:patches:verify`
- `npm run lint && npm run build && npm test`
- 手工并发派发 9 个任务，核对 UI Tool Call、raw transcript、Runtime admission 和
  Subagent 列表；故意中断一个无 Tool Call 的模型流，确认同一 child 自动恢复且不新增
  session。

## 验收标准

- 9 个目标任务在没有业务失败时最终只创建 9 个 child；因 provider 异常进行模型请求
  恢复时不新增 child。
- 发生明确业务失败并由父 Agent新建 child 重试时，新增 session 必须有可见的新
  `sessions_spawn` Tool Call。
- completion prompt 永远基于前一 FIFO 项完整提交后的 canonical transcript。
- 当前模型请求零 Tool Call 的可恢复传输异常不会直接把 subagent 标记 failed。
- 所有模型请求重试、阻断和耗尽决定均可通过 runId/model-call ordinal 审计。

## 非目标

- 不按 taskName、label、输出路径或自然语言任务内容去重。
- 不改变 `maxConcurrent`、`maxChildrenPerAgent` 或 ACP backend 并发语义。
- 不自动删除历史 child session。
- 不在本轮新增设置页、IPC、Redux 或 SQLite 字段。
- 不把任意 provider error 都吞掉并伪装成成功。

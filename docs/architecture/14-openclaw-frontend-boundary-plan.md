# OpenClaw 前端边界与去自定义化实施规划

## 1. 背景

GucciAI 当前定位应是 OpenClaw 的桌面前端：负责 Electron 桌面体验、配置管理、权限交互、本地 UI 数据和 Artifact 预览，而不是重新实现 OpenClaw Runtime 的会话调度、Subagent 状态机或消息历史权威层。

本规划来自一次 Subagent 回收问题排查：

- 用户在一个会话中开启 2 个 Subagent。
- 两个 Subagent 都已完成，OpenClaw child lane 显示 `active=0 queued=0`。
- Parent session 收到两个 Subagent 的 announce/handoff，但两次都表现为“已收到第 1 个祝福语，等待第 2 个”，最终主 Agent 没有继续聚合结果。
- 日志显示问题发生在 OpenClaw Subagent completion announce/handoff 语义附近，但 GucciAI 的二次封装层放大了定位和修复成本。

关键判断：

1. 不应简单归因于 OpenClaw 不成熟。
2. 更可能是 GucciAI 在 OpenClaw Gateway 外包了一层过厚的状态机，导致前端、缓存、Runtime 事件、Subagent 关系之间出现“双主数据源”。
3. 长期方向应是让 OpenClaw 作为唯一 Runtime 权威，GucciAI 回归薄前端。

## 2. 总目标

目标一句话：

> GucciAI 只做 OpenClaw 的桌面前端、配置壳、权限壳和本地 UI 数据层，不再做 OpenClaw Runtime 的二次状态机。

目标状态：

1. OpenClaw Gateway 是会话、消息历史、Subagent 生命周期、Parent/Child 关系的权威来源。
2. GucciAI SQLite 只保存本地产品数据、UI 元数据、缓存和权限审计。
3. GucciAI 不再通过自然语言 announce 内容、toolCallId 猜测、session key 猜测来判断 Subagent 状态。
4. `openclawRuntimeAdapter.ts` 从“运行时代理层”瘦身为“Gateway client + event mapper”。
5. runtime patch 数量逐步减少，最终只保留极少数 Electron/Windows/打包兼容所必需的补丁。

## 3. 架构边界

> **实现状态（2026-06）**：大部分目标已落地。openclawRuntimeAdapter.ts 已从厚重编排层收缩为 Gateway client + event mapper。Subagent 生命周期和 Parent/Child 关系以 Gateway 为权威。剩余工作集中在减少 runtime patch 数量和移除兼容性 shim。

### 3.1 OpenClaw 应负责

- Agent 执行调度
- Main/Subagent 生命周期
- Parent/Child session 关系
- Tool call 执行语义
- Session 状态
- Message history
- Thinking stream 原始事件
- Completion/result 语义
- `chat.send`
- `chat.abort`
- `chat.history`
- `sessions.list`
- session/event subscribe 能力

### 3.2 GucciAI 应负责

- Electron 主进程和窗口管理
- OpenClaw Gateway 启动、停止、连接状态展示
- Provider、MCP、skills 等配置 UI
- OpenClaw 配置同步
- Tool approval 前端交互和本地审计
- SQLite 本地产品数据
- 会话分组、重命名、置顶、最近访问
- Artifact 预览
- 文件打开、通知、托盘、deep link
- Renderer IPC 和 UI 状态

### 3.3 GucciAI 不应负责

- 自己维护 Subagent 完成数量
- 自己判断 Parent 是否该恢复
- 自己维护 Parent/Child session 权威关系
- 自己重建 OpenClaw transcript 真相
- 自己从 toolCallId/session label 猜测 child session
- 长期 patch OpenClaw Runtime 行为

## 4. 当前需要收敛的自定义层

### 4.1 Runtime patches

路径：

- `scripts/patches/v2026.5.22/`
- `scripts/patch-openclaw-runtime.cjs`

当前风险：

- patch 会让 OpenClaw 行为偏离上游。
- patch 命中情况依赖 bundle 文本结构。
- OpenClaw 升级时容易静默失效。
- 问题很难判断是 OpenClaw 原生问题，还是 GucciAI patch 后的问题。

处理方向：

- 禁止无记录新增 patch。
- 每个 patch 必须有用途、影响版本、删除条件、上游 issue/PR。
- 临时止血 patch 必须标记为 temporary。
- 中期目标是 runtime patch 数量降到 0-2 个。

### 4.2 `openclawRuntimeAdapter.ts`

路径：

- `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`

当前风险：

- 文件过大，承担了 Gateway client、event parser、状态机、history sync、Subagent 映射等多种职责。
- 内部维护大量状态映射，例如 `activeTurns`、`pendingTurns`、`visibleRunStreams`、`subagentStatus`、`toolCallIdToSessionKey`、`sessionKeyToLabel`、`toolCallIdToParentSessionId`。
- 这些状态容易和 OpenClaw Gateway 的真实状态不一致。

处理方向：

- 拆出 Gateway client。
- 拆出 event mapper。
- 只保留 CoworkEngineRouter 所需的兼容接口。
- 不再维护 Subagent 权威状态。

### 4.3 History reconciler

路径：

- `src/main/libs/agentEngine/history/historyReconciler.ts`

当前风险：

- GucciAI 同时拥有 SQLite `cowork_messages` 和 OpenClaw `chat.history`。
- `replaceConversationMessages` 容易让 SQLite 看起来像权威历史。
- 一旦 Gateway history 和 SQLite history 不一致，UI 与 Runtime 判断会分裂。

处理方向：

- OpenClaw `chat.history` 是权威历史。
- SQLite `cowork_messages` 降级为 UI cache。
- 禁止通过 SQLite transcript 参与 Runtime 行为判断。

### 4.4 Subtask history fallback

路径：

- `src/main/libs/agentEngine/history/subtaskHistory.ts`

当前风险：

- 通过 toolCallId、session key、label、parent session id 等多路 fallback 猜测 child session。
- 猜测逻辑越多，错误绑定 child session 的概率越高。

处理方向：

- UI 请求 Subagent 历史时必须携带 OpenClaw child session id。
- `chat.history(childSessionId)` 是唯一可靠来源。
- 逐步删除 fallback 猜测。

### 4.5 `cowork_subagents`

路径：

- `src/main/sqliteStore.ts`
- `src/main/coworkStore.ts`

当前风险：

- 本地表容易成为 Subagent 状态的第二套权威。
- 与 OpenClaw session lineage 不一致时，UI 可能展示错误状态。

处理方向：

- 降级为 UI cache 或迁移辅助数据。
- 不再作为 Subagent 生命周期和完成状态的权威来源。
- 最终可考虑删除，或仅保留 UI 展开状态、备注等 GucciAI 自有字段。

### 4.6 OpenClaw channel/session sync

路径：

- `src/main/libs/openclawChannelSessionSync.ts`

当前风险：

- 如果该层把 OpenClaw session key 映射成 GucciAI session 并长期保存，容易形成另一套 session graph。

处理方向：

- 只保留 UI 层所需映射。
- 不参与 Runtime 调度和完成判断。
- 所有 Parent/Child 关系以 OpenClaw Gateway 为准。

## 5. 分阶段实施计划

### 阶段 0：止血与冻结

目标：

- 先停止继续扩大自定义 Runtime 层。
- 当前用户问题可以保留临时止血，但不能继续沿这个方向堆 patch。

任务：

1. 建立 patch 元数据规范。
2. 标记当前 Subagent announce 相关 patch 为 temporary。
3. 在文档中声明 runtime patch 不能作为长期架构。
4. 新增检查清单：任何新 patch 必须写明删除条件。

建议改动：

- 新增 `scripts/patches/README.md`。
- 为每个 patch 补充头部注释：
  - Purpose
  - Affected OpenClaw version
  - Risk
  - Remove when
  - Upstream tracking

验收标准：

- 每个 runtime patch 都能回答“为什么存在”和“什么时候删除”。
- 新会话不会继续把 patch 当作默认解法。

### 阶段 1：确认 OpenClaw Gateway 原生能力

目标：

- 摸清 OpenClaw 已经提供哪些能力，避免 GucciAI 自己重复实现。

任务：

1. 梳理当前 GucciAI 调用的 OpenClaw Gateway API。
2. 确认以下能力是否稳定：
   - `chat.send`
   - `chat.abort`
   - `chat.history`
   - `sessions.list`
   - session/event subscribe
   - Subagent completion event
   - Parent/Child lineage
3. 记录每个 API 的输入、输出、是否包含 child session id、parent session id、tool call id、status、final result。
4. 如 OpenClaw 缺少结构化字段，优先形成上游 issue/PR，而不是在 GucciAI 中猜测。

建议产物：

- 新增 `docs/architecture/openclaw-gateway-capability-matrix.md`。

验收标准：

- 有一张矩阵明确：
  - OpenClaw 原生支持
  - GucciAI 当前补偿
  - 是否应删除补偿
  - 删除前置条件

### 阶段 2：SQLite transcript 降级为 UI cache

目标：

- 消除 message history 的双主数据源。

任务：

1. 标注 `cowork_messages` 的定位为 cache。
2. 打开会话时优先读取 OpenClaw `chat.history`。
3. SQLite 只用于列表摘要、搜索索引、离线缓存或 UI 快速首屏。
4. 禁止 Runtime 行为依赖 SQLite transcript。
5. 收敛 `historyReconciler.ts` 的职责。

建议改动：

- 在 store/reconciler 层增加命名和注释，区分 `authoritativeHistory` 与 `cachedMessages`。
- 将 `replaceConversationMessages` 的调用点逐步改为 cache refresh。
- 如果 UI 需要乐观更新，必须在 Gateway history 回来后校准。

验收标准：

- 会话历史权威来源只有 OpenClaw。
- 删除或禁用 SQLite messages 后，Agent Runtime 行为不受影响。
- SQLite message 缓存损坏不会导致 Parent/Subagent 状态判断错误。

### 阶段 3：Subagent 面板切换到 OpenClaw session lineage

目标：

- UI 展示 Subagent 时，以 OpenClaw child session 为中心，而不是 GucciAI 自建状态。

任务：

1. Renderer 获取 Subagent 列表时，优先走 `sessions.list(parentSessionId)` 或等价 Gateway 能力。
2. 每个 Subagent item 必须携带 OpenClaw child session id。
3. 打开 Subagent 详情时，直接调用 `chat.history(childSessionId)`。
4. `cowork_subagents` 只保存 UI cache 或 UI metadata。
5. 保留旧 fallback 一段时间，但默认路径切到 OpenClaw。

建议改动：

- 调整 Subagent IPC contract，要求 child session id。
- 修改 `subtaskHistory.ts`，新增 strict path：
  - 有 child session id：直接查 Gateway。
  - 无 child session id：只做兼容 fallback，并打 warn 日志。
- 在 UI 层减少对 toolCallId/session label 的依赖。

验收标准：

- 新产生的 Subagent 历史不再需要猜测。
- 同一 Parent 下多个 Subagent 完成时，UI 能稳定显示每个 child 的真实 history。
- fallback warn 数量在正常路径中为 0。

### 阶段 4：移除 GucciAI Subagent 状态机

目标：

- GucciAI 不再判断 Subagent 完成数量，也不再决定 Parent 是否应该恢复。

任务：

1. 审计 `openclawRuntimeAdapter.ts` 中所有 Subagent 相关状态映射。
2. 区分 UI-only state 和 Runtime state。
3. Runtime state 全部改为 Gateway event 派生，不落地为权威状态。
4. 删除或降级：
   - `subagentStatus`
   - `toolCallIdToSessionKey`
   - `sessionKeyToLabel`
   - `toolCallIdToParentSessionId`
   - 与 Parent 恢复判断相关的本地状态
5. 如果 UI 需要 loading/progress，用 Gateway status event 驱动。

验收标准：

- GucciAI 不再通过本地计数判断“还有几个 Subagent 没完成”。
- Parent 能否继续只由 OpenClaw Runtime 决定。
- 多 Subagent 并发完成不会依赖本地 arrival order。

### 阶段 5：瘦身 `openclawRuntimeAdapter.ts`

目标：

- 将大文件拆成小职责模块。

建议目标结构：

- `src/main/libs/agentEngine/openclaw/openclawGatewayClient.ts`
  - 负责 HTTP/WebSocket/IPC Gateway 调用。
- `src/main/libs/agentEngine/openclaw/openclawEventMapper.ts`
  - 负责 Gateway event 到 Cowork IPC event 的薄转换。
- `src/main/libs/agentEngine/openclaw/openclawSessionRepository.ts`
  - 负责 `sessions.list`、`chat.history` 等查询。
- `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`
  - 保留 CoworkEngineRouter 兼容外观。

拆分顺序：

1. 先抽纯函数和无状态 client。
2. 再迁移 history 查询。
3. 再迁移 event mapping。
4. 最后删除 adapter 内部重复状态。

验收标准：

- `openclawRuntimeAdapter.ts` 明显变薄，只保留编排和兼容接口。
- 单测覆盖 event mapper 和 Gateway client 边界。
- 任何新增 Gateway API 只加在 client/repository，不再塞回 adapter。

### 阶段 6：Runtime patches 上游化或删除

目标：

- 将 OpenClaw 行为修复回归 OpenClaw，而不是长期留在 GucciAI patch 层。

任务：

1. 对每个 patch 做归类：
   - Electron/Windows/打包必需
   - OpenClaw bug 临时修复
   - GucciAI 旧状态机补偿
2. OpenClaw bug 类 patch 应整理最小复现和上游 issue/PR。
3. GucciAI 旧状态机补偿类 patch，在对应状态机删除后移除。
4. 增加 patch 命中失败的构建期或启动期告警。

验收标准：

- patch 数量持续减少。
- OpenClaw 升级时能明确知道哪些 patch 仍需要、哪些可以删。
- Subagent announce 相关 patch 不再作为长期方案存在。

## 6. 推荐 PR 拆分

### PR 1：文档和边界冻结

内容：

- 新增本规划文档。
- 新增 patch README。
- 给现有 patch 增加元数据注释。

风险：

- 低。不改变运行行为。

验证：

- `npm run lint`

### PR 2：Gateway 能力矩阵

内容：

- 梳理 OpenClaw Gateway API。
- 记录 `sessions.list`、`chat.history`、Subagent event 的真实字段。
- 新增能力矩阵文档。

风险：

- 低。不改变运行行为。

验证：

- 手工运行一次包含 2 个 Subagent 的任务。
- 保存 Gateway event 样例。

### PR 3：Subagent history strict path

内容：

- UI/IPC 传递 child session id。
- `subtaskHistory.ts` 有 child session id 时只查 `chat.history(childSessionId)`。
- 旧 fallback 保留但打 warn。

风险：

- 中。涉及 Subagent 面板展示。

验证：

- 单 Subagent history 正确。
- 双 Subagent history 不串线。
- fallback warn 正常路径为 0。

### PR 4：`cowork_subagents` 降级

内容：

- `cowork_subagents` 不再作为状态权威。
- 状态展示改用 OpenClaw sessions/status。
- 本地表只保留 UI metadata 或 cache。

风险：

- 中。涉及历史会话兼容。

验证：

- 老会话仍能打开。
- 新会话 Subagent 状态来自 OpenClaw。

### PR 5：SQLite transcript cache 化

内容：

- 会话打开优先 `chat.history`。
- `cowork_messages` 只作 cache。
- 收敛 `historyReconciler.ts`。

风险：

- 中高。涉及主聊天历史展示。

验证：

- 新会话流式展示正常。
- 重启应用后历史正常。
- 删除 SQLite message cache 后能从 OpenClaw 恢复。

### PR 6：拆薄 `openclawRuntimeAdapter.ts`

内容：

- 抽 Gateway client。
- 抽 event mapper。
- 抽 session repository。
- 删除 adapter 中不再需要的本地状态。

风险：

- 高。需要小步提交。

验证：

- 现有 adapter 单测通过。
- 新增 mapper/client 单测。
- 手工验证普通会话、权限请求、Subagent、abort、history reload。

### PR 7：删除临时 runtime patch

内容：

- 删除 Subagent announce 相关临时 patch。
- 或在 OpenClaw 上游修复后升级 OpenClaw。

风险：

- 中。依赖 OpenClaw 原生修复或 GucciAI 不再依赖该路径。

验证：

- 复现最初的 2 Subagent 场景。
- 两个 child 完成后 Parent 能继续聚合。
- 日志中无重复“已收到第 1 个，等待第 2 个”的错误循环。

## 7. 测试计划

### 7.1 自动化测试

每个阶段至少运行：

```bash
npm run lint
npm test
```

针对 adapter 拆分和 history/subagent 改造，增加或更新：

- `src/main/libs/agentEngine/openclawRuntimeAdapter.test.ts`
- event mapper 单测
- Subagent history 单测
- Gateway capability mock 单测

### 7.2 手工回归场景

必须验证：

1. 普通单轮会话。
2. 多轮继续会话。
3. 工具调用权限请求。
4. 用户拒绝权限。
5. 用户授权一次。
6. 用户授权 session scope。
7. 单 Subagent。
8. 两个并发 Subagent。
9. Subagent 完成后 Parent 聚合结果。
10. Abort 正在运行的会话。
11. 重启应用后打开历史会话。
12. OpenClaw Gateway 重启后重新连接。

### 7.3 原始问题复现用例

任务示例：

> 开 2 个 subagent，分别写一句祝福语，全部完成后由主 agent 汇总到一个结果里。

通过标准：

- 两个 child session 都完成。
- Parent session 能识别两个结果。
- Parent session 继续输出最终汇总。
- UI 中两个 Subagent 的历史分别正确。
- 日志中没有 Parent 重复把第二个结果当作第一个结果。

## 8. 风险与缓解

### 风险 1：OpenClaw Gateway 缺少结构化字段

表现：

- `sessions.list` 不包含 parent/child。
- completion event 不包含 child session id。
- final result 只能从自然语言 announce 中解析。

缓解：

- 不在 GucciAI 中继续扩大猜测逻辑。
- 形成最小复现。
- 推动 OpenClaw 增加结构化字段。
- 短期 fallback 必须有 warn 和删除条件。

### 风险 2：历史会话兼容

表现：

- 老会话只有 SQLite 记录，OpenClaw history 不完整。

缓解：

- 老会话可继续使用 SQLite fallback。
- 新会话默认使用 OpenClaw history。
- 在代码中区分 legacy path 和 canonical path。

### 风险 3：大文件拆分引入回归

表现：

- `openclawRuntimeAdapter.ts` 拆分后 event 顺序或 IPC 行为变化。

缓解：

- 先抽无状态函数。
- 保持对外接口不变。
- 每次只迁移一个职责。
- 增加 event fixture 单测。

### 风险 4：临时 patch 移除过早

表现：

- 原始 Subagent 问题再次出现。

缓解：

- patch 删除必须放到最后。
- 删除前先确认 OpenClaw 上游修复或 GucciAI 不再依赖该 announce 路径。

## 9. 新会话实施检查清单

新会话开始时建议按以下顺序读取：

1. `build.log`
2. `docs/architecture/14-openclaw-frontend-boundary-plan.md`
3. `docs/architecture/04-cowork-system.md`
4. `docs/architecture/05-agent-engine.md`
5. `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`
6. `src/main/libs/agentEngine/history/historyReconciler.ts`
7. `src/main/libs/agentEngine/history/subtaskHistory.ts`
8. `src/main/coworkStore.ts`
9. `src/main/sqliteStore.ts`
10. `scripts/patches/v2026.5.22/`

新会话不要直接做大规模删除。推荐第一步：

1. 给 patch 增加元数据。
2. 写 Gateway capability matrix。
3. 找出 Subagent UI 到 child session id 的最短链路。

## 10. 非目标

本规划不要求：

- 替换 OpenClaw。
- 重写 Cowork UI。
- 删除 SQLite。
- 删除权限系统。
- 删除 skills 系统。
- 立即删除所有 runtime patches。

本规划要求：

- 明确 OpenClaw 是 Runtime 权威。
- 明确 GucciAI 是前端和产品壳。
- 所有二次 Runtime 状态都必须有删除路线。

## 11. 最终验收标准

完成本规划后，应满足：

1. 普通会话、Subagent、history、abort、permission 都正常工作。
2. 多 Subagent 并发完成后 Parent 能稳定恢复。
3. GucciAI 不再维护 Subagent 完成计数。
4. GucciAI 不再通过猜测 toolCallId/session label 绑定 child history。
5. SQLite transcript 损坏不会影响 OpenClaw Runtime 行为。
6. runtime patch 有清晰数量、用途和删除条件。
7. `openclawRuntimeAdapter.ts` 职责清晰，新增 OpenClaw API 不再继续堆入同一个大文件。


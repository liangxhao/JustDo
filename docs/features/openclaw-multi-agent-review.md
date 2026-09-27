# OpenClaw v2026.9.6 多 Agent 能力复核

本复核以本仓库锁定的 OpenClaw v2026.9.6 和 `../openclaw` 源码为准。长期助手、任务内平级协作、原生 SubAgent、ACP 子会话有不同的生命周期，不能只因它们都有 sessionKey 就合并持久化或 UI。

后续三路独立审核的完整范围、问题证据和验收边界见 [SubAgent 与 Multi-Agent Team 全链路审核](multi-agent-audit-2026-09-27.md)。以下为能力概览，不代表真实 Gateway 已全面验收。

## 结论与本次适配

| 能力          | 上游接口及行为                                                                      | JustDo 状态与决定                                                              |
| ------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 长期助手      | `agents.create/update/files`；各 agent 有独立 workspace、状态与 SQLite 会话库       | 保留产品档案映射和原生角色文件。软删除仍保留原生身份及历史。                   |
| 平级会话通信  | `sessions_send`；`tools.sessions.visibility` 和 `tools.agentToAgent` 决定普通可见性 | 继续由 `agent-team` 为同一任务的指定成员授予一次性发送权限，记录真实原生回执。 |
| 原生 SubAgent | `sessions_spawn`、`subagents`、`sessions_yield`、任务完成通知；键含 `subagent:`     | 保留子任务视图。子会话发送交还上游所有权判断，不进入平级预算。                 |
| ACP 子会话    | `sessions_spawn(runtime: "acp")`；键含 `acp:`                                       | 本次修复了扩展误拦截父会话向 ACP 子会话发送的问题。仍由原生权限判断是否允许。  |
| 任务图与正文  | 上游维护 transcript 与 inter-session provenance                                     | 产品只存关系、状态和回执，按 receipt 精确读取原生消息。                        |
| 委派模式      | `subagents.delegationMode` 的 `suggest/prefer` 只改变提示词                         | 现有运行时设置已可配置并投影；不把它当作工具授权。                             |

## 接口核对

1. `openclaw/plugin-sdk/routing` 同时导出 `isSubagentSessionKey` 与 `isAcpSessionKey`。`getSessionEntry`、`registerScopedAccessProvider`、`before_tool_call`、`after_tool_call` 在锁定源码中仍存在。继续使用公开 SDK 出口。
2. hook 提供可信的 `ctx.sessionKey/runId/toolCallId`。扩展先向 Main 请求 admission，钉住目标物理 `sessionId`，再让原生 `sessions_send` 执行。`timeoutSeconds: 0` 与 `watch: false` 使发送异步返回；`accepted` 只表示接收，不能解释为完成。
3. 新版 `tools.agentToAgent` 默认开启，`tools.sessions.visibility` 默认 `all`。JustDo 默认 `tree`，房间发送靠 scoped access provider。不能把默认设置改成 `all` 来代替房间授权，否则跨任务读取和发送范围会扩大。
4. 上游对 requester-owned SubAgent 和 ACP child 在 `tree`/`all` 下有跨 agent 的所有权例外。两处协作 hook 现在一致避让两种子会话；仅识别键类型不授予权限，最后仍由上游检查目标归属。
5. `agents team create` 是 CLI 预设：创建 coordinator、researcher、writer、reviewer 与角色契约，并配置 `subagents.allowAgents`。它不了解 JustDo 的受管档案、软删除、room 或产品会话归属，不能直接对现有用户配置执行。

## 新能力接入顺序

### 原生临时委派：现有路径可用，已完善引导

`sessions_spawn` 适合研究、编码和审查等有结束点的内部工作。新版支持 `context: "isolated" | "fork"`、`completionTarget: "parent"`、任务名、进度及成组等待。`agent-team` Skill 现在说明如何选择原生子任务或长期平级助手，并明确 ACP 子会话不进入协作图。现有设置已开放并投影子任务并发、深度、超时、模型、思考级别及委派模式；聊天工具展示也识别 `agents_wait`。仍须以真实模型运行验证完成通知、恢复和停止在子任务视图中的表现。

### 受管长期助手作为原生委派目标：自动投影已撤回

上一轮自动生成 `subagents.allowAgents` 的改动已撤回：助手软删除和模型创建未同步该名单，会产生配置漂移；它也遗漏了嵌套 ACP 委派目标。后续接入须先覆盖创建、禁用、软删除、回滚和运行中授权。原生跨角色模型仍遵循目标 `subagents.model`、全局子任务模型、目标档案模型的优先级；隐藏 SubAgent 默认只注入 AGENTS.md，不能宣传为完整继承助手所有角色文件。详见完整审核报告。

### 原生可见子会话与 worktree：独立产品决策

`sessions_spawn({visible:true})` 创建可继续交互的独立会话，可带 `group`、`worktree` 和项目选择。JustDo 侧边栏、删除和导出目前按自有会话模型管理。直接启用会产生未纳入产品导航与清理流程的会话。内部并行工作继续使用隐藏 SubAgent；若接入，先建立原生可见会话到产品会话的身份映射、恢复、停止与删除规则。

### 上游 team preset：借鉴角色契约，避免原地导入

预设的职责、交付物、审批和升级规则可作为新建助手模板参考。导入 CLI 产生的 agent 需要解决 id 冲突、workspace 与产品档案同步、模型继承、受管配置覆盖、软删除及历史保留。现阶段不从应用中执行 `agents team create` 并假定产品已接管这些身份。

## 验收清单

- 开关两态下，父会话向自己的 SubAgent 与 ACP 子会话发送；插件不消费平级预算，原生权限仍拒绝非己所有的目标。
- 同 room 长期成员的 `sessions_send` 有精确 sessionKey、物理 sessionId 和真实接收 runId；跨 room、重置目标、停止后的迟到发送被拒绝。
- 禁用扩展后历史回执可读，平级发送被拒绝，原生子会话消息仍按 OpenClaw 规则运行。
- 真实 Gateway 下检查 `agents.create/update/files`、原生历史索引、计划模式、重启恢复、停止和部分失败删除。单元测试不能证明模型自主协作质量。

源码参照：`../openclaw/docs/gateway/config-tools/sessions-and-subagents.md`、`../openclaw/docs/tools/subagents/tool-reference.md`、`../openclaw/docs/tools/acp-agents.md`、`../openclaw/docs/concepts/multi-agent.md`、`../openclaw/src/plugin-sdk/routing.ts`。产品现有设计见 [长期助手与任务内协作](assistants-and-collaboration.md)。

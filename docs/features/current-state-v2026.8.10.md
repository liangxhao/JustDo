# v2026.8.10 当前实现状态

本文是近期功能变更的实现级总览，不是路线图。如果本文与旧的 plan 文件冲突，
应以当前代码、测试和本文描述的状态为准；领域细节仍以架构文档为准。

## 产品边界

JustDo 是 OpenClaw Gateway 的桌面前端和本地控制面：

- Gateway 拥有 Agent 执行、会话历史、subagent、Skills runtime、cron runtime 和原生命令语义。
- JustDo 拥有 Electron 生命周期、窗口/托盘、权限交互、插件管理、本地配置、SQLite UI cache、
  定时任务结果收件箱和聊天展示。
- Renderer 只能通过 `window.electron` 访问本地能力；它不读 SQLite、runtime 文件或 Gateway token。
- `chat.history` 是执行历史权威；SQLite 的 `cowork_messages` 是首屏和故障降级缓存。

## v2026.8.10 已落地的主要变化

### 持续目标执行

OpenClaw 的 Goal 是生命周期权威，JustDo 只负责展示和连续派发协调：

- Goal 状态覆盖 `active`、`paused`、`blocked`、`usage_limited`、`budget_limited` 和 `complete`。
- UI 显示目标、当前执行阶段、暂停/继续/确认完成等控制。
- 自动续跑复用原 Session、Agent 和模型，不在 SQLite 复制 Goal，也不创建本地预算系统。
- 连续两轮只有 `get_goal` 或文本、没有具体工具进展时触发安全熔断。
- Gateway 断连、应用退出或 runtime 代次变化会清理本地执行快照。

详见 [05-agent-engine.md](../architecture/05-agent-engine.md) 和
[15-chat-rendering.md](../architecture/15-chat-rendering.md)。

### 会话与 subagent

- 会话列表支持分组、最近会话展示和运行状态聚合；主会话、announce 和整个 subagent 后代树共同
  决定会话是否仍在运行。
- subagent UI 展示稳定的 Gateway `sessionKey` 和 `sessionId`，可复制 session ID，并在独立抽屉中
  通过同一套聊天渲染管线查看其历史。
- 子会话的父级关系来自 Gateway 元数据和 `spawnedBy` 回退解析，不从 tool output 文本猜测。
- Stop 必须等待父会话、运行中的子会话和待处理审批都被确认清理后，才把 UI 收敛为 idle。

### 会话级权限

- Cowork 会话持久化 `ask`、`auto`、`full` 三档权限，缺失或非法值回退到 `full`。
- Gateway 使用全局 runtime 权限快照；打开会话不切换权限，发起新 turn 前才激活该会话权限。
- 权限修改通过公开 Gateway 配置和 approvals API 热更新，并使用 `baseHash` 做并发保护。
- 定时任务不继承交互会话的临时授权，也不会根据可伪造的 cron session key 自动提权。
- JustDo 不创建或直接写入 `permission-policy.json`、`exec-approvals.json`。

详见 [10-data-storage.md](../architecture/10-data-storage.md) 和
[11-security-model.md](../architecture/11-security-model.md)。

### 原生 cron 与应用内结果

- Agent 对定时任务的创建、修改、启停和删除统一使用 Gateway 原生 `cron` tool；不会用
  `sessions_spawn`、sleep、后台进程或 CLI 模拟调度。
- UI CRUD 和手动运行仍通过 Main 的 `CronJobService` 调用同一个 Gateway cron runtime。
- 运行结果同步到 SQLite 收件箱，支持分页、未读数、已读回执、运行会话跳转和单条删除。
- 任务省略 delivery 时由 runtime patch 归一为应用内 `{ mode: "none" }`；显式 announce/webhook
  不被静默改写。
- 删除结果会递归清理专属 cron session、transcript 和 Gateway state SQLite 中精确匹配的
  `cron_run_logs`，共享主会话不会被误删。

详见 [08-scheduled-tasks.md](../architecture/08-scheduled-tasks.md)。

### 插件和内置 Skill 目录事务

- Extensions、Skills、MCP、Hooks 和 Marketplace 仍由 Plugins 页面统一管理，但运行时能力权威属于 Gateway。
- Skill 与 Extension 文件变更共用 `ManagedDirectoryOperationCoordinator` 串行队列。
- 事务流程包含 stage、backup、atomic publish、失败回滚、Windows ACL 修复、重试和结构化错误分类。
- Skill 热加载不停止 Gateway；Extension 包变更按需停止并恢复 Gateway。
- Windows 锁诊断会过滤 JustDo 自身进程和受管 Gateway，只向用户报告可关闭的外部占用进程。
- 当前 `resources/builtin-skills.json` 声明 7 个内置 Skill，全部默认启用；OpenClaw 默认 Skill 被禁用。

详见 [07-plugin-system.md](../architecture/07-plugin-system.md)。

### 模型请求和服务同步

`builtin_models` LiteLLM 的 OpenAI Chat Completions 请求现在携带用途和关联元数据；
自定义或其他 strict-compatible provider 保持上游原始 payload：

| 用途         | `metadata.request_purpose` | 说明                      |
| ------------ | -------------------------- | ------------------------- |
| Agent turn   | `agent`                    | 普通执行请求              |
| 上下文压缩   | `context_compaction`       | safeguard/compaction 请求 |
| Exec review  | `exec_review`              | 自动审核请求              |
| 标题生成     | `title_generation`         | 会话标题请求              |
| 模型连接测试 | `connection_test`          | 设置页最小测试请求        |

关联会话使用 `metadata.session_id`；subagent 额外使用直接父级 `metadata.parent_session_id`。
只有真实用户直接发起的顶层首个请求标记 `metadata.user_initiated=true`，自动续跑、系统
provenance、同一 turn 后续请求和 subagent 不携带该标记。

内置模型客户信息同步在应用启动时执行，之后默认每 24 小时执行一次；读取用户信息失败、网络失败
或服务端拒绝都不会阻塞应用启动，也不会把 API key、认证 header 或完整用户凭据写入日志。

### 打包与离线运行

- Windows 离线运行环境使用更精简的 MinGit 和 bundled npm/Python runtime。
- OpenClaw runtime、内置 Skill 和平台资源在打包阶段同步，避免旧 Skill 文件残留。
- Windows 使用 `win-resources.tar` 与 unpack 脚本；macOS/Linux 通过 extraResources 提供 runtime。
- 构建流程增加 runtime patch 和最终 bundle 的一致性校验，防止产物漏应用 patch。

详见 [12-tech-stack.md](../architecture/12-tech-stack.md) 和
[openclaw-patch-guide.md](../patches/openclaw-patch-guide.md)。

## 当前仍不是已完成能力

- 当前 OpenClaw `v2026.7.1-2` runtime 已包含 browser extension driver 与 relay，且打包策略保留
  `browser` extension；JustDo 尚未交付配对、状态 IPC 和发布流程，因此浏览器设置文档仍是设计和
  前置条件，不代表扩展路径已上线。
- 内置模型登录/退出生命周期已有 Main 协调入口，但认证 handler 尚未接入；该文档仍是集成契约。
- 权限文档中的 packaged-runtime 文件工具 smoke、可信 cron run attestation 和隔离执行环境仍是后续
  安全增强。
- Runtime patches 仍是版本锁定的兼容层，不应继续把 Gateway 业务语义复制到 JustDo。

## 代码入口

| 领域          | 主要入口                                                                                                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Goal          | `src/main/openclaw/goals/goalContinuationCoordinator.ts`、`src/shared/sessionGoal.ts`                                                                                                     |
| 会话/subagent | `src/main/engine/openclaw/subagentGateway.ts`、`src/renderer/features/cowork/components/Subagent*`                                                                                        |
| 权限          | `src/main/openclaw/permissions/sessionPermissionModeCoordinator.ts`、`src/main/ipc/cowork/config.ts`                                                                                      |
| Cron          | `src/main/scheduler/cronJobService.ts`、`src/main/scheduler/scheduledTaskResultSyncService.ts`                                                                                            |
| 插件文件事务  | `src/main/core/managedDirectoryOperations.ts`                                                                                                                                             |
| 请求元数据    | `src/main/engine/openclaw/openclawRuntimeAdapter.ts`、`scripts/patches/v2026.7.1-2/026-parent-session-identity.cjs`、`027-agent-request-metadata.cjs`、`028-request-purpose-metadata.cjs` |
| 客户同步      | `src/main/core/customerRegistrationService.ts`                                                                                                                                            |
| 模型连接测试  | `src/renderer/features/settings/modelConnectionTest.ts`                                                                                                                                   |

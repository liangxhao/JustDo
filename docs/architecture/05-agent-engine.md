# Agent Engine 与 OpenClaw 集成

JustDo 当前只有一个 AI 执行引擎：OpenClaw Gateway `v2026.6.11`。Main 进程负责启动、停止、配置同步和状态展示，任务执行由 Gateway 完成。

## 关键文件

| 文件                                                    | 作用                                  |
| ------------------------------------------------------- | ------------------------------------- |
| `src/main/openclaw/runtime/openclawEngineManager.ts`    | Gateway runtime 生命周期              |
| `src/main/openclaw/config/openclawConfigSyncService.ts` | 配置同步服务                          |
| `src/main/openclaw/config/openclawConfigSync.ts`        | provider/MCP/hooks/extension 配置生成 |
| `src/main/engine/openclawRuntimeAdapter.ts`             | Cowork 到 Gateway 的 adapter          |
| `src/main/engine/gateway/sessionRpc.ts`                 | Gateway session RPC helper            |
| `src/main/cowork/providerApiConfig.ts`                  | provider 配置解析                     |
| `src/main/cowork/builtinModelProvider.ts`               | 内置模型 provider 同步                |
| `src/main/cowork/builtinModelLifecycle.ts`              | 登录/退出模型与 OpenClaw 同步协调     |
| `src/main/openclaw/models/openclawAgentModels.ts`       | Agent 模型引用解析                    |
| `src/main/ipc/openclaw/engine.ts`                       | engine IPC handlers                   |

## Runtime 生命周期

```mermaid
stateDiagram-v2
  [*] --> idle
  idle --> downloading: runtime missing
  downloading --> installing: package downloaded
  installing --> ready: install complete
  idle --> ready: runtime exists
  ready --> starting: startGateway()
  starting --> running: port/token ready
  running --> stopping: stopGateway()
  stopping --> ready: process exited
  downloading --> error: download failed
  installing --> error: install failed
  starting --> error: process failed
  running --> error: unexpected exit
  error --> starting: restartGateway()
  error --> downloading: force install
```

Renderer 可以通过 `openclaw.engine.getStatus()` 和 `openclaw.engine.onProgress()` 展示状态。

## 启动流程

`src/main/main.ts` 中的主流程：

1. 初始化 SQLite。
2. 初始化 provider/config getter，并恢复保存的系统/自定义代理路由。
3. 通过已恢复的代理路由，以显式 `enabled` 访问状态刷新内置模型 provider。
4. 绑定 Cowork runtime forwarder。
5. 同步 OpenClaw config。
6. 启动 OpenClaw Gateway。
7. Gateway ready 后启动定时任务 polling。

```mermaid
sequenceDiagram
  participant Main as main.ts
  participant DB as SQLiteStore
  participant Config as OpenClawConfigSyncService
  participant Manager as OpenClawEngineManager
  participant Adapter as OpenClawRuntimeAdapter
  participant Cron as CronJobService
  participant UI as Renderer

  Main->>DB: initStore()
  Main->>Main: syncBuiltinModelProvider(enabled)
  Main->>Adapter: bind runtime forwarder
  Main->>Config: syncConfig(startup)
  Main->>Manager: startGateway()
  Manager-->>UI: engine progress events
  Manager-->>Main: running(port/token)
  Main->>Cron: startPolling()
  Main-->>UI: ready status
```

## 配置同步

JustDo 本地配置包括：

- provider/model 配置
- Agent 默认模型和技能
- MCP servers
- OpenClaw hooks
- Ask-user extension 配置
- 本地 skill 文件状态

这些配置通过 `OpenClawConfigSyncService` 写入 Gateway 可读取的配置位置。Gateway
运行时使用 OpenClaw 默认的 `hybrid` reload 策略：模型、Agent、MCP、Hook 和插件
启用配置优先原地热更新，Gateway 自身配置等不支持热更新的字段由 Gateway watcher
触发 restart。

JustDo 管理的配置默认写入 `tools.experimental.planTool: true`，使支持结构化
tool calling 的模型可以调用 OpenClaw 原生 `update_plan`。该能力仍由 Gateway
定义协议和执行语义；JustDo 不注册同名 MCP tool、不增加 provider allowlist，也不
通过 runtime patch 模拟计划更新。配置合并 `sandbox` 和 `loopDetection` 时必须保留
`tools.experimental`、既有 deny 列表和 web 配置。

JustDo 同时启用 OpenClaw 原生 `tools.toolSearch.mode: "directory"`，并通过
`010-defer-selected-tool-schemas.cjs` 将其 catalog predicate 收窄到显式名单，目前为
原生 `browser`、`cron`、`get_goal`、`create_goal`、`update_goal`、`memory_search`
和 `memory_get` tool。其他授权工具仍直接暴露；普通请求只看到精简目录项和 Tool Search
控制工具，相关请求则由 Gateway 加载对应完整 schema。工具最终仍通过 Gateway 的正常
权限、审批、Hook、日志与 telemetry 路径执行，JustDo 不实现绕过 schema 校验的代理
tool。OpenClaw 提供受支持的 per-tool defer 名单后，应删除此版本级 patch 并改用原生
配置。

JustDo 通过受支持的 `agents.defaults.compaction` 配置启用 OpenClaw 内置
`compaction-safeguard` hook，而不复制压缩引擎。策略借鉴 Codex 的 continuation
handoff 思路：摘要强调用户意图、约束、已验证进度、未完成事项和精确标识符；关闭会
重复占用 16,000-character 摘要预算的 preserved-turn suffix。OpenClaw 的结构化质量
校验会强制恢复其 `##` 模板，因此 Codex 模式下关闭该校验。配置刻意不写
`keepRecentTokens`：自动压缩仍继承 OpenClaw 的安全 recent-tail
默认值，而手动 `/compact` 会启用 `v2026.6.11` 的强化边界，真正丢弃旧工具结果，
形成接近 Codex 的“用户原话 + 摘要”检查点。mid-turn precheck 会在长工具循环中提前
检查上下文压力。

OpenClaw 的公开 compaction provider 可以替换摘要，但拿不到当前模型认证；公开
`before_compaction` / `after_compaction` hook 又不能修改压缩结果。因此
`012-retain-user-messages-across-compaction.cjs` 只补足原生 hook 无法表达的一层：
从整个压缩前有效分支提取真实 user 文本，在 compaction details 中跨轮滚动保存，并在
后续模型上下文中重放。完整性标记让重复压缩只追加上次边界之后的新输入，并能从旧版
不完整 metadata 补收 recent tail 中的用户原话。手动压缩的顺序是“用户原话 → 摘要”；
自动或 mid-turn 压缩则只回放 native recent tail 之前的用户原话，再接上 OpenClaw 为
安全连续执行而保留的 recent tail，避免 tail 内用户输入重复。用户原话预算与 Codex
一致，约为 20,000 tokens；超限时优先保留较新的完整输入，只截断最老的边界输入。摘要生成仍
完全走 OpenClaw 原生 safeguard hook，但会把 cut point 后的 user、assistant 和 tool
消息按原顺序追加到摘要材料。split-turn 会保持“旧历史 → turn prefix → recent
suffix”顺序，避免 tool result 排在对应 tool call 之前；重复压缩继续以 previous
summary 为基础，再合并本轮全部新回复。Tool result 和 bash output 单条最多保留 6,000
characters，每段摘要输入合计最多保留 24,000 characters；从最新结果向前分配预算，超额的旧
结果合并成一个有界省略标记。这确保最后一条用户消息和最近助手回复参与摘要，而大型
工具输出不会挤占全部摘要上下文。对升级前已经存在、尚无 retention metadata 的
compaction entry，重放层会从 JSONL 中仍保留的旧 message entries 回填一次用户原话。

`013-codex-compaction-template.cjs` 替换 SDK 内建的首次、重复和 split-turn 摘要提示词、
摘要 system wording 与回放前缀，并旁路 safeguard 强制的 `## Goal` / `## Progress`
等结构与诊断后缀。用户原话仍由 `012` 作为独立 user 消息重放，不重复塞入 summary
正文；assistant thinking 随完整 assistant 消息参与摘要，压缩后只保留其归纳结果。

`012` 和 `013` 都是仅针对 OpenClaw `v2026.6.11` 生成 bundle 的精确文本 patch，并
故意在锚点变化时失败。升级 OpenClaw 时不得把它们原样复制到新版本目录：先检查上游
是否已提供用户原话重放、可替换摘要模板和 replay wrapper；仍需 patch 时，必须根据
新 bundle 重新定位并重写锚点，再分别验证手动、threshold/overflow、mid-turn、重复
压缩和 split-turn。`../openclaw` 只用于源码比对，不参与 JustDo 打包。

配置应用按所有权明确分为四类：

| 变化                                                                         | 应用方式             | 生命周期所有者 |
| ---------------------------------------------------------------------------- | -------------------- | -------------- |
| `meta`、`tools`、`skills`、`session` 等动态读取字段                          | 无进程重启           | OpenClaw       |
| models、Agent、Hook、cron、MCP、普通插件配置                                 | 原生热更新           | OpenClaw       |
| `models.pricing`、`plugins.load`、`plugins.installs`、`gateway`、`discovery` | Gateway 内部 restart | OpenClaw       |
| child process secret 环境或 Extension manifest/tool contract                 | stop/start 硬重启    | JustDo         |

同步服务在写配置前记录 reload generation，并用 Gateway 日志中的 changed paths
把 hot reload、restart acceptance 关联到正确代次。restart acceptance 只是中间状态，
必须等 Gateway 再次 ready 才放行新会话；等待预算覆盖 OpenClaw 的 workload drain 和
Gateway 启动时间。原生应用失败或超时才回退到 JustDo 硬重启。延迟硬重启同时绑定
Gateway process generation；若等待期间用户已停止 Gateway 或其他路径已替换进程，
旧 restart intent 会被丢弃，不会复活或重复重启 Gateway。仅 session store 变化不触发
任何 Gateway restart。

## 模型引用

Agent 模型引用由 `resolveQualifiedAgentModelRef()` 规范化，避免同名模型在多个 provider 中歧义。Main 启动时会 backfill 空模型并迁移可确定的旧模型引用。

## Runtime 资源

相关 npm scripts：

- `openclaw:runtime:host`
- `openclaw:runtime:win-x64`
- `openclaw:runtime:mac-arm64`
- `openclaw:runtime:linux-x64`
- `openclaw:bundle`
- `openclaw:plugins`
- `openclaw:resources`
- `openclaw:precompile`
- `openclaw:prune`

## 约束

- 不引入第二个 Agent engine。
- 不让 renderer 直接管理 Gateway process。
- Runtime patch 必须小、可审计、可删除，并遵守 `scripts/patches/README.md`。
- OpenClaw 行为差异优先向上游修复，JustDo patch 只作为兼容层。

## 组件分工

### `OpenClawEngineManager`

Engine manager 是 Gateway process 的唯一生命周期 owner。它负责：

- 解析 runtime 路径。
- 检查 runtime 是否可用。
- 下载/安装/同步 runtime。
- 启动 Gateway child process。
- 缓存 port/token/status。
- 停止或重启 Gateway。
- 向 Main 进程发出 status event。

Renderer 只能看到抽象状态，不能拿到 process handle。

### `OpenClawConfigSyncService`

Config sync service 把 JustDo 本地配置转换为 Gateway 可读配置。它的输入来自多个 store/service：

- Cowork/Agent store。
- Provider API config。
- MCP store。
- Hook store。
- Extension ask-user config。
- Gateway runtime manager。

同步时要考虑 Gateway 是否正在运行：

- 启动前同步：直接写配置。
- 普通 `openclaw.json` 变化：等待 Gateway watcher 完成热更新或自主 restart；等待失败时才回退到硬重启。
- 子进程 secret 环境变量或 Extension manifest 变化：由 JustDo 硬重启，因为运行中的
  child process 和已加载 manifest 无法通过普通配置热更新替换。
- 仅 managed session store 修复：不重启 Gateway。
- 有活跃 workload：避免无提示打断正在执行的会话。

Engine manager 从 Gateway reload 日志维护同步代次。会话执行在配置写入后等待对应代次
完成，避免 watcher debounce 期间立即发起的新会话读到旧模型或旧插件配置。

### `OpenClawRuntimeAdapter`

Adapter 是 Cowork domain 与 Gateway domain 的边界。它负责把 JustDo 的 session、agent、attachment、stream 概念映射到 Gateway 请求和事件。

Adapter 不应该变成大而全 service。新增 Gateway API 时优先：

1. 放到 `src/main/openclaw/<domain>/` 的专用 helper/service。
2. Adapter 只调用 helper。
3. Renderer 通过已有 Cowork/OpenClaw IPC 获取结果。

## Gateway Connection

Gateway connection info 包含 port 和 token。Main 持有 token，Renderer 需要连接 chat websocket 时通过受控 IPC 获取必要信息。

```text
OpenClawEngineManager
  -> getGatewayPort()
  -> getGatewayToken()
  -> GatewayClient connects ws://127.0.0.1:{port}
```

代理策略会把 Gateway localhost 端口加入 bypass，避免系统代理影响本地 websocket/RPC。

## Provider / Model Flow

```mermaid
flowchart LR
  Settings["Settings UI"] --> Store["kv / provider config"]
  Store --> Resolve["resolveAllEnabledProviderConfigs"]
  Resolve --> Selection["buildProviderSelection"]
  Selection --> AgentRefs["resolveQualifiedAgentModelRef"]
  Selection --> Sync["OpenClawConfigSyncService"]
  AgentRefs --> Sync
  Sync --> GatewayConfig["Gateway config files/state"]
  GatewayConfig --> Gateway["OpenClaw Gateway model registry"]
```

Agent model 绑定可能是：

- 完整 provider-qualified ref。
- 历史未带 provider 的 model id。
- 空值，需要 backfill 默认模型。

`openclawAgentModels.ts` 负责识别 ambiguous model。若同一个 model id 出现在多个 provider，应跳过自动迁移并写 warning，避免把用户 Agent 绑定到错误 provider。

JustDo 生成的所有 `openai-completions` 模型条目都显式设置
`compat.supportsUsageInStreaming: true`。OpenClaw 据此在流式请求中发送
`stream_options.include_usage`，使支持该协议的模型提供商返回上下文与 token 使用统计。

内置模型同步会根据 `/model/info` 的 `model_info.mode` 区分聊天与 embedding
模型。聊天模型进入应用的可选模型列表；embedding 模型按 ID 排序，并将第一个模型写入
`agents.defaults.memorySearch`，复用同一个内置 provider 的 base URL 和 API key。若没有
embedding 模型，则显式设置 `memorySearch.enabled: false`，避免 OpenClaw 回退到 OpenAI。

登录/退出与内置模型、`openclaw.json`、Gateway 环境之间的接入契约独立记录在
[`docs/features/authentication-builtin-model-lifecycle.md`](../features/authentication-builtin-model-lifecycle.md)，
认证模块应只依赖其中定义的 Main 进程生命周期入口。

## Startup And Recovery

启动时的恢复动作包括：

- 重置上次异常退出留下的 running session 标记。
- backfill 空 agent model。
- 迁移可确定的旧 model ref。
- 同步 config。
- 自动启动 Gateway。
- Gateway ready 后启动 scheduled task polling。

系统从 sleep/resume 恢复时，adapter 会处理 Gateway websocket reconnect。

## Engine Status Model

Engine status 至少应支持这些 UI 语义：

- idle：未启动。
- downloading/installing：runtime 准备中。
- ready：runtime 可启动。
- starting：Gateway process 启动中。
- running：Gateway 可用。
- error：启动或运行失败。

UI 不应该根据日志文本推断状态；应使用 status object。

## Patch Interaction

Runtime patch 影响的是 Gateway runtime 行为，因此 engine install/bundle 流程必须能清楚记录 patch 是否应用。Adapter 层如果依赖 patch 行为，需要在对应 feature docs 写明，比如 thinking stream。

Patch 失效时应表现为：

- 构建/安装日志可见。
- Gateway 启动日志可见。
- Feature 降级路径可见。
- 文档能指向具体 patch。

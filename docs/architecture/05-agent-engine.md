# Agent Engine 与 OpenClaw 集成

本文描述 JustDo 如何安装、配置、启动、连接和监督 OpenClaw `v2026.8.1`。当前唯一 Cowork engine 是 OpenClaw；`CoworkEngineRouter` 只是稳定接口层，不再提供多引擎选择。

## 1. 组件分工

| 组件                               | 职责                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| `OpenClawEngineManager`            | runtime/state 路径、端口/token、child process、状态机、stdout filter、CLI env        |
| `OpenClawConfigSyncService`        | config mutation 串行化、写入/验证、restart/reconnect 决策                            |
| `openclawConfigSync.ts`            | 把 provider/agent/全局权限兜底/plugin/browser 等产品配置映射为 OpenClaw config       |
| `OpenClawRuntimeAdapter`           | Gateway client、chat/session RPC、event normalize、approval、history、goal、subagent |
| `CoworkEngineService`              | 延迟创建和访问 router/adapter                                                        |
| `SessionPermissionModeCoordinator` | session permission 更新与同步 admission                                              |
| `openclawSessionKeys.ts`           | managed/cron session key 的纯解析与构造工具                                          |
| patch pipeline                     | 为固定上游版本补足 JustDo 需要而上游尚未提供的能力                                   |

## 2. Runtime 来源与布局

`package.json.openclaw` 固定仓库和版本。平台脚本依次：安装目标 runtime、同步到 current、bundle Gateway、确保 plugins、同步 resources、预编译 extensions、prune。Windows 还准备 MinGit 和带 hashed requirements 的 Python runtime。

开发可运行：

```bash
npm run electron:dev:openclaw
```

它先为 host 准备 runtime，再编译/启动 Electron。普通 `electron:dev` 假设 runtime 已存在。打包测试验证 runtime freeze、staging、prune、launcher、patch manifest 与平台资产，不能只凭目录存在判定可发布。

## 3. Manager 状态机

Engine status 至少表达 stopped、starting、running、stopping/error 类 phase 及 message。Manager 的重要性质：

- 并发 `startGateway()` 复用同一个 in-flight promise；
- 生成/保存本地 token，不把它写日志；
- 选择用户配置端口并监听变更，启动前验证可用性；
- 构造仅供 Gateway child 的 proxy/header/runtime environment；
- 从输出识别 ready、native log path 和 fatal startup；
- 启停均发 status event，Main 广播 `openclaw:engine:onProgress`；
- external config/policy error 可把 manager 标为不可 admission；
- restart 是有序 stop/start，不允许旧 client 假连接到已退出进程。

默认 Gateway 端口常量为 `42871`。用户端口必须经过 shared validator；临时端口范围只产生提示，端口非法、占用或设置失败才返回相应稳定错误码。

## 4. 启动前配置同步

配置同步汇总多个权威源：

- provider models、base URL、API format、auth 与 capability；
- agents 的 identity、system prompt、qualified model 和 skills；
- 无显式 session mode 时的全局 restricted fallback 与 scheduler 隔离 policy；
- runtime settings，包括 AskUserQuestion 等待时限、MCP 请求超时与 subagent 调度参数；
- MCP servers、Hooks、Extensions 与 ask-user 动态 callback；
- browser mode；
- system prompt replacement rules；
- scheduler 隔离 agent 与其他 JustDo 管理项。

同步在 exclusive queue 内执行，避免设置页、MCP/Hook/Extension 同时覆盖文件。写入后必须验证 active Gateway 的 restricted fallback 与 scheduler policy。会话 permission 不写全局 config，而由 session RPC 管理。若 Gateway 正在运行且变化需要 restart，Main 先通过原生 `gateway.suspend.prepare` 原子暂停 scheduler、封闭新 admission 并确认所有 Gateway workload 已空闲，再执行断开 adapter -> restart -> reconnect；busy 或 suspension RPC 不可用时继续延迟，不能用 `cron.list`/本地 active snapshot 代替该屏障。

v2026.8.1 配置只生成 keyed `agents.entries` roster，并以 `agents.ownership: explicit` 标记多 Agent 所有权；`main` 与隔离的 `justdo-scheduler` 在无模型的最小配置中也必须存在。`agents.defaults.systemAgent.agentId` 固定为 `main`，让 memory dreaming 等 OpenClaw 原生环境任务拥有明确 owner；JustDo 创建的无人值守任务仍逐项显式绑定 `justdo-scheduler`。启动权限验收同样只读取 v2026.8.1 的 `agents.entries`，不能再用已删除的 `agents.list` 判断 scheduler 权限。自定义 provider 的展示名同时是 Gateway 模型引用中的 provider ID，使 OpenClaw 注入的当前模型身份保持用户可读；设置页与主进程同步入口都会拒绝 v2026.8.1 内置 provider、官方外置 provider/别名以及 JustDo 内部命名空间，避免触发错误的 provider 或插件路由。记忆检索写入顶层 `memory.search`，计划工具开关写入 `tools.updatePlan`。同步会定向清理 JustDo 历史写入但已被该版本删除的 metadata、diagnostics、pricing、heartbeat 与 experimental tool 字段，避免把旧生成结果重新喂给严格 schema。

版本化的 `agentRuntimeSettings:v1` 同时生成 `agents.defaults.subagents`，把 AskUserQuestion 等待时限写入 `plugins.entries.ask-user-question.config.timeoutMinutes`，并以全局 MCP 请求时限作为用户 MCP Server 的默认 `timeout`。`mcp_servers.config_json.requestTimeoutSeconds` 可覆盖单个 Server；旧数据缺少这些后来加入的字段时分别使用 10 分钟、60 秒或继承全局默认；配置同步失败会恢复上一份数据库值。

## 5. Fail-closed admission

`ensureOpenClawRunningForCowork` 的顺序：

1. 检测 legacy `sessions.json`。存在时先生成原生 SQLite migration dry-run plan，并在用户确认前阻止 Gateway 启动。
2. 确保 extension host 可用；其失败会记录，但后续 config/能力验证决定是否可继续。
3. 执行 config sync；失败则设置 external engine error。
4. 若 manager 已 running，仍验证 active fallback/scheduler policy。
5. 否则调用可合并的 start；running 后再次验证该 policy。
6. 只有 phase 为 running 且验证成功，Cowork start/continue 才被接受。

这防止 Gateway 在无显式 session mode 的路径使用旧 Full fallback。具体 session 的 mode/root 在每个 turn admission 中另外回读验证。

Legacy session migration 是显式事务：`doctor --session-sqlite plan` dry-run -> 用户确认 -> 创建不含 workspace 的已验证备份 -> import 全部 agent session -> `validate`/`inspect`/integrity -> 写 receipt 与 manifest。取消或任一步失败会恢复旧 session store、保留备份和脱敏错误，并继续阻止空 Gateway；成功 receipt 使重复启动只做完整性复核，不重复导入。

## 6. Provider 与模型引用

JustDo 支持内置和自定义 provider。provider registry 规范化 provider id、API format (`openai-completions`) 与 auth。模型发现读取 `/models` 和可选 model info，填充 context length、max tokens 和 image capability，并以保守默认值兜底。

OpenClaw model ref 必须是 `provider/model-id`。启动迁移规则：

- agent model 为空时从当前默认 model 回填；
- 裸 model id 只有在 available providers 中唯一匹配时才补 provider；
- 多 provider 同名时跳过并记录无 secret 的警告；
- session 可保存自身 model，`sessions.patch` 只影响明确返回的后续调用范围。

当用户在当前版本中修改自定义 provider 展示名时，Main 以稳定的 `custom_N` 配置 key 识别同一 provider，并在生成 Gateway 配置前事务性更新当前 Agent、session 与 subagent 默认模型中的 wire ref。Renderer 的 `app_config` 写入会等待相关 OpenClaw 配置实际应用；失败时回滚配置与这些引用，不向用户报告伪成功。主题、语言等与 OpenClaw 无关的更改不等待 Gateway 同步。

## 7. Built-in model 生命周期

`BuiltinModelLifecycle` 与 `syncBuiltinModelProvider` 管理内置 provider。当前启动保持 access enabled，未来认证 login/logout 通过同一入口切换。刷新会获取可用模型、更新 `app_config.providers`、通知 Renderer，并触发 OpenClaw config sync。刷新失败不能删除上一次可用配置，也不能记录凭证。

内置模型服务的 OpenAI-compatible 响应契约要求：完整结构化 `tool_calls` 的最终 `finish_reason` 必须是 `tool_calls`；普通文本、不完整参数或未知工具不能被服务推断为调用。JustDo 不再用通用 runtime patch 放宽第三方 provider；第三方响应继续遵守 OpenClaw 原生的 visible-text + stop 安全策略。

## 8. Gateway client 与连接恢复

Adapter 延迟建立 Gateway client，并维护 generation 防止旧 socket 回调污染新连接。连接后订阅 sessions/event 能力、拉取 pending approvals，并安排 active goal recovery。

- 系统 resume 显式触发 reconnect。
- proxy 改变先 dispose client，再 restart Gateway；成功后创建新 client。
- disconnect 不自动宣告业务终态；active turns 由 Gateway runtime/history 恢复或明确超时/abort。
- subscription、ready promise、timer 和 caches 都绑定 generation，disconnect 时清理。
- Manager 在 Electron Main 模块加载时捕获一次稳定的 app-start 时间，并传给该软件进程启动的每个 Gateway。原生 restart recovery 保留同一 JustDo 进程内的 Gateway 重启；补丁 `008` 在 durable task maintenance 的恢复副作用前取消早于 app-start 的 queued/running task，防止完整软件重启后旧 subagent/cron/detached task 复活。

## 9. Managed session key

JustDo 使用稳定 managed key 编码 agent 与本地 session。纯 session-key helper 只接受规定格式，避免把任意 channel/session key 归入产品 session；它也识别 cron 隔离 key。未接入产品数据流的旧 channel 自动建会话逻辑已经删除，外部会话不会被静默写入本地产品列表。

删除只操作可证明归属的 managed tree；通用 main session 不递归删除。runtime status 批量查询采用单飞/TTL snapshot，避免会话列表轮询造成 N+1 RPC。

## 10. Chat 与事件归一化

Adapter 在初始会话和后台任务路径调用 `chat.send`，保存 requested run id，接收真实 run id 后重绑。普通对话的 Thinking/Tool/Content 由 Renderer Gateway client 直接处理；Main 不再建立第二套消息投影。Adapter 仍处理：

- chat final/aborted/error 对产品 run 状态的收敛；
- agent lifecycle、审批、cron 与后台任务事件；
- requested/acknowledged run id 绑定与迟到终态去重；
- foreign/detached/visible run 的运行状态边界；
- scheduler 等全量结果消费者的分页 `chat.history` 读取。

后台全量历史同步按每页 1000 条循环读取；Renderer 另有分页窗口。扩大单页限制前必须评估内存和二次投影成本。

Adapter 不再读写 OpenClaw `sessions.json`。模型变更在 Gateway ready 后用 `sessions.patch`；历史来自原生分页 `chat.history`；原生 display projection 未公开的 tool input 与 compaction detail 由 `justdo-runtime-bridge` 的受限 `operator.read` RPC 按请求 id 有界补齐。所有 RPC 结果先经过 `v2026.8.1` wire validator，再进入产品 DTO。

## 11. Slash commands

命令列表来自 Gateway，再应用 JustDo policy 的 blacklist、category、tier、execution type 和 before-send hook。本地命令和 Gateway 命令分开：例如 goal 控制可能要求先确保 session entry。UI 不应把未知 `/...` 默认为本地执行，也不能绕开 policy 直接 RPC。

## 12. Goal continuation

Adapter 内的 coordinator 将 Gateway goal、tool、lifecycle 和原生 task 状态组合成可恢复状态机。继续动作带控制 run id、退避/重试、等待用户输入/确认和 terminal latch。连接 generation 变化后扫描本地 session 与 Gateway goal/runtime；只有 goal id 和状态一致才恢复，避免旧 snapshot 续跑新目标。

软件启动后的首次完整 Goal 扫描复用 Manager 的 app-start cutoff：早于 cutoff 或缺少
`createdAt`、且没有当前 active run/用户 activation/精确 session+goal ownership 的 active Goal
会恢复为 `stopped`，不会自动 continuation。扫描失败会携带同一 cutoff 重试；旧 generation
不能清除首次扫描状态。首次扫描成功后，后续 Gateway-only reconnect 恢复当前软件进程内的
active Goal。

Goal、required child join、queue admission、审批、thinking、compaction/context budget 均使用 v2026.8.1 原生能力。Subagent 列表和终态来自 `task` events 与 `tasks.list/get`；产品层只映射为 `pending/running/done/failed/killed/timeout`，其中 `taskName` 是稳定 task id，`label` 是展示标题。

## 13. Agent runtime settings

Shared contract 对 delegation mode、命令审批等待时限、全局及单 Server MCP request timeout、subagent concurrency/children/depth/timeout/archive/model/thinking/announce timeout 等字段做默认值、范围和跨字段 normalize。Main IPC 保存后进入 config sync。命令审批预设为无限、10、20、30、60 分钟，并通过受管 Gateway 环境作用于后续原生 exec approval；需要 hard restart 的配置会一直通过原生 suspension 屏障等待活动任务结束，不设置强制中断上限，真正重启前 scheduler 与新 admission 已被冻结；MCP timeout 变化会重建托管 server 配置；subagent 配置通常影响新 spawn/turn，不能承诺正在运行的 subagent 热更新。

受管字段（例如 scheduler agent 的权限、关键 extension/plugin 配置）不能被通用 settings UI 覆盖。

## 14. 权限与审批

权限模式是 ask、auto、full 三档产品语义，分别映射到 OpenClaw 原生 session `guarded`、`workspace`、`full`。`OpenClawRuntimeAdapter.prepareSession` 通过 `sessions.create({key,cwd,permissionMode})` 幂等写入并核对 entry；会话变更由 coordinator 串行并先保存 SQLite 期望值，活跃 run 允许切换并在终态后应用最新值。原生同步失败只保留 pending，不回滚旧模式；下一 turn 前的严格 reconcile 失败会阻止发送。Cowork config 中的 mode 只作为新会话默认值，不触发 Gateway config reload。

Exec 和 plugin approval API 分开，pending list 在连接后恢复。session grant 仅对满足 shared predicate 的 exec request 有效，并在 session terminal/stop/delete 清除。scheduler agent 使用固定无人值守 policy，不能弹 UI，也不能借 cron 修改升级普通交互会话。

## 15. Runtime patches

当前补丁目录为 `scripts/patches/v2026.8.1/`，仅保留十二个产品缺口：managed Python、通用 Windows MCP runner、Chrome Windows/诊断与空页面恢复、最终 system-prompt replacements、agent metadata、compaction/reviewer purpose、app-start task boundary、manual memory no-cache reindex、原生 exec/plugin approval 可配置等待时限和 plugin approval reviewer detail 转发。权威处置与删除条件以该目录 README 为准。

补丁不是传统数据库 migration：每次 runtime 都从锁定的 pristine npm tarball 构建，source lock 同时验证 registry integrity 与 tarball SHA-256。安装、source/worker、esbuild bundle 和 prune 后均验证当前 patch shape；旧 marker 或部分应用状态 fail closed，禁止对旧 JustDo runtime 原地升级。开发态 Electron 会在系统临时目录持有按仓库隔离、带心跳的进程租约；已有开发会话未退出时，新的 runtime prepare 必须在下载或目录替换前失败，避免 Windows 对正在执行的 runtime 进行 rename 而产生延迟 `EPERM`。

## 16. 网络环境

Manager 通过 `OutboundHeaderProxy.buildGatewayEnvironment` 为 Gateway child 构造环境，并允许
需要远端模型访问的 OpenClaw one-shot CLI 显式 opt-in 同一环境。当前 memory search/index CLI
会 opt-in，使独立 CLI 发出的 embedding 请求也经过 URL 白名单和 Header 注入；status 等纯本地
命令保持继承环境。CLI 复用当前 capability，不触发 Gateway capability rotation。系统/custom/direct
proxy 变化会更新 bypass，其中动态加入当前 Gateway loopback 端口，避免本地 RPC 被送到上游代理。
内置 provider 若使用 loopback base URL 可列为 forced URL。

仅提供 CLI 环境并不足以让 OpenClaw 的 guarded fetch 使用代理。内置 `justdo-runtime-bridge`
注册 remote embedding provider，复用 OpenClaw SSRF guard，并只对 eligible URL 使用 env proxy；
没有 `HTTP(S)_PROXY` 或命中 `NO_PROXY` 时保持原路径。请求到达本地代理后仍由完整 URL 白名单决定
是否注入业务 Header，未命中请求不会获得自定义 Header。

OpenClaw 原生 `memory index --force` 会重建索引表，但仍把旧 embedding cache 复制到 shadow
database；内容未变化时因此不会发出模型请求。设置页“重建索引”会额外注入
`JUSTDO_MEMORY_REINDEX_NO_CACHE=1`，runtime patch `009` 只对这个明确 opt-in 跳过旧 cache seed，
使现有记忆分块重新计算向量。普通搜索、后台增量索引和 OpenClaw 自身 CLI 的缓存行为不变；失败时
继续由上游 shadow reindex 保留原数据库。

受管 memory search 配置只额外声明与标题模型请求一致的
`User-Agent: OpenAI/JS 6.39.1`；`Authorization`、`Content-Type` 和动态 body length 仍由 OpenClaw
embedding 请求层负责。OutboundHeader 的用户值继续只存在于代理 policy/cache，不写入
`openclaw.json`。

Main 通用 fetch、Electron session proxy 与受管 OpenClaw child environment 是不同作用域；修改一个
不能假定其他两个自动同步。

## 17. 日志与诊断

优先顺序：

1. `%APPDATA%/<productName>/logs/main-YYYY-MM-DD.log`；
2. `%APPDATA%/<productName>/openclaw/logs/gateway.log`；
3. `[gateway] log file:` 指向的 `%TEMP%/openclaw/openclaw-YYYY-MM-DD.log` 原生 JSON。

Gateway stdout filter 会压缩 thinking/assistant/item 流，只保留段首尾及 80 字预览，并省略 plugin loading、schema walk、droppable delta、tick/health。因此 condensed log 中“没看到事件”不是事件不存在的证据。分享前检查敏感内容，禁止提交 raw native log。

## 18. 升级与验证

升级 OpenClaw 时：固定新版本 -> 安装 pristine runtime -> 重新验证 capability gaps -> port 当前 patch 而非复制旧目录 -> 更新 patch README/manifest/tests -> 运行 patch verify、runtime staging/freeze/prune 和相关 adapter测试 -> 更新本文件及 capability matrix。

常用验证：

```bash
npm run openclaw:patches:verify
npm run compile:electron
npm test
```

还需手工验证启动、proxy 切换、sleep/resume、start/stop、approval、goal continuation、subagent completion、cron 和退出清理。

## 19. Manager 并发约束

Gateway start/restart/stop 不是三个互不相关的按钮。Manager 需要共享启动与完整重启 promise、shutdown flag、child identity 和 readiness wait：并发 ensure 复用同一启动；同一 generation 的并发 hard restart 复用同一 stop/start，禁止通过 `afterCurrent` 给新进程排入未获取 suspension 的 trailing restart。若当前 start/restart 的启动快照之后又发生 secrets、代理或扩展等启动输入变化，上层必须等当前 generation 完成后，针对新 generation 重新获取原生 suspension 再执行下一轮。ready lease 返回后还要再次核对 phase 与 process generation，旧 lease 不能作用于新进程。shutdown 让 readiness/retry loop 尽快退出；stop 有超时兜底，不能永久阻塞应用退出。

设置页的手动 restart 优先请求 Gateway 的 `gateway.restart.request`，并以当前受管进程日志中的下一次 `[gateway] ready` 作为完成边界。受管 Gateway 设置 `OPENCLAW_NO_RESPAWN=1`，因此该请求复用当前 Node 进程和已加载模块，避免重新解析 runtime bundle。若 RPC 不可用、进程退出、ready 超时或 Gateway 因 cooldown 给出较长延迟，Main 回退到有序 stop/start。端口属于 launch argument；配置端口与当前监听端口不同时必须直接走完整重启。Secrets 等启动环境有尚未应用的变更时同样必须完整重启，避免进程内 restart 继续使用旧环境。

`phase=running` 只表示受管进程/readiness 达标，不保证每个 adapter consumer 的 WebSocket 仍健康。配置、代理以及 extension 配置/启停/导入/删除触发的自动 hard restart 都进入 `OpenClawConfigSyncService` 的 exclusive queue 与原生 suspension 屏障，由同一路径 disconnect 旧 client、restart Gateway、再 connect Cowork service；最后一步失败时停止 Gateway，避免留下假健康状态。Skill/Extension 的 Windows 目录锁恢复也在同一 exclusive queue 中，只有原生 suspension 返回 ready 才能 stop/mutate/start；Gateway 忙碌时操作失败并提示稍后重试，不能直接中断 active run。

## 20. 启动失败分层

| 阶段               | 失败示例                 | 处理                                                   |
| ------------------ | ------------------------ | ------------------------------------------------------ |
| Runtime resolution | bundle/Node/资源缺失     | manager 返回失败并记录解析路径，不尝试随机全局 runtime |
| Config sync        | schema/write/reload 失败 | 不自动启动 Gateway；高风险 admission fail closed       |
| Spawn              | child 无法启动/立即退出  | 收集 exit/stdout，进入 error phase                     |
| Readiness          | port/token/health 超时   | 终止或清理 child，返回可重试错误                       |
| Client connect     | WS/RPC handshake 失败    | adapter 保留断线状态，由 reconnect/显式 restart 恢复   |
| Runtime request    | method error/timeout     | 绑定具体 command/run，不自动等同整个 session terminal  |

## 21. Credential 与网络边界

Gateway port/token 由 Main 管理；token 不应进入普通 Redux、日志或导出。Provider key 写入受管配置时必须避免 console 序列化完整对象。系统代理、Main fetch 代理、Gateway child environment 与 outbound-header proxy 是不同网络层；变更 `NO_PROXY` 或 header injection 时要验证 loopback Gateway 不被错误代理，同时远程 provider 仍遵守用户偏好。

## 22. Runtime Capability 证据

每项能力需要区分：upstream native、当前版本 patch、adapter projection 和 UI consumer。只有类型或 patch 文件不足以证明可用。证据至少包含 Gateway fixture/RPC 或 patch consumer test、adapter test，以及实际注册的 IPC/UI 路径；完整表见 capability matrix。

## 23. 代码与测试地图

| 主题                     | 入口                                                       |
| ------------------------ | ---------------------------------------------------------- |
| 进程/端口/readiness      | `openclawEngineManager.ts`、`loopbackPort.ts` 及测试       |
| 启动参数与 Node          | `gatewayLaunchArgs.ts`、`electronNodeRuntime.ts` 及测试    |
| Config reload            | `gatewayConfigReloadMonitor.ts`、config sync service tests |
| Adapter/session RPC      | `openclawRuntimeAdapter.test.ts`、`sessionRpc.test.ts`     |
| Renderer history/live    | `chat-controller.test.ts`、`history-reconciler.test.ts`    |
| Model refs/agent models  | shared modelRef 与 `openclawAgentModels` tests             |
| Goals/subagents/approval | goals、subagent gateway、permissions tests                 |
| 日志压缩                 | `gatewayLogFilter.test.ts`                                 |

## 24. Engine 变更完成条件

必须验证冷启动、并发 ensure、启动中 stop、异常 child exit、代理 restart、sleep/resume、优雅退出和打包 runtime path。Gateway method/schema 变化还要更新 shared contract、adapter、capability matrix 和 patch disposition；只让 TypeScript 编译通过不构成 runtime 兼容验证。

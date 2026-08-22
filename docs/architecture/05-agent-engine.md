# Agent Engine 与 OpenClaw 集成

本文描述 JustDo 如何安装、配置、启动、连接和监督 OpenClaw `v2026.7.1-2`。当前唯一 Cowork engine 是 OpenClaw；`CoworkEngineRouter` 只是稳定接口层，不再提供多引擎选择。

## 1. 组件分工

| 组件                               | 职责                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| `OpenClawEngineManager`            | runtime/state 路径、端口/token、child process、状态机、stdout filter、CLI env        |
| `OpenClawConfigSyncService`        | config mutation 串行化、写入/验证、restart/reconnect 决策                            |
| `openclawConfigSync.ts`            | 把 provider/agent/permission/plugin/browser 等产品配置映射为 OpenClaw config         |
| `OpenClawRuntimeAdapter`           | Gateway client、chat/session RPC、event normalize、approval、history、goal、subagent |
| `CoworkEngineService`              | 延迟创建和访问 router/adapter                                                        |
| `SessionPermissionModeCoordinator` | session permission 更新与同步 admission                                              |
| `OpenClawChannelSessionSync`       | managed/channel/cron session key 与本地 session 映射                                 |
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
- 全局/会话权限 policy 与审批模式；
- Agent runtime/subagent settings；
- MCP servers、Hooks、Extensions 与 ask-user 动态 callback；
- browser mode；
- system prompt replacement rules；
- scheduler 隔离 agent 与其他 JustDo 管理项。

同步在 exclusive queue 内执行，避免设置页、MCP/Hook/Extension、permission 同时覆盖文件。写入后必须验证 active Gateway permission policy。若 Gateway 正在运行且变化需要 restart，流程是断开 adapter -> restart -> reconnect；有 active workloads 时 service 应遵守安全策略，不盲目重启。

## 5. Fail-closed admission

`ensureOpenClawRunningForCowork` 的顺序：

1. 确保 extension host 可用；其失败会记录，但后续 config/能力验证决定是否可继续。
2. 执行 config sync；失败则设置 external engine error。
3. 若 manager 已 running，仍验证 active permission policy。
4. 否则调用可合并的 start；running 后再次验证 policy。
5. 只有 phase 为 running 且验证成功，Cowork start/continue 才被接受。

这防止“本地保存成功、Gateway 实际仍用旧权限”的危险窗口。

## 6. Provider 与模型引用

JustDo 支持内置和自定义 provider。provider registry 规范化 provider id、API format (`openai-completions`) 与 auth。模型发现读取 `/models` 和可选 model info，填充 context length、max tokens 和 image capability，并以保守默认值兜底。

OpenClaw model ref 必须是 `provider/model-id`。启动迁移规则：

- agent model 为空时从当前默认 model 回填；
- 裸 model id 只有在 available providers 中唯一匹配时才补 provider；
- 多 provider 同名时跳过并记录无 secret 的警告；
- session 可保存自身 model，`sessions.patch` 只影响明确返回的后续调用范围。

## 7. Built-in model 生命周期

`BuiltinModelLifecycle` 与 `syncBuiltinModelProvider` 管理内置 provider。当前启动保持 access enabled，未来认证 login/logout 通过同一入口切换。刷新会获取可用模型、更新 `app_config.providers`、通知 Renderer，并触发 OpenClaw config sync。刷新失败不能删除上一次可用配置，也不能记录凭证。

## 8. Gateway client 与连接恢复

Adapter 延迟建立 Gateway client，并维护 generation 防止旧 socket 回调污染新连接。连接后订阅 sessions/event 能力、拉取 pending approvals，并安排 active goal recovery。

- 系统 resume 显式触发 reconnect。
- proxy 改变先 dispose client，再 restart Gateway；成功后创建新 client。
- disconnect 不自动宣告业务终态；active turns 由 Gateway runtime/history 恢复或明确超时/abort。
- subscription、ready promise、timer 和 caches 都绑定 generation，disconnect 时清理。

## 9. Managed session key

JustDo 使用稳定 managed key 编码 agent 与本地 session。Parser 只接受规定格式，避免把任意 channel/session key 归入产品 session。Channel sync 还能识别 main agent channel 与 cron key，为外部/定时运行创建或解析本地展示 session。

删除只操作可证明归属的 managed tree；通用 main session 不递归删除。runtime status 批量查询采用单飞/TTL snapshot，避免会话列表轮询造成 N+1 RPC。

## 10. Chat 与事件归一化

Adapter 调用 `chat.send`，保存 requested run id，接收真实 run id 后重绑。它处理：

- chat delta/final/aborted/error；
- agent assistant/thinking/tool/lifecycle/item stream；
- Webchat tool capability 与 legacy fallback；
- stable message id、stream text overlap merge、final replacement；
- model name、usage、execution plan 与 completion metadata；
- foreign/detached/visible run 的不同展示；
- completion 后 `chat.history` reconciliation。

`FINAL_HISTORY_SYNC_LIMIT` 当前为 1000；Renderer 另有分页窗口。扩大限制前必须评估内存和二次投影成本。

## 11. Slash commands

命令列表来自 Gateway，再应用 JustDo policy 的 blacklist、category、tier、execution type 和 before-send hook。本地命令和 Gateway 命令分开：例如 goal 控制可能要求先确保 session entry。UI 不应把未知 `/...` 默认为本地执行，也不能绕开 policy 直接 RPC。

## 12. Goal continuation

Adapter 内的 coordinator 将 Gateway goal、tool、lifecycle 和 managed subagent join 组合成可恢复状态机。继续动作带控制 run id、退避/重试、等待用户输入/确认和 terminal latch。连接 generation 变化后扫描本地 session 与 Gateway goal/runtime；只有 goal id 和状态一致才恢复，避免旧 snapshot 续跑新目标。

相关 OpenClaw patch 提供 silent goal clear、managed subagent join、progress、context budget/compaction 等能力。移除 patch 前必须证明新上游具有等价 wire contract。

## 13. Agent runtime settings

Shared contract对 delegation mode、subagent concurrency/children/depth/timeout/archive/model/thinking/announce timeout 等字段做默认值、范围和跨字段 normalize。Main IPC 保存后进入 config sync。配置通常影响新 spawn/turn；不能承诺正在运行的 subagent 热更新。

受管字段（例如 scheduler agent 的权限、关键 extension/plugin 配置）不能被通用 settings UI 覆盖。

## 14. 权限与审批

权限模式是 ask、auto、full 三档产品语义，经 config mapper 转为 Gateway tool/approval policy。会话变更由 coordinator 串行，先写/同步/验证；失败回滚或返回明确错误。

Exec 和 plugin approval API 分开，pending list 在连接后恢复。session grant 仅对满足 shared predicate 的 exec request 有效，并在 session terminal/stop/delete 清除。scheduler agent 使用固定无人值守 policy，不能弹 UI，也不能借 cron 修改升级普通交互会话。

## 15. Runtime patches

当前补丁目录为 `scripts/patches/v2026.7.1-2/`。能力涉及 approval lifecycle、atomic subagent admission、managed join、thinking/reasoning、session yield、compaction、completion delivery、selected tool search、Windows MCP/Python 等。详表以该目录 README、patch manifest 和 `tests/openclawV202671*.test.ts` 为准。

补丁不是传统数据库 migration：每次 runtime 安装在目标上游 bundle 应用并验证；历史 `v2026.6.11` 只作追溯，不参与当前流水线。

## 16. 网络环境

Manager 通过 `OutboundHeaderProxy.buildGatewayEnvironment` 为 child 构造环境，并用 capability generation 避免旧规则继续工作。系统/custom/direct proxy 变化会更新 bypass，其中动态加入当前 Gateway loopback 端口，避免本地 RPC 被送到上游代理。内置 provider 若使用 loopback base URL可列为 forced URL。

Main 通用 fetch、Electron session proxy 与 Gateway child environment 是不同作用域；修改一个不能假定其他两个自动同步。

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

Gateway start/restart/stop 不是三个互不相关的按钮。Manager 需要共享启动 promise、shutdown flag、child identity 和 readiness wait：并发 ensure 复用同一启动；restart 先使旧 client 失效；shutdown 让 readiness/retry loop 尽快退出；stop 有超时兜底，不能永久阻塞应用退出。

`phase=running` 只表示受管进程/readiness 达标，不保证每个 adapter consumer 的 WebSocket 仍健康。代理重启路径因此会显式 disconnect 旧 client、restart Gateway、再让 Cowork service connect；最后一步失败时停止 Gateway，避免留下假健康状态。

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
| History/usage matching   | `historyReconciler.test.ts`、`historyUsageMatcher.test.ts` |
| Model refs/agent models  | shared modelRef 与 `openclawAgentModels` tests             |
| Goals/subagents/approval | goals、subagent gateway、permissions tests                 |
| 日志压缩                 | `gatewayLogFilter.test.ts`                                 |

## 24. Engine 变更完成条件

必须验证冷启动、并发 ensure、启动中 stop、异常 child exit、代理 restart、sleep/resume、优雅退出和打包 runtime path。Gateway method/schema 变化还要更新 shared contract、adapter、capability matrix 和 patch disposition；只让 TypeScript 编译通过不构成 runtime 兼容验证。

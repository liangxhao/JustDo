# 进程模型与 IPC

本文按当前 `src/main/preload.ts`、`src/main/ipc/` 和 shared channel 合约重写。目标是说明跨进程能力面、调用/事件语义、验证责任和新增 IPC 的完整流程。

## 1. 进程与信任边界

| 参与者         | 权限                          | 主要职责                                                     |
| -------------- | ----------------------------- | ------------------------------------------------------------ |
| Renderer       | Chromium 页面权限             | UI、交互、Redux、聊天显示；不访问系统资源                    |
| Preload        | 隔离上下文中的 Electron IPC   | 暴露固定 `window.electron` API，转换 listener 为 unsubscribe |
| Main           | Node/Electron 完整权限        | 验证输入、SQLite、文件/网络/进程、Gateway 和系统集成         |
| Gateway        | 独立受管子进程                | Agent、tool、session/history、cron、plugin runtime           |
| Extension host | Main 管理的本地服务/transport | ask-user callback、extension MCP 等受管能力                  |

BrowserWindow 必须维持 context isolation；即使某平台通过启动 switch 降低 Chromium sandbox，也不能因此扩大 Renderer API。

## 2. IPC 形态

### 2.1 调用型

Renderer 调用 preload 方法，preload 使用 `ipcRenderer.invoke`，Main 通过 `ipcMain.handle` 返回可序列化结果。适合 CRUD、查询、命令和显式生命周期操作。

约束：

- handler 在边界验证 unknown payload，不能依赖 TypeScript 类型提供运行时安全；
- 错误结果应保留稳定 `code` 和可显示 message，不能只返回日志文本；
- 长操作应在 service 中支持并发合并、取消或互斥，而不是阻塞 handler；
- 不返回 Node/Electron 对象、Error 实例、数据库 row handle 或 secret。

### 2.2 IPC 事件型

Main/Gateway 状态变化通过 `webContents.send` 到 preload listener。preload 每个 `onX` 方法注册包装 handler 并返回取消函数。适合 stream、engine progress、approval、session changed、cron/status/result 和 update state。

事件消费者必须：

- 在组件卸载或 session 切换时调用 unsubscribe；
- 用 session id、run id、domain 和 sequence 做 admission，不能只看“当前 UI 有无运行”；
- 把事件视为增量提示，重连后以权威查询/history 恢复；
- 允许重复、乱序、终态后迟到以及订阅短暂中断。

### 2.3 Renderer 到本地 Gateway 的聊天数据通道

聊天是当前唯一明确的 Renderer→Gateway 直连通道。`JustDoChatWrapper` 通过 `openclaw.engine.getPort/getToken` 取得连接信息，`GatewayClient` 建立 loopback WebSocket；`ChatController` 订阅 session/message 事件、请求常规 history，并在 IPC paged history 不可用时使用带 Bearer token 的 loopback REST fallback。产品 session start/continue、权限、文件、配置、SQLite 与大部分 Gateway 领域命令仍经过 Main。

这条通道意味着 Renderer 能接触 Gateway token 和原始聊天 wire event，必须由集中式 client/controller 处理，不能让各 React 组件各建连接或各写 parser。连接 generation、session key、run id 和 sequence 用于拒绝旧连接与迟到事件；token 只保存在控制器内存，不得进入 Redux、日志、导出或第三方请求。

## 3. `window.electron` 能力面

以下分组来自当前 preload；这里只列语义，不复制完整 TypeScript declaration。

| Namespace                     | 能力                                                                     |
| ----------------------------- | ------------------------------------------------------------------------ |
| `store`                       | 通用 KV get/set/remove；写 `app_config` 会触发配置同步                   |
| `multica`                     | 外部工具连接状态、注册启停、重新检测与 daemon 安全重启                   |
| `marketplace`                 | source、search、detail、install                                          |
| `skills`                      | Gateway skill list/enable 与用户 Skill import/delete                     |
| `extensions`                  | list/import/progress/delete/enable/configuration                         |
| `hooks`                       | list/import/delete/enable                                                |
| `slashCommands`               | 合并 Gateway 命令与本地 policy 后列出                                    |
| `mcp`                         | CRUD、enable、sync、probe、resource read、extension servers 与 sync 事件 |
| `permissions`                 | macOS Calendar check/request                                             |
| `browser`                     | mode/status、连接测试、remote debugging、扩展安装/配对诊断               |
| `api`                         | Main 受控 fetch 与 request cancellation                                  |
| `window`                      | 最小化/最大化/关闭/系统菜单与状态订阅                                    |
| 顶层 config                   | provider config read/check/save、title generation、recent cwd            |
| `openclaw.approvals`          | pending snapshot、resolve、requested/resolved events                     |
| `openclaw.engine`             | status/restart/port/token、prompt replacement、terminal、progress        |
| `openclaw.history`            | tool inputs、compaction detail、paged history                            |
| `openclaw.memory`             | overview/document/search/rebuild index                                   |
| `openclaw.usage`              | 7/14/30 日 token usage                                                   |
| `agents`                      | agent list                                                               |
| `cowork`                      | session/run/goal/config/model/interaction/subtask 与完整 stream          |
| `sessionGroup`                | group CRUD、移动 session、排序                                           |
| `dialog`                      | 选择/保存/读取用户明确选择的文件和目录                                   |
| `shell`                       | open/reveal/external、上下文菜单、受控文件预览与编辑 token               |
| `autoLaunch` / `preventSleep` | OS 级开机启动和阻止休眠                                                  |
| `developerConfig` / `appInfo` | 只读开发配置、版本与 locale                                              |
| `appUpdate`                   | 状态、检查、清理后安装、状态事件                                         |
| `builtinModels`               | 手工刷新和生命周期变更事件                                               |
| `log`                         | 路径、打开目录、导出 zip；debug 写入受 shared channel 控制               |
| `scheduledTasks`              | job CRUD/run/history/session resolve/channel 与本地 result inbox         |
| `networkStatus`               | online/offline 事件                                                      |

`ipcRenderer` 兼容分组只允许白名单 channel，不能演化为任意 `send/invoke` 后门。

### 3.1 Multica CLI 桥接进程

打包后的 JustDo 可执行文件同时实现 Multica 所需的 OpenClaw CLI 子集；开发模式则生成用户
私有的 launcher，通过 Node Electron CLI 启动当前源码入口并附加内部 bridge 标记。匹配到受
支持的 `--version`、`config`、`agents` 或 `agent --local --json` 参数时，辅助进程不申请
Electron 单实例锁或创建窗口，而是通过用户私有的 named pipe/Unix socket 连接已运行的 Main。
Main 校验随机令牌和命令白名单后，使用自身 OpenClaw 环境启动捆绑 runtime，并把 stdout、
stderr、退出码及取消信号传回辅助进程。

Relay 只接受 Multica 工作目录以及 `OPENCLAW_CONFIG_PATH`、`OPENCLAW_INCLUDE_ROOTS` 两个
环境覆盖。模型凭据、Gateway token、runtime 和 state directory 均由 Main 控制；JustDo 完全
退出时 CLI 快速失败，不会自动启动桌面应用。

## 4. Cowork IPC

### 4.1 命令与查询

主要调用包括：

- `cowork:session:start|continue|stop|delete|deleteBatch`；
- pin、rename、permission mode、model patch/get；
- session get/list、Gateway session id、remote-managed、单个/批量 runtime status；
- `cowork:session:run:begin|bind|list|fail` 管理 client turn 到 root run 的持久绑定；
- goal get/continue/resume/restart-for-feedback 与 context usage；
- message delete/deleteFrom；
- interaction respond/replay；
- config get/set、Agent runtime settings、default model；
- subtask status 与 subagent session lookup。

Start/continue handler 的 admission 次序是：校验输入 -> 等待排队的 config update -> ensure Gateway/config/permission ready -> 建立/绑定 run -> 调用 router。任何一步失败都要返回明确失败，而不是先让 Renderer进入 running。

### 4.2 Stream

Cowork stream 至少包含 message、messageUpdate、thinkingUpdate、metadataUpdate、messageDelete、interaction、interactionDismiss、complete、error、sessionsChanged、goal changed/execution changed。

Main 的 runtime forwarder 负责把 Gateway 语义映射为产品事件；Renderer 的 `JustDoChatWrapper` 再把它们送入 chat model。消息正文、thinking、tool 生命周期和 run terminal 必须保持不同事件含义，不能把任意 error event 当作 session terminal。

## 5. OpenClaw IPC

### 5.1 Engine

Engine status 是带 phase/message 等信息的快照，progress event 用于启动/停止/错误 UI。端口范围由 shared validator 限制在 1024..65535；49152..65535 会标记为临时端口范围并给出提示，但不会因此拒绝。setPort 还需探测占用、保存并安全重启。

Gateway token 属于敏感能力。Preload 当前提供受控读取，Renderer chat controller 会用它建立 loopback WebSocket，并在 paged-history IPC 不可用时请求本地认证 REST。任何扩展使用都必须避免日志、Redux、持久化和向第三方页面暴露。

### 5.2 History、Memory、Usage

- History handler 读取 Gateway state/session，并按 session 范围返回工具输入、compaction detail 和分页 history。
- Memory handler 通过 manager 定位受管 state，限制相对路径并返回结构化结果。
- Usage 通过 runtime 请求并 normalize 每日数据和 cache 状态，Renderer 不解析任意 Gateway payload。

### 5.3 Approvals

审批分 exec 与 plugin kind；decision 包含单次、session、always 和 deny 等受支持集合。Main 保存 pending snapshot，并验证某请求是否允许 session 级授权。Renderer modal 的关闭不能伪造授权。

## 6. Plugin IPC

- Skill list/enable 委托 Gateway API；文件 import/delete 由 `OpenClawSkillFileService` 处理 user source。
- MCP CRUD 先操作 store，再经 config sync；probe/resource read 使用 Gateway/SDK transport，而非 Renderer 网络。
- Hook 配置由 SQLite store 管理并同步；导入和删除要进入受管目录事务。
- Extension import 提供 progress event，enable/config/delete 经 extension service 与 config mutation exclusive path。
- Marketplace 返回统一 item/source/detail/install contract，实际安装仍分派到对应 plugin owner。

任何文件路径参数必须 canonicalize 并验证来源/目标；不能相信 UI 下拉框保证安全。

## 7. Scheduled Task IPC

Shared `IpcChannel` 定义 job list/get/create/update/delete/toggle/manual run、run list、session resolve、channel list，以及 status/run/refresh events。结果收件箱另外提供分页查询、单个/全部标记已读、删除、reconcile、result upsert 和 unread count event。

Gateway job/run 是执行权威；SQLite receipt 是应用内阅读状态。IPC 返回对象把 Gateway `ok` 归一为产品 `success`，同时保留 delivery status/error。删除 result 还可能触发 session/transcript artifact cleanup，必须由 Main 执行。

## 8. 文件与网络 IPC

### 8.1 文件

- Dialog API 代表用户显式选择；返回的路径仍需由每个 handler 验证用途。
- `localfile://` 是只读展示协议，不能作为通用目录服务器。
- preview read 解析相对 cwd；写入前由 `AuthorizeEdit` 生成绑定路径/内容约束的 token，写后/取消时撤销。
- `openPath`、`showItemInFolder`、`openExternal` 分开，避免把 URL 当本地路径或反向处理。

### 8.2 网络

Renderer 的 provider 检测使用 `api.fetch` 进入 Main，支持 request id 取消。Main 应限制 method/header/body/redirect/response size，并通过系统/custom/direct proxy 策略发起请求。Gateway 的出站 Header 注入通过独立 proxy environment 管理，不应复用通用 fetch IPC。

## 9. 注册与生命周期

Handler 在获得 single-instance lock 后统一注册。它们使用 getter 延迟取得 store/runtime，因此注册早于 `app.whenReady` 不意味着可提前调用。窗口只在核心初始化后创建，正常情况下 Renderer 不会撞上未初始化服务；handler 仍要在异常情况下返回清晰错误。

事件发送前必须检查 BrowserWindow/WebContents 未销毁。多窗口语义应明确：全局 engine/update/result 事件广播，窗口局部 UI 事件发送给拥有者；当前大部分实现面向单主窗口。

## 10. 输入验证与返回契约

跨 IPC 的最小规则：

- string：trim、长度上限、空值语义、枚举/ID pattern；
- number：finite、integer、范围；
- path：resolve/canonicalize、允许根、符号链接/遍历、文件类型和大小；
- URL：协议、loopback/remote 限制、credential 与 redirect；
- record/array：拒绝非对象、限制项数和嵌套大小；
- config：先 normalize，再持久化，再 sync/verify；失败不提交半状态；
- event：只发送可序列化最小字段，不携带 secret 或原始异常对象。

## 11. 新增 IPC 检查单

1. 在 `src/shared/` 定义 channel 常量、request/result 和运行时 normalize（如需要）。
2. 在 owning `src/main/ipc/<domain>/` 注册 handler，调用领域 service。
3. 验证所有 renderer-controlled 输入并设计稳定错误码。
4. 在 preload 暴露最小语义方法；订阅必须返回 unsubscribe。
5. 更新 `src/renderer/types/electron.d.ts`，保持签名完全一致。
6. 补 handler/normalize/consumer 测试，覆盖失败、重复、乱序、销毁和取消。
7. 更新本文件或对应领域文档。

## 12. 常见反模式

- 暴露 `ipcRenderer.invoke(channel, ...args)` 给 Renderer。
- 仅靠 TypeScript interface 当运行时验证。
- 在 React 组件直接拼 channel 名或解析 Gateway wire payload。
- 订阅未清理，session 切换后继续接收旧事件。
- 用 transient disconnect 生成业务 terminal。
- 把 token、API key 或完整 config 作为调试事件发送。
- handler 同时做验证、数据库事务、Gateway orchestration 和 UI 文案，导致不可测试。

## 13. 相关文档

- [系统架构](02-architecture.md)
- [Cowork 系统](04-cowork-system.md)
- [安全模型](11-security-model.md)
- [Chat 渲染](15-chat-rendering.md)

## 14. 调用生命周期与销毁语义

一次 `invoke` 的生命周期是 Renderer promise → preload 参数转发 → Main handler validation/service → structured result。窗口关闭不会自动取消已经进入 Main 的文件、网络或 Gateway 操作；需要取消的长任务必须使用 request id/AbortController 或领域 cancellation，且 handler 终态只能结算一次。

事件订阅必须保存 preload 创建的包装 listener，并在 unsubscribe 时用同一引用移除。React effect 重建、session 切换和窗口 reload 都可能重复订阅；consumer 不能依赖 Main “只广播一次”来抵消 listener 泄漏。

## 15. IPC 风险分级

| 等级            | 示例                                      | 最低控制                                            |
| --------------- | ----------------------------------------- | --------------------------------------------------- |
| 只读产品查询    | list session、get theme                   | 类型、limit、稳定错误                               |
| 本地状态写入    | rename/pin/group/read receipt             | 字段验证、SQLite 事务/幂等、失败回滚                |
| Runtime 命令    | send/stop/restart/run cron                | readiness、session/run identity、single-flight      |
| 文件/命令/网络  | preview edit、shell、fetch、plugin import | canonical path、allowlist、size/timeout、审批       |
| Credential/权限 | token、provider config、approval          | 最小返回、脱敏日志、owner/session 绑定、fail closed |

风险越高，越不能用通用 `store:set`、`api.fetch` 或任意 channel 代替专用领域接口。

## 16. 测试证据与排障

- Handler 注册测试应证明注册期间不会读取尚未初始化的 store，例如 Cowork session handler 的启动约束。
- Shared contract tests覆盖枚举、limit、normalization；Main handler tests覆盖恶意/边界输入；preload/consumer tests覆盖调用参数和 unsubscribe。
- 事件串线先检查 channel、session/run domain 和 listener 数量；调用悬挂检查 handler 是否等待 readiness/timeout；“空成功”检查 catch 是否吞掉 Gateway 未 ready。
- 新 namespace 应在 `preload.ts` 与 `electron.d.ts` 做结构对照审查；目前没有自动生成，两处漂移是显式风险。

## 17. IPC Definition of Done

新增接口完成时必须有稳定 channel 常量、运行时输入验证、明确 result/error contract、最小 preload 方法、Renderer declaration、销毁/取消语义和至少一个失败测试。涉及 Gateway 的接口还要定义 starting/disconnected/reconnecting 时行为；涉及写入的接口要定义重复调用和部分失败。

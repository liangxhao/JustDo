# 通用 app-server：连接、能力与生命周期

桌面原生客户端 WebSocket、Chrome 侧栏聊天与 CLI 的
`app-server --listen stdio://` 共用 `src/main/appServer/` 中的协议引擎。
本页维护共享协议和连接边界；命令行与 ACP 的使用、执行和资源管理见
[CLI / ACP](agent-cli.md)，逐字段规范见 [app-server API](../../app-server-api/README.md)。

## 1. 一个协议引擎，三种连接入口

每条认证连接拥有一个 `AppServerConnection`。各入口采用相同 Codex 协议策略，统一处理请求解析、ID、初始化、方法路由、
响应/错误、通知过滤和断连后的输出撤销。两种 WebSocket 监听器还共用
`AppServerWebSocketServer`，各入口不另建 RPC 分发器。

```mermaid
flowchart LR
  Chrome[Chrome 侧栏] --> Discovery[Native Messaging 发现]
  Discovery --> BrowserWS[扩展专用 loopback WebSocket]
  Native[原生客户端] --> NativeWS[Bearer 认证 WebSocket]
  BrowserWS --> Transport[共用 WebSocket 传输]
  NativeWS --> Transport
  CLI[CLI app-server 命令] --> Pipe[认证本地桥 / stdio]
  Transport --> Protocol[AppServerConnection]
  Pipe --> Protocol
  Protocol --> Browser[浏览器会话能力绑定]
  Protocol --> External[外部线程能力绑定]
  Browser --> Product[产品会话服务 / 运行时适配器]
  External --> Product
  Product --> Gateway[Gateway：执行与原生历史]
```

Main 在创建连接时传入类型化能力绑定。客户端名称、请求的 capabilities 或通知偏好不能增加
操作权限；绑定中没有的方法返回 method-not-found，不回退到其他入口的后端。

`src/main/appServer/` 只包含标准协议、通用输入与审批呈现、投影、分页和传输，不定义或导入浏览器方法、
通知、网页关联错误策略，也不包含浏览器集成测试。浏览器专属常量和安全错误映射归
`src/main/browser/extension/browserAppServerProtocol.ts`，由同域 binding 通过通用
`extensions` 精确注册。扩展一律需要请求 ID，不能覆盖标准方法；握手声明不能注册方法。
依赖方向是浏览器适配器引用通用层，通用层不反向依赖浏览器模块。
结构回归检查同时约束核心声明、测试和生产运行时的传递依赖。

| 能力                                | Chrome 扩展连接                                        | stdio / 原生客户端 WebSocket                 |
| ----------------------------------- | ------------------------------------------------------ | -------------------------------------------- |
| 连接范围                            | 扩展创建的会话                                         | 每连接最多绑定 32 个外部线程                 |
| 创建与继续                          | 扩展会话                                               | 新建或明确恢复外部线程                       |
| 列表、历史、图片与输入选项          | 扩展会话内提供                                         | 元数据与原生 Turn/Item 历史分页              |
| 模型发现                            | `model/list`；另有 `browser/composer/options` 当前选项 | `model/list`                                 |
| 文本与取消                          | 支持                                                   | 支持                                         |
| 标准图片                            | data URL 图片及纯图片；按真实模型视觉模态校验          | data URL、cwd 内 localImage、受限私网 IP URL |
| 客户端审批                          | 发送 peer 的原生命令／插件审批，侧栏显示               | 同一双向 RPC，由客户端实现界面或交互         |
| 其他附件、页面上下文、每轮模型/权限 | 仍由浏览器领域校验                                     | 每轮模型选择；不开放浏览器附加字段           |
| 进度                                | 标准 Item 通知；另有 `browser/thread/stream` 与富快照  | 标准 Item、正文与 reasoning 通知             |
| 自动化配对                          | 浏览器专用认证操作                                     | 不提供                                       |

浏览器领域按 `source: browser-extension` 校验列表、读取、订阅、媒体、输入选项、发送和停止。
传入桌面或 CLI 会话 ID 不会获得访问权；桌面仍可查看和继续扩展会话，无需改写历史来源。

两类绑定提供领域能力并将领域错误映射为明确可公开的 RPC 错误；不解析 RPC 包或编码响应。
公共引擎统一封装响应与错误：

- 两类绑定共用 `appServerWire`、`appServerPagination`、`appServerHistory`、
  `appServerHistoryReader`、`appServerProgress`、`appServerToolProgress`、
  `appServerInput` 与 `appServerApprovals`。
- 浏览器绑定另提供 `thread.browser.display`、`browser.activeTurn`、共享原生流订阅和终态核对。
- 外部绑定保留不透明线程映射、cwd/模型校验、可选身份标记和执行预留。

标准 `thread/read` 仅查询，不再隐式订阅；`thread/resume` 明确加载并观察。
浏览器富显示分组只含 id/items，不冒充已完成的标准 Turn；普通产品计时行缺少
精确原生证据时，标准历史继续标为结果未知。浏览器特有输入统一位于 `params.browser`，
特有方法和通知使用 `browser/` 前缀，不再覆盖核心 Thread／Turn／Item 外形。

## 2. 初始化、请求与输出顺序

| 行为         | Chrome                                              | stdio / 原生客户端     |
| ------------ | --------------------------------------------------- | ---------------------- |
| 初始化       | 校验客户端字段；响应后需 `initialized` 通知         | 同左                   |
| 客户端通知   | 忽略可能产生工作的通知                              | 同左                   |
| 开始执行     | 标准 turn/item 通知在响应后；增强原生流可能早于 ACK | start 响应先于延后执行 |
| 通知退出订阅 | 按完整方法名精确匹配                                | 同左                   |

请求处理只等待操作准入，不阻塞到执行完成；尚未返回的 start 不能阻塞 interrupt。
错误分类由共用引擎维护，各入口采用相同非法请求、参数、未实现方法和业务错误码。
`turn/start.error.data.requestSent` 只透传明确的布尔证据，不从错误码推断原生准入；
Chrome 在实际调用发送前的拒绝明确为 false。连接关闭后不再发布旧输出。
初始化校验失败不会锁死握手。
创建／改名通知在对应响应后发送，通知输出失败会同步撤销共享连接与 binding，阻止新任务准入。

共享连接支持双向 RPC：服务端请求使用连接内唯一字符串 ID，最多 64 个待回复项。
客户端 response 与普通 request 分向匹配，迟到、重复、其他连接的回复不能解决原请求。
close 在等待执行清理前同步撤销所有 pending request，避免审批与断连互相等待。
精确 run 的审批由领域资源管理器和原生 approval owner 管理；
命令支持 accept/decline/cancel；实验性握手且有安全授权范围时，明确提供 acceptForSession，
仅按精确指纹逐次原生 allow-once。永久命令规则和策略修订仍不支持。
插件确认仅在成功握手声明 experimentalApi 后使用标准 user-input 请求。
Chrome 侧栏通过同一服务端请求呈现原生命令和插件审批，只有实际发送 peer 的
trusted hooks 能建立本轮 owner，观察者不继承。ACK 前的请求暂扣，ACK 确认 actual run 后才呈现；
断线只撤回交互，未结算 owner 继续拒绝后续请求，不回退到桌面替用户批准。
会话命令授权按精确环境指纹逐次原生 allow-once；原生明确提供的持久 App action 另行映射，
不冒充持久命令规则或文件变更审批。

### 输入处理与模型能力

标准文本与图片统一经 `appServerInput` 处理。图片使用真实字节校验并转换为规范内容及原生附件，
支持图文和纯图片，不生成占位提示词。原生输入会合并文本并保持图片相对顺序，实时用户 Item
采用相同的归一化形状，不承诺保留原始文本／图片交错排版。模型图片能力来自真实目录，未知时
仅声明文本；浏览器在改变模型、权限或原生准备前拒绝不支持的图片发送。

本机客户端可使用 cwd 范围内的 `localImage`，或明确允许的私网 IP HTTP(S) 图片地址；
浏览器标准图片只接收 data URL，文档附件仍由浏览器独立字段提供。通用文本上限为 2 MiB UTF-8，
浏览器另保留 32,000 个 UTF-16 code units 的文本上限；图片数量、大小及路径／网络规则以
[外部输入规范](../../app-server-api/external-clients.md#turnstart)和[浏览器输入规范](../browser/extension-protocol/app-server.md)为准。
音频、fileId 和未支持的图片 detail 覆盖会明确拒绝。

外部文本／图文沿原生 `agent` 的 SID／revision 原子准入。纯图片改用可接收空文本的原生
`chat.send`，它没有 revision CAS；宿主前后核对身份、连接代次与精确 ACK，未知提交保留预留。
浏览器沿其既有 prepared `chat.send` 路径执行，不借协议统一宣称新增原生原子保证。
历史仍从认证 Gateway 按请求投影，图片引用不赋予读取任意宿主文件的权限。

## 3. 断连、重启与执行结算

### Chrome：撤回观察，不取消已接纳工作

面板断连只释放本面板的订阅。已接纳或结果未知的工作可以继续，重连后按原身份核对，不能重放。
浏览器服务器重启时暂停观察、撤销在途轮询续体，随后只恢复一次；完整 stop 则推进 hub generation。
旧代次的 start/read/interrupt 即使迟到，也不能重建订阅、轮询或输出。

观察者退役不改变已接纳执行的产品/原生身份。服务再次启动也不能接纳旧代次的输出。

浏览器已加载集合包含当前订阅和仍在准入／观测的线程。逐轮观测使用精确 thread/turn 组合，
新运行不覆盖旧运行尚未送达的完成通知；旧运行的 idle 也不能覆盖新的当前运行。
标准状态与关闭通知沿公共 wire 输出，但只在全局已卸载时通知实际退订连接；
后台观测结束不保留并追发给旧观察者，断连仍不取消原生工作。

### 外部线程：取消精确运行，等待所属资源清理

stdio EOF、原生客户端 WebSocket 断连或服务关闭，都会请求取消本连接拥有的 active/unknown
执行，并等待清理。异常断连或输出失败保留 stream-error 原因，不能报告为成功或正常取消。
关闭一条连接不能取消另一条连接的工作。

`thread/unsubscribe` 只撤回观察；各线程拥有独立执行控制器，unknown 只阻塞对应线程。
共享 hub 只保存当前订阅，不保存正文或重放事件。观察者输出故障只退役该连接；
拥有者断连后，精确结算得到的 terminal 可送给仍在订阅的其他客户端，旧连接不再输出。
观察者不能通过 interrupt 停止借用的运行，也不会取得审批展示权。

历史读取前后核对产品映射、原生 key/SID/lifecycleRevision、运行回执与 Gateway 代次。
仅复用当前认证连接，不启动 Gateway，不读取 transcript 文件或解析其他别名。
原生快照按请求投影并以内容和身份 revision 绑定分页；变更后旧游标失效。

应用退出最多等待该 drain 五秒，之后继续既有 Gateway 关闭流程；原 drain 仍被观察。
这个期限只约束退出等待，不把执行标为已完成或已取消。

### 共同约束

两类绑定均核对原生会话身份、incarnation、连接代次，以及整轮终态或精确原生 wait 回执。
chat final、idle、历史正文和 Stop ACK 都不能结算执行。未知提交保留原身份与预留，重连不重发。

## 4. 原生客户端 WebSocket 的接入

### 地址与凭据

该监听器随桌面应用启动，没有启用开关。它绑定 `127.0.0.1` 和固定 `/app-server` 路径，
端口默认自动分配，也可在设置页指定固定端口。HTTP Upgrade 必须提供独立随机 32 字节
Bearer token；令牌首次生成后持久保存，正常重启保持有效。该入口允许不带 `Origin` 的原生客户端；
浏览器使用自己的扩展入口。客户端名称或扩展凭据不能改变能力绑定。

每连接通过 `AgentCommandService.connectAppServer` 使用与 stdio 相同的
`CliAppServerBinding`、外部会话命名空间、预留和 `Clients` 来源分组。WebSocket 不读取客户端
`CODEX_HOME` 或环境变量。认证时捕获应用配置的默认工作目录；`thread/start.cwd` 可以明确覆盖，
resume 未传 cwd 时保留已存目录。

### 设置页与复制配置

“设置 → 外部连接 → 应用接入”提供 CLI/ACP 入口，并将 app-server 的 stdio 与 WebSocket
作为并列面板；Multica 示例归 stdio 面板。WebSocket 默认显示当前连接地址和复制当前配置，
“连接设置”按需展开。监听端口的标签、自动/固定选择和固定端口输入位于同一行；自动模式在
提交时映射为 `0`，界面不要求用户填写 `0`，固定端口范围为 `1..65535`。
仅有草稿变更时显示保存/取消，固定端口错误在失焦或保存时提示；取消恢复已保存设置。
折叠、刷新状态或重新生成令牌不会丢弃端口草稿；折叠后仍显示未保存标记。
令牌状态与“重新生成”位于展开区域，不读取或展示真实令牌。状态 IPC 返回
`{running, url, configuredPort, restartRequired, failure?}`，没有凭据，
也不能启动监听器或 Gateway。用户复制连接配置时，独立的主应用 main-frame-only IPC 才返回：

```json
{
  "url": "ws://127.0.0.1:<current-port>/app-server",
  "headers": { "Authorization": "Bearer <current-token>" }
}
```

这是连接信息示例，不是新增 RPC 或特定客户端的官方配置格式。凭据不在界面显示、
不写日志，也不进入 CLI status。Main 将端口和令牌保存在
`<userData>/app-server/connection.json`，采用受限目录/文件权限和原子替换，
不经过通用 KV/`app_config`；损坏或不可读配置不会被当作未设置而自动更换令牌。

保存端口和重新生成令牌只更新下次启动配置，不重启当前 listener、不撤销当前握手凭据，
也不取消已有执行。`restartRequired` 比较已保存配置与当前 listener 捕获的端口/令牌快照；
复制始终返回当前 listener 有效的 URL 和 token，不能混合待生效令牌与当前地址。
待重启提示和服务启动故障始终显示在折叠区域之外；成功保存后的待重启提示不与重复成功文案叠加。
固定端口保存后正常重启可继续使用原客户端配置；修改端口或重新生成令牌后，
重启应用再复制新配置。自动分配模式下重启可能换端口，仍需重新复制。
固定端口被占用时返回 `failure: 'port-in-use'`，不静默回退随机端口；
其他监听启动失败使用安全的 `unavailable` 状态。用户可修改端口后重启应用。

服务关闭先撤销发现与新握手，再等待资源清理；尚未完成的 listen 不能重新发布旧实例。
私有连接设置不是客户端自动发现文件。CLI 仍只接受 `--listen stdio://`，WebSocket 属于正在运行的桌面应用，
不由 CLI 启动另一套运行时。

## 5. 传输容量与其他协议的边界

| 限制             | 共用输入      | 原生客户端输出 | Chrome 输出 |
| ---------------- | ------------- | -------------- | ----------- |
| 单帧             | 8 MiB         | 8 MiB          | 32 MiB      |
| 每连接待处理     | 64 帧 / 8 MiB | 16 MiB         | 64 MiB      |
| WebSocket 连接数 | 32            | —              | —           |

Chrome 较大的输出上限用于保留既有 20 MiB 图片读取及 Base64 开销。
已断连 socket 的 close drain 继续登记，服务不能在所属执行尚未清理时提前完成关闭。
普通 pending RPC 到返回前仍占连接容量，但不阻止 Chrome 重启；其迟到结果受 hub generation 限制。

扩展 WebSocket 继续要求 loopback、固定扩展 Origin、精确路径、随机 capability 和有界帧。
Native Messaging 只发现已经运行的应用。CLI 本地桥保留自己的认证 pipe/socket、帧和背压规则。
共享协议不会共享凭据，也不会把浏览器能力开放给 CLI。

ACP 与普通 CLI 是独立的协议/命令适配器，复用外部执行后端；浏览器自动化 relay、Gateway
凭据、原生历史、权限和应用生命周期不因 app-server 共用引擎而改变。

## 6. 规范与支持范围

- [外部客户端规范](../../app-server-api/external-clients.md)：stdio 与原生 WebSocket 字段。
- [官方兼容性对照](../../app-server-api/compatibility.md)：校验基线、已实现接口和剩余宿主边界。
- [Chrome 规范](../browser/extension-protocol/README.md)：浏览器专属字段和通知。
- [Chrome 侧栏](../browser/browser-extension-side-chat.md)：用户流程和产品集成。
- [上游协议参考](https://learn.chatgpt.com/docs/app-server#protocol)：本产品仅实现上述明确子集。

Chrome 专属方法和事件作为显式扩展维护，不宣称是标准 API。真实客户端与安装包的验收范围随
[CLI / ACP](agent-cli.md#验证范围与发布验收)及浏览器功能文档维护。

# Codex app-server 兼容性与验证边界

本产品复用 app-server 消息形状，执行、配置与历史仍由桌面宿主和原生运行时拥有。
本文区分已实现的通用客户端接口、Chrome 专用扩展及尚未实现的官方能力。

## 对照依据

官方入口为 [Codex App Server](https://learn.chatgpt.com/docs/app-server)。
字段校验采用官方 CLI 按版本导出的稳定 JSON Schema，不能将另一源码快照的
TypeScript 可空字段直接视为当前 JSON 的必填字段。

2026-11-05 的对照基线为本机 `codex-cli 0.166.0-alpha.5.1`，导出命令：

```powershell
codex app-server generate-json-schema --out build/test-dependencies/app-server-official-schema
```

该命令只生成定义，不启动模型任务。产物放在忽略的 `build/`，不作为应用运行时依赖。
这是一份具体版本的开发验证记录，不承诺后续官方版本的所有新增接口自动可用。

## 已实现的兼容接口

| 能力 | 当前通用 stdio／本机 WebSocket 行为 |
| --- | --- |
| 消息封装 | 一请求一响应、按 ID 匹配，wire 省略 `jsonrpc`，精确通知退出订阅 |
| 初始化 | 校验 `clientInfo`／能力类型，响应包含真实宿主目录与官方平台名称，随后必须 `initialized` |
| 参数及错误 | 安全整数／字符串 ID；非法请求、无效参数、未知方法分开报告，错误初始化可在原连接修正 |
| 模型 | `model/list` 分页；补齐说明、隐藏状态、文本能力及合法的 reasoning 默认字段 |
| 线程 | `thread/start`／`thread/resume` 返回必需 Thread 字段与配置，恢复默认包含真实历史，可显式排除 |
| 列表与读取 | `thread/list` 按当前 profile 的有效外部映射分页筛选；`thread/read` 默认元数据，可显式含历史 |
| 历史分页 | `thread/turns/list`／`thread/items/list`，双向分页、内容视图与 Item 锚点，游标绑定身份及快照 |
| 加载列表 | `thread/loaded/list` 查询宿主实际管理的 app-server 连接所绑定的线程 |
| 改名 | `thread/name/set` 校验、真实持久化标题，响应后发 `thread/name/updated` |
| 线程事件 | 新建后 `thread/started`；执行状态通过 `thread/status/changed` 投影 |
| 多线程与订阅 | 每连接最多绑定 32 个线程，可并发不同线程；`thread/unsubscribe` 独立退订，跨客户端共享实时通知 |
| Turn | `turn/start`、`turn/interrupt`；所有 Turn 载体含 `items`，未加载内容显式 `itemsView: notLoaded` |
| Item | 正文、reasoning、用户输入和工具生命周期含所需时间戳；正文按真实消息身份增量投影 |
| 工具结果 | 保留名称／参数、真实内容与结构化结果、原生错误摘要；明确隐藏的工具不对外输出 |
| 逐轮模型 | `turn/start.model` 校验当前模型目录，并经原生后端实际应用 |
| 双向 RPC 与审批 | 唯一服务端请求 ID；命令一次性 accept/decline/cancel；实验开关下的插件单题确认 |

`thread/started` 和改名通知在对应响应后发布。通知输出失败会同时退役共享协议连接与
所属能力 binding，撤销后续任务和元数据修改准入；不会继续执行而静默丢弃结果。

列表、默认读取和改名只使用元数据，不启动 Gateway、不写客户端标记文件，也不取得被查询
会话的执行所有权。开始／恢复线程和执行仍按既有外部 UUID、助手、工作目录、原生身份、
执行预约与 unknown 规则校验。

## 有意保留的宿主边界

- **历史保持原生权威。** 读取要求已有认证 Gateway；前后核对精确原生身份、连接代次、
  产品绑定及运行回执。正文仅按请求投影，不读取 transcript 文件或建立正文缓存。
  无精确运行关联的旧消息仍保留为只读历史段，状态标记 `EXECUTION_UNKNOWN:`；
  不依据 final/工具完成/时间接近猜测结算。未支持的可见消息类型明确报错，不静默丢弃。
- **执行与观察分开。** 每线程拥有独立控制器；退订不取消，关闭连接仍取消它拥有的运行。
  跨连接只共享后续事件，不重放错过通知、不转移执行或审批所有权。
- **权限由宿主管理。** `externalSandbox` 不代替文件、工具、网络和审批规则。
  装有交互审批资源时报告 `approvalPolicy: on-request`，否则为 `never`；
  只允许原生支持的一次性选择。文件变更、持久许可和策略修订不伪造实现。
- **模型目录不虚构能力。** 仅广告此入口当前支持的文本输入。`defaultReasoningEffort: default`
  表示桌面管理的原生默认值；不宣称禁用 reasoning，也不支持逐轮 effort 覆盖。
- **来源不改写。** CLI、ACP 和 app-server 的持久映射继续共用 `source: cli`。
  元数据 `sessionId` 使用外部身份，不暴露原生 SID、key、凭据或历史文件路径。
- **退出仍清理所属执行。** stdio EOF、WebSocket 关闭仍请求精确取消并等待资源清理，
  与官方可分离订阅的持久多线程宿主存在区别。ACK、正文结束、断线和 idle 均不证明原生结算。
- **未知结果不重发。** `failed` 加 `EXECUTION_UNKNOWN:` 保留既有未知占用，不能将其
  解释为原生已失败、已停止或可以重新提交。错误对象不伪造官方错误原因分类。

## 尚未实现的官方能力

以下能力没有对应的完整宿主适配器；调用会明确失败，不以空结果或成功 ACK 冒充完成：

| 能力范围 | 当前缺口 |
| --- | --- |
| 线程变更 | fork、archive／unarchive、delete、compact、revert、历史注入、线程分组／附件 |
| 富输入和进行中操作 | 图片／音频／技能对象／独立工具输出、steer、review、临时线程、父子 Turn 调度 |
| 客户端审批和工具 | 文件变更／持久授权／通用 elicitation、动态工具、客户端 MCP 管理、按轮禁用插件 |
| 进程和文件 | `command/exec`、`process/*`、后台终端、`fs/*`、直接 shell 执行 |
| 账户与配置 | 官方 OpenAI 账户／配额／认证、配置修改、官方应用目录、模型供应商能力管理 |

这些方法涉及新的权限、会话生命周期或原生历史映射，不应通过伪造 Codex 目录／日志、
绕过宿主权限或新增 transcript 缓存来凑齐。`experimentalApi` 声明也不会开启未实现能力。

## Chrome 的独立扩展

Chrome 使用自己的 capability／Origin 鉴权和浏览器来源范围。`composer/options`、
`thread/image`、`thread/stream`、`executionSettled` 与 `requestSent` 均为明确的产品扩展，
不是官方通用客户端 API。本次通用接口补齐不改变其握手、错误码、历史投影或断连退订语义。

## 已验证与未验证

验证覆盖共享协议与真实 WebSocket／本机桥 framing、有效 SQLite 元数据和改名持久化、
Chrome 能力隔离、精确取消和 unknown 占用、分页稳定性、隐藏工具／正文 guard、输出失败退役。
新增覆盖多线程并发、跨客户端订阅、审批回传后原生复核，以及历史取消后不再分页／写缓存。
真实响应 helper 已使用上述官方导出 JSON Schema 校验初始化、模型、线程、Turn／Item 分页、
退订／状态通知与两种服务端审批请求。Python 的真实本机 WebSocket 测试覆盖 11 个场景，
使用替身执行后端，不表示这些场景已通过正在运行的桌面 Main。

2026-11-06 在用户重启的开发应用完成真实 Gateway／模型联调：Python 示例完成一轮，
同连接两个线程再各完成一轮；验证历史读取／分页／恢复、跨客户端通知、改名、退订、
忙碌拒绝、其他客户端不能停止运行，以及错误 Bearer／网页 Origin 拒绝。
联调发现桌面状态查询生成外部恢复记录，以及用户消息缺少执行关联，已补只读记账边界和
原生完整输入标识关联。新历史投影直接使用同一认证 Gateway 的真实快照单独验证；
状态查询修复以定向测试验证；修复已编译，当前桌面进程须重启才会加载。
完整官方客户端的账户／审批／文件界面、真实客户端审批往返与最终安装包端到端验收
仍未覆盖；定向测试和文本模型联调不能替代这些验收。
